//! Port of `src/server/stats/promptDispatchRepository.ts`, with its helpers,
//! migration and types in the submodules, as in the TypeScript folder.
//!
//! Every outbound prompt payload is stored (already redacted) with token, cost
//! and risk metadata. Table and columns match the TypeScript side, so both can
//! share `.local/stats.db`. The process-wide singleton is not ported.

pub mod helpers;
pub mod migration;
pub mod types;

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Mutex, MutexGuard};

use rusqlite::types::Value as SqlValue;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};

use self::helpers::{build_where, row_to_entry, to_positive_int};
pub use self::types::*;
use super::util::{iso_from_ms, now_iso, now_ms, short_uuid};
use super::StatsError;
use crate::db::OpenOptions;

/// Retention runs at most once a minute, from the write path.
const PRUNE_INTERVAL_MS: i64 = 60_000;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// `PROMPT_LOG_RETENTION_DAYS` (30) and `PROMPT_LOG_MAX_ENTRIES` (10000), read
/// from the environment like the TypeScript does on every prune.
fn prune_limits_from_env() -> (i64, i64) {
    let retention = to_positive_int(
        std::env::var("PROMPT_LOG_RETENTION_DAYS").ok().as_deref(),
        30,
    );
    let max_entries = to_positive_int(
        std::env::var("PROMPT_LOG_MAX_ENTRIES").ok().as_deref(),
        10_000,
    );
    (retention, max_entries)
}

pub struct PromptDispatchRepository {
    connection: Mutex<Connection>,
    last_prune_ms: AtomicI64,
}

impl PromptDispatchRepository {
    pub fn open(db_path: &str) -> Result<Self, StatsError> {
        let connection = crate::db::open(OpenOptions::new(db_path))?;
        migration::migrate(&connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
            last_prune_ms: AtomicI64::new(0),
        })
    }

    pub fn in_memory() -> Result<Self, StatsError> {
        Self::open(":memory:")
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        self.connection
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// `recordDispatch`: inserts the row, then runs the throttled retention pass.
    pub fn record_dispatch(
        &self,
        input: RecordPromptDispatchInput,
    ) -> Result<PromptDispatchEntry, StatsError> {
        let id = format!("pdl-{}-{}", now_ms(), short_uuid());
        let created_at = input
            .created_at
            .clone()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(now_iso);
        let risk_reasons_json = serde_json::to_string(&input.risk_reasons)?;
        let tool_calls_json = input
            .tool_calls_json
            .clone()
            .unwrap_or_else(|| "[]".to_string());
        {
            let connection = self.lock();
            connection.execute(
                "INSERT INTO prompt_dispatch_logs (
                    id, provider_id, model_name, account_id, dispatch_kind,
                    prompt_tokens, prompt_tokens_source, completion_tokens, total_tokens,
                    status, error_message, risk_level, risk_score, risk_reasons_json,
                    prompt_preview, prompt_payload_json, prompt_cost_usd, completion_cost_usd,
                    total_cost_usd, conversation_id, turn_seq, latency_ms, tool_calls_json,
                    memory_context_json, created_at
                ) VALUES (
                    ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?
                )",
                params![
                    id,
                    input.provider_id,
                    input.model_name,
                    input.account_id,
                    input.dispatch_kind.as_str(),
                    input.prompt_tokens,
                    input.prompt_tokens_source.as_str(),
                    input.completion_tokens,
                    input.total_tokens,
                    input.status.as_str(),
                    input.error_message,
                    input.risk_level.as_str(),
                    input.risk_score,
                    risk_reasons_json,
                    input.prompt_preview,
                    input.prompt_payload_json,
                    input.prompt_cost_usd,
                    input.completion_cost_usd,
                    input.total_cost_usd,
                    input.conversation_id,
                    input.turn_seq,
                    input.latency_ms,
                    tool_calls_json,
                    input.memory_context_json,
                    created_at,
                ],
            )?;
        }
        self.maybe_prune(now_ms());

        Ok(PromptDispatchEntry {
            id,
            provider_id: input.provider_id,
            model_name: input.model_name,
            account_id: input.account_id,
            dispatch_kind: input.dispatch_kind,
            prompt_tokens: input.prompt_tokens,
            prompt_tokens_source: input.prompt_tokens_source,
            completion_tokens: input.completion_tokens,
            total_tokens: input.total_tokens,
            status: input.status,
            error_message: input.error_message,
            risk_level: input.risk_level,
            risk_score: input.risk_score,
            risk_reasons: input.risk_reasons,
            prompt_preview: input.prompt_preview,
            prompt_payload_json: input.prompt_payload_json,
            prompt_cost_usd: input.prompt_cost_usd,
            completion_cost_usd: input.completion_cost_usd,
            total_cost_usd: input.total_cost_usd,
            created_at,
            conversation_id: input.conversation_id,
            turn_seq: input.turn_seq,
            latency_ms: input.latency_ms,
            tool_calls_json,
            memory_context_json: input.memory_context_json,
        })
    }

    /// `listConversationSummaries`: the 100 most recent conversations.
    pub fn list_conversation_summaries(
        &self,
    ) -> Result<Vec<PromptDispatchConversationSummary>, StatsError> {
        let connection = self.lock();
        let mut statement = connection.prepare(
            "SELECT
               conversation_id,
               COUNT(*) AS turn_count,
               COALESCE(SUM(total_tokens), 0) AS total_tokens,
               COALESCE(SUM(total_cost_usd), 0.0) AS total_cost_usd,
               MAX(created_at) AS last_activity,
               (
                 SELECT model_name FROM prompt_dispatch_logs p2
                 WHERE p2.conversation_id = p.conversation_id
                 ORDER BY created_at DESC LIMIT 1
               ) AS model_name
             FROM prompt_dispatch_logs p
             WHERE conversation_id IS NOT NULL
             GROUP BY conversation_id
             ORDER BY last_activity DESC
             LIMIT 100",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(PromptDispatchConversationSummary {
                conversation_id: row.get("conversation_id")?,
                turn_count: row.get("turn_count")?,
                total_tokens: row.get("total_tokens")?,
                total_cost_usd: row.get("total_cost_usd")?,
                last_activity: row.get("last_activity")?,
                model_name: row
                    .get::<_, Option<String>>("model_name")?
                    .unwrap_or_default(),
            })
        })?;
        let summaries: Vec<PromptDispatchConversationSummary> = rows.collect::<Result<_, _>>()?;
        Ok(summaries)
    }

    /// `listDispatches`: newest first, or by turn inside a conversation.
    pub fn list_dispatches(
        &self,
        filter: &PromptDispatchFilter,
    ) -> Result<Vec<PromptDispatchEntry>, StatsError> {
        let (where_clause, mut params) = build_where(filter);
        let order = if filter
            .conversation_id
            .as_deref()
            .is_some_and(|id| !id.is_empty())
        {
            "ORDER BY turn_seq DESC, created_at DESC"
        } else {
            "ORDER BY created_at DESC"
        };
        params.push(SqlValue::Integer(filter.limit.unwrap_or(100)));
        let sql = format!("SELECT * FROM prompt_dispatch_logs {where_clause} {order} LIMIT ?");

        let connection = self.lock();
        let mut statement = connection.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(params), row_to_entry)?;
        let entries: Vec<PromptDispatchEntry> = rows.collect::<Result<_, _>>()?;
        Ok(entries)
    }

    pub fn count_dispatches(&self, filter: &PromptDispatchFilter) -> Result<i64, StatsError> {
        let (where_clause, params) = build_where(filter);
        let sql = format!("SELECT COUNT(*) AS cnt FROM prompt_dispatch_logs {where_clause}");
        let connection = self.lock();
        let count = connection.query_row(&sql, params_from_iter(params), |row| row.get(0))?;
        Ok(count)
    }

    /// `getSummary`: totals, flagged count, exact versus estimated token sources.
    pub fn get_summary(
        &self,
        filter: &PromptDispatchFilter,
    ) -> Result<PromptDispatchSummary, StatsError> {
        let (where_clause, params) = build_where(filter);
        let sql = format!(
            "SELECT
               COUNT(*) AS total_entries,
               COALESCE(SUM(CASE WHEN risk_level != 'low' THEN 1 ELSE 0 END), 0) AS flagged_entries,
               COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens_total,
               COALESCE(SUM(CASE WHEN prompt_tokens_source = 'exact' THEN 1 ELSE 0 END), 0) AS exact_count,
               COALESCE(SUM(CASE WHEN prompt_tokens_source = 'estimated' THEN 1 ELSE 0 END), 0) AS estimated_count,
               COALESCE(SUM(total_cost_usd), 0) AS total_cost_usd
             FROM prompt_dispatch_logs {where_clause}"
        );
        let connection = self.lock();
        connection
            .query_row(&sql, params_from_iter(params), |row| {
                Ok(PromptDispatchSummary {
                    total_entries: row.get("total_entries")?,
                    flagged_entries: row.get("flagged_entries")?,
                    prompt_tokens_total: row.get("prompt_tokens_total")?,
                    prompt_tokens_exact_count: row.get("exact_count")?,
                    prompt_tokens_estimated_count: row.get("estimated_count")?,
                    total_cost_usd: row.get("total_cost_usd")?,
                })
            })
            .map_err(StatsError::from)
    }

    /// `pruneOldEntries`: drops rows older than the retention window, then the
    /// oldest rows beyond the entry cap.
    pub fn prune_old_entries(
        &self,
        retention_days: i64,
        max_entries: i64,
        now_ms: i64,
    ) -> Result<(), StatsError> {
        let cutoff = iso_from_ms(now_ms - retention_days * DAY_MS).unwrap_or_default();
        let connection = self.lock();
        connection.execute(
            "DELETE FROM prompt_dispatch_logs WHERE created_at < ?",
            params![cutoff],
        )?;
        let count: i64 =
            connection.query_row("SELECT COUNT(*) FROM prompt_dispatch_logs", [], |row| {
                row.get(0)
            })?;
        if count > max_entries {
            connection.execute(
                "DELETE FROM prompt_dispatch_logs
                 WHERE id IN (
                   SELECT id FROM prompt_dispatch_logs ORDER BY created_at ASC LIMIT ?
                 )",
                params![count - max_entries],
            )?;
        }
        Ok(())
    }

    pub fn clear_dispatches(&self) -> Result<usize, StatsError> {
        let connection = self.lock();
        Ok(connection.execute("DELETE FROM prompt_dispatch_logs", [])?)
    }

    /// `maybePrune`: at most once a minute, and a failure never reaches the
    /// dispatch that triggered it.
    fn maybe_prune(&self, now: i64) {
        if now - self.last_prune_ms.load(Ordering::Relaxed) < PRUNE_INTERVAL_MS {
            return;
        }
        self.last_prune_ms.store(now, Ordering::Relaxed);
        let (retention_days, max_entries) = prune_limits_from_env();
        let _ = self.prune_old_entries(retention_days, max_entries, now);
    }

    /// Reads the single row with `id`.
    pub fn find_by_id(&self, id: &str) -> Result<Option<PromptDispatchEntry>, StatsError> {
        let connection = self.lock();
        let entry = connection
            .query_row(
                "SELECT * FROM prompt_dispatch_logs WHERE id = ?",
                [id],
                row_to_entry,
            )
            .optional()?;
        Ok(entry)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A repository whose write-path retention pass is throttled for the test,
    /// so rows dated in 2026 are not pruned against the real clock. The prune
    /// test calls `prune_old_entries` directly.
    fn new_repository() -> PromptDispatchRepository {
        let repository = PromptDispatchRepository::in_memory().expect("in-memory repository");
        repository.last_prune_ms.store(now_ms(), Ordering::Relaxed);
        repository
    }

    fn input(model: &str, risk: RiskLevel, source: TokensSource) -> RecordPromptDispatchInput {
        RecordPromptDispatchInput {
            provider_id: "openai".into(),
            model_name: model.into(),
            account_id: None,
            dispatch_kind: DispatchKind::Chat,
            prompt_tokens: 100,
            prompt_tokens_source: source,
            completion_tokens: 20,
            total_tokens: 120,
            status: DispatchStatus::Success,
            error_message: None,
            risk_level: risk,
            risk_score: 0,
            risk_reasons: vec![],
            prompt_preview: "hello world".into(),
            prompt_payload_json: "{\"messages\":[]}".into(),
            prompt_cost_usd: Some(0.5),
            completion_cost_usd: Some(0.25),
            total_cost_usd: Some(0.75),
            created_at: Some("2026-06-10T10:00:00.000Z".into()),
            conversation_id: None,
            turn_seq: None,
            latency_ms: None,
            tool_calls_json: None,
            memory_context_json: None,
        }
    }

    #[test]
    fn records_and_reads_back_with_defaults() {
        let repository = new_repository();
        let entry = repository
            .record_dispatch(input("gpt-4.1", RiskLevel::Low, TokensSource::Exact))
            .expect("record");
        assert_eq!(entry.tool_calls_json, "[]");
        assert_eq!(entry.created_at, "2026-06-10T10:00:00.000Z");

        let stored = repository
            .find_by_id(&entry.id)
            .expect("find")
            .expect("exists");
        assert_eq!(stored.model_name, "gpt-4.1");
        assert_eq!(stored.prompt_tokens_source, TokensSource::Exact);
        assert_eq!(stored.account_id, None);
        assert_eq!(stored.total_cost_usd, Some(0.75));
    }

    #[test]
    fn flagged_filter_matches_medium_and_high_only() {
        let repository = new_repository();
        for risk in [RiskLevel::Low, RiskLevel::Medium, RiskLevel::High] {
            repository
                .record_dispatch(input("m", risk, TokensSource::Estimated))
                .expect("record");
        }
        let flagged = PromptDispatchFilter {
            risk: Some(RiskFilter::Flagged),
            ..Default::default()
        };
        assert_eq!(repository.count_dispatches(&flagged).expect("count"), 2);
        let only_low = PromptDispatchFilter {
            risk: Some(RiskFilter::Level(RiskLevel::Low)),
            ..Default::default()
        };
        assert_eq!(repository.count_dispatches(&only_low).expect("count"), 1);
    }

    #[test]
    fn summary_counts_sources_and_flags() {
        let repository = new_repository();
        repository
            .record_dispatch(input("a", RiskLevel::High, TokensSource::Exact))
            .expect("record");
        repository
            .record_dispatch(input("b", RiskLevel::Low, TokensSource::Estimated))
            .expect("record");
        let summary = repository
            .get_summary(&PromptDispatchFilter::default())
            .expect("summary");
        assert_eq!(summary.total_entries, 2);
        assert_eq!(summary.flagged_entries, 1);
        assert_eq!(summary.prompt_tokens_total, 200);
        assert_eq!(summary.prompt_tokens_exact_count, 1);
        assert_eq!(summary.prompt_tokens_estimated_count, 1);
        assert!((summary.total_cost_usd - 1.5).abs() < 1e-9);
    }

    #[test]
    fn conversation_filter_orders_by_turn() {
        let repository = new_repository();
        for turn in [2, 1, 3] {
            let mut row = input("m", RiskLevel::Low, TokensSource::Exact);
            row.conversation_id = Some("conv-1".into());
            row.turn_seq = Some(turn);
            repository.record_dispatch(row).expect("record");
        }
        let filter = PromptDispatchFilter {
            conversation_id: Some("conv-1".into()),
            ..Default::default()
        };
        let turns: Vec<Option<i64>> = repository
            .list_dispatches(&filter)
            .expect("list")
            .iter()
            .map(|entry| entry.turn_seq)
            .collect();
        assert_eq!(turns, vec![Some(3), Some(2), Some(1)]);

        let summaries = repository.list_conversation_summaries().expect("summaries");
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].turn_count, 3);
        assert_eq!(summaries[0].model_name, "m");
    }

    #[test]
    fn search_matches_the_payload() {
        let repository = new_repository();
        let mut row = input("m", RiskLevel::Low, TokensSource::Exact);
        row.prompt_payload_json = "{\"text\":\"needle in payload\"}".into();
        repository.record_dispatch(row).expect("record");
        let filter = PromptDispatchFilter {
            search: Some("needle".into()),
            ..Default::default()
        };
        assert_eq!(repository.count_dispatches(&filter).expect("count"), 1);
    }

    #[test]
    fn prune_drops_expired_rows_and_enforces_the_cap() {
        let repository = new_repository();
        // now = 2026-06-01T00:00:00Z, retention 30 days: cutoff 2026-05-02.
        let now = 1_780_272_000_000_i64;
        for created in [
            "2026-04-01T00:00:00.000Z",
            "2026-05-20T00:00:00.000Z",
            "2026-05-21T00:00:00.000Z",
            "2026-05-22T00:00:00.000Z",
        ] {
            let mut row = input("m", RiskLevel::Low, TokensSource::Exact);
            row.created_at = Some(created.into());
            repository.record_dispatch(row).expect("record");
        }
        repository.prune_old_entries(30, 2, now).expect("prune");
        let remaining = repository
            .list_dispatches(&PromptDispatchFilter::default())
            .expect("list");
        let created: Vec<&str> = remaining.iter().map(|e| e.created_at.as_str()).collect();
        assert_eq!(
            created,
            vec!["2026-05-22T00:00:00.000Z", "2026-05-21T00:00:00.000Z"]
        );
    }
}
