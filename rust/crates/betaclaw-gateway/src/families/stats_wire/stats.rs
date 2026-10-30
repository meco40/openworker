//! Ports `app/api/stats/route.ts` (GET), `app/api/stats/engineering/route.ts`
//! (GET) and `app/api/stats/prompt-logs/route.ts` (GET, DELETE).
//!
//! The engineering snapshot follows `collectEngineeringMetricsSnapshot` in
//! `src/server/stats/engineeringMetricsService.ts`. The active domains come from
//! `src/server/ci/harnessDomainRegistry.ts`, read by [`load_active_domain_ids`],
//! which validates the registry as the TypeScript does.

use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, PoisonError};

use axum::extract::{Extension, RawQuery, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use betaclaw_core::master::repository::sqlite_master_repository::SqliteMasterRepository;
use betaclaw_core::master::types::WorkspaceScope as MasterScope;
use betaclaw_core::messages_store::Conversation;
use betaclaw_core::stats::engineering_metrics::EngineeringMetricsSnapshot;
use betaclaw_core::stats::engineering_metrics_service::{gather_collect_data, parse_window_days};
use betaclaw_core::stats::engineering_signal_sources::{
    collect_engineering_metrics_snapshot_from_sources, MasterRunRecord, MasterSignalSource,
    SqliteTaskSignals, WorkspaceScope,
};
use betaclaw_core::stats::prompt_dispatch::{
    PromptDispatchFilter, PromptDispatchSummary, RiskFilter, RiskLevel,
};
use betaclaw_core::stats::prompt_dispatch_diagnostics::{get_diagnostics, reset_diagnostics};
use betaclaw_core::stats::util::{iso_millis, js_parse_int};
use betaclaw_core::stats::StatsError;
use chrono::{DateTime, Datelike, Days, Local, NaiveDate, TimeZone, Utc};
use serde_json::{json, Map, Value};

use super::auth::Caller;
use super::params::{non_empty, query_value};
use super::{error_response, Services};
use crate::auth_gate::unauthorized_response;
use crate::proxy::proxy_to_upstream;
use crate::state::SharedState;

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/api/stats", get(overview).fallback(proxy_to_upstream))
        .route(
            "/api/stats/engineering",
            get(engineering).fallback(proxy_to_upstream),
        )
        .route(
            "/api/stats/prompt-logs",
            get(prompt_logs)
                .delete(clear_prompt_logs)
                .fallback(proxy_to_upstream),
        )
}

/// `GET /api/stats`: totals of the token usage, optionally with the session lens.
async fn overview(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    if Caller::from_request(&state, &headers).is_none() {
        return unauthorized_response();
    }
    let query = query.as_deref();
    let (from, to) = stats_window(query, Local::now());
    let include_sessions = matches!(
        query_value(query, "sessions")
            .unwrap_or_default()
            .trim()
            .to_lowercase()
            .as_str(),
        "1" | "true" | "yes" | "on"
    );
    match overview_body(
        &state,
        &services,
        from.as_deref(),
        to.as_deref(),
        include_sessions,
    )
    .await
    {
        Ok(body) => Json(body).into_response(),
        Err(message) => error_response(StatusCode::INTERNAL_SERVER_ERROR, &message),
    }
}

async fn overview_body(
    state: &SharedState,
    services: &Services,
    from: Option<&str>,
    to: Option<&str>,
    include_sessions: bool,
) -> Result<Value, String> {
    let total = services
        .token_usage
        .get_total_tokens(from, to)
        .map_err(fail)?;
    let by_model = services
        .token_usage
        .get_usage_summary(from, to)
        .map_err(fail)?;
    let entry_count = services.token_usage.get_entry_count().map_err(fail)?;
    let mut body = json!({
        "ok": true,
        "overview": {
            "uptimeSeconds": services.started.elapsed().as_secs(),
            "totalRequests": entry_count,
        },
        "tokenUsage": {
            "total": {
                "prompt": total.prompt_tokens,
                "completion": total.completion_tokens,
                "total": total.total_tokens,
            },
            "byModel": by_model
                .iter()
                .map(|entry| json!({
                    "provider": entry.provider,
                    "model": entry.model,
                    "prompt": entry.prompt_tokens,
                    "completion": entry.completion_tokens,
                    "total": entry.total_tokens,
                }))
                .collect::<Vec<_>>(),
        },
    });
    if include_sessions {
        body["sessionLens"] = session_lens(state).await?;
    }
    Ok(body)
}

/// `buildSessionLens`: the 200 most recent conversations, grouped by channel.
/// Like the TypeScript, it reads every user's conversations.
async fn session_lens(state: &SharedState) -> Result<Value, String> {
    let sessions: Vec<Conversation> = state
        .messages
        .lock()
        .await
        .list_conversations(200, None)
        .map_err(fail)?;

    let mut counts: Vec<(String, i64)> = Vec::new();
    for session in &sessions {
        let key = if session.channel_type.is_empty() {
            "unknown".to_string()
        } else {
            session.channel_type.clone()
        };
        match counts.iter_mut().find(|(channel, _)| *channel == key) {
            Some(entry) => entry.1 += 1,
            None => counts.push((key, 1)),
        }
    }
    // A stable sort keeps the first-seen order of equal counts, as Array.sort does.
    counts.sort_by(|left, right| right.1.cmp(&left.1));

    let top_sessions: Vec<Value> = sessions
        .iter()
        .take(20)
        .map(|session| {
            json!({
                "id": session.id,
                "title": session.title,
                "channelType": session.channel_type,
                "externalChatId": session.external_chat_id,
                "modelOverride": session.model_override,
                "personaId": session.persona_id,
                "updatedAt": session.updated_at,
            })
        })
        .collect();
    Ok(json!({
        "totalSessions": sessions.len(),
        "byChannel": counts
            .iter()
            .map(|(channel, count)| json!({ "channelType": channel, "count": count }))
            .collect::<Vec<_>>(),
        "topSessions": top_sessions,
    }))
}

/// `GET /api/stats/engineering?windowDays=7|30&workspaceId=`.
async fn engineering(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    let Some(caller) = Caller::from_request(&state, &headers) else {
        return unauthorized_response();
    };
    let query = query.as_deref();
    let window_days = match parse_window_days(query_value(query, "windowDays").as_deref()) {
        Ok(days) => days,
        Err(error) => return error_response(StatusCode::BAD_REQUEST, &error.to_string()),
    };
    let workspace_id = query_value(query, "workspaceId")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    match engineering_snapshot(
        &services,
        &caller.user_id,
        workspace_id.as_deref(),
        window_days,
        Utc::now(),
    ) {
        Ok(snapshot) => Json(json!({ "ok": true, "snapshot": snapshot })).into_response(),
        Err(message) => error_response(StatusCode::INTERNAL_SERVER_ERROR, &message),
    }
}

/// `collectEngineeringMetricsSnapshot` with the reads of this family. The master
/// and task signals are read only on the fallback path, as in the TypeScript.
fn engineering_snapshot(
    services: &Services,
    user_id: &str,
    workspace_id: Option<&str>,
    window_days: u32,
    now: DateTime<Utc>,
) -> Result<EngineeringMetricsSnapshot, String> {
    let domains = load_active_domain_ids(&services.domain_registry_path)?;
    let data = gather_collect_data(
        &services.snapshots,
        window_days,
        now,
        domains,
        &services.rollout_config_path,
    )
    .map_err(fail)?;
    let master = services
        .master
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    let main = services.main.lock();
    let master_signals = MasterSignals(&master);
    let task_signals = SqliteTaskSignals::new(&main);
    let snapshot = collect_engineering_metrics_snapshot_from_sources(
        window_days,
        now,
        &data,
        user_id,
        workspace_id,
        &master_signals,
        &task_signals,
    );
    snapshot.map_err(fail)
}

/// The master reads of the metrics, over [`SqliteMasterRepository`].
struct MasterSignals<'a>(&'a SqliteMasterRepository);

impl MasterSignalSource for MasterSignals<'_> {
    fn known_scopes(&self, limit: usize) -> Result<Vec<WorkspaceScope>, StatsError> {
        let scopes = self.0.list_known_scopes(limit as i64)?;
        Ok(scopes
            .into_iter()
            .map(|scope| WorkspaceScope {
                user_id: scope.user_id,
                workspace_id: scope.workspace_id,
            })
            .collect())
    }

    fn runs(
        &self,
        scope: &WorkspaceScope,
        limit: usize,
    ) -> Result<Vec<MasterRunRecord>, StatsError> {
        let master_scope = master_scope(scope);
        let runs = self.0.list_runs(&master_scope, limit as i64)?;
        Ok(runs
            .into_iter()
            .map(|run| MasterRunRecord {
                status: run.status,
                created_at: run.created_at,
                updated_at: run.updated_at,
                verification_passed: run.verification_passed,
            })
            .collect())
    }

    fn audit_actions(
        &self,
        scope: &WorkspaceScope,
        limit: usize,
    ) -> Result<Vec<String>, StatsError> {
        let master_scope = master_scope(scope);
        let events = self.0.list_audit_events(&master_scope, limit as i64)?;
        Ok(events.into_iter().map(|event| event.action).collect())
    }
}

fn master_scope(scope: &WorkspaceScope) -> MasterScope {
    MasterScope {
        user_id: scope.user_id.clone(),
        workspace_id: scope.workspace_id.clone(),
    }
}

/// `loadDomainRegistry().domains.map(id)`. Every field is required, risk is one of
/// three values, and ids and contracts are unique. The error texts are those of the
/// TypeScript.
///
/// ponytail: non-string scalars are rejected here, where the TypeScript coerces
/// them with `String(value)`. The registry is a repository file, so this does not
/// arise in practice.
fn load_active_domain_ids(path: &Path) -> Result<Vec<String>, String> {
    const SHAPE: &str = "Expected object in domain registry payload.";
    let raw = std::fs::read_to_string(path).map_err(fail)?;
    let root: Value = serde_json::from_str(&raw).map_err(fail)?;
    let root = root.as_object().ok_or(SHAPE)?;
    let entries = root
        .get("domains")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut ids = Vec::new();
    let mut seen_ids = HashSet::new();
    let mut seen_contracts = HashSet::new();
    for (index, entry) in entries.iter().enumerate() {
        let row = entry.as_object().ok_or(SHAPE)?;
        let risk = required_text(row, index, "risk")?;
        if !matches!(risk.as_str(), "low" | "medium" | "high") {
            return Err(format!("Invalid risk value for domain {index}: {risk}"));
        }
        let id = required_text(row, index, "id")?;
        for field in ["display", "systemDoc"] {
            required_text(row, index, field)?;
        }
        let contract = required_text(row, index, "contract")?;
        required_text(row, index, "owner")?;
        for field in ["paths", "scenarios", "tests"] {
            required_list(row, index, field)?;
        }
        if !seen_ids.insert(id.clone()) {
            return Err(format!("Duplicate domain id in registry: {id}"));
        }
        if !seen_contracts.insert(contract.clone()) {
            return Err(format!("Duplicate domain contract in registry: {contract}"));
        }
        ids.push(id);
    }
    if ids.is_empty() {
        return Err("Domain registry must contain at least one domain.".to_string());
    }
    Ok(ids)
}

fn required_text(row: &Map<String, Value>, index: usize, field: &str) -> Result<String, String> {
    match row.get(field) {
        Some(Value::String(text)) if !text.trim().is_empty() => Ok(text.trim().to_string()),
        _ => Err(format!("Missing required field: domains[{index}].{field}")),
    }
}

fn required_list(row: &Map<String, Value>, index: usize, field: &str) -> Result<(), String> {
    match row.get(field) {
        Some(Value::Array(items)) if !items.is_empty() => {
            for (item_index, item) in items.iter().enumerate() {
                match item {
                    Value::String(text) if !text.trim().is_empty() => {}
                    _ => {
                        return Err(format!(
                            "Missing required field: domains[{index}].{field}[{item_index}]"
                        ))
                    }
                }
            }
            Ok(())
        }
        _ => Err(format!(
            "Missing required non-empty array field: domains[{index}].{field}"
        )),
    }
}

/// `GET /api/stats/prompt-logs`: a page of dispatches with the summary and the
/// diagnostics.
async fn prompt_logs(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    if Caller::from_request(&state, &headers).is_none() {
        return unauthorized_response();
    }
    match prompt_logs_body(&services, query.as_deref(), Local::now()) {
        Ok(body) => Json(body).into_response(),
        Err(message) => error_response(StatusCode::INTERNAL_SERVER_ERROR, &message),
    }
}

fn prompt_logs_body(
    services: &Services,
    query: Option<&str>,
    now: DateTime<Local>,
) -> Result<Value, String> {
    let (from, to) = prompt_window(query, now);
    let limit = non_empty(query_value(query, "limit"))
        .as_deref()
        .and_then(js_parse_int)
        .unwrap_or(100)
        .clamp(1, 500);
    let mut filter = PromptDispatchFilter {
        from,
        to,
        search: non_empty(query_value(query, "search")),
        provider: non_empty(query_value(query, "provider")),
        model: non_empty(query_value(query, "model")),
        before: non_empty(query_value(query, "before")),
        limit: Some(limit),
        ..Default::default()
    };
    // An unknown risk value matches no row in the TypeScript, so the result is empty.
    let unknown_risk = match non_empty(query_value(query, "risk")).as_deref() {
        None => false,
        Some("flagged") => {
            filter.risk = Some(RiskFilter::Flagged);
            false
        }
        Some(text) => match RiskLevel::parse(text) {
            Some(level) => {
                filter.risk = Some(RiskFilter::Level(level));
                false
            }
            None => true,
        },
    };

    let repository = &services.prompt_dispatch;
    let (entries, total, summary) = if unknown_risk {
        (Vec::new(), 0, empty_summary())
    } else {
        (
            repository.list_dispatches(&filter).map_err(fail)?,
            repository.count_dispatches(&filter).map_err(fail)?,
            repository.get_summary(&filter).map_err(fail)?,
        )
    };
    let latest = repository
        .list_dispatches(&PromptDispatchFilter {
            limit: Some(1),
            ..Default::default()
        })
        .map_err(fail)?
        .into_iter()
        .next();

    // The counters fall back to the summary and the newest row, as in the TypeScript.
    let diagnostics = get_diagnostics();
    let attempts = if diagnostics.attempts_since_boot > 0 {
        diagnostics.attempts_since_boot as i64
    } else {
        summary.total_entries
    };
    let writes = if diagnostics.writes_since_boot > 0 {
        diagnostics.writes_since_boot as i64
    } else {
        summary.total_entries
    };
    let last_insert_at = diagnostics
        .last_insert_at
        .clone()
        .filter(|value| !value.is_empty())
        .or_else(|| latest.map(|entry| entry.created_at));
    let mut diagnostics_json = serde_json::to_value(&diagnostics).map_err(fail)?;
    diagnostics_json["attemptsSinceBoot"] = json!(attempts);
    diagnostics_json["writesSinceBoot"] = json!(writes);
    diagnostics_json["lastInsertAt"] = json!(last_insert_at);

    Ok(json!({
        "ok": true,
        "entries": entries,
        "total": total,
        "summary": summary,
        "diagnostics": diagnostics_json,
    }))
}

/// `DELETE /api/stats/prompt-logs`: clears the dispatches and the token usage,
/// and resets the diagnostics once both are cleared.
async fn clear_prompt_logs(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
) -> Response {
    if Caller::from_request(&state, &headers).is_none() {
        return unauthorized_response();
    }
    match clear_logs(&services) {
        Ok(body) => Json(body).into_response(),
        Err(message) => error_response(StatusCode::INTERNAL_SERVER_ERROR, &message),
    }
}

fn clear_logs(services: &Services) -> Result<Value, String> {
    let deleted_prompt_logs = services.prompt_dispatch.clear_dispatches().map_err(fail)?;
    let deleted_token_usage = services.token_usage.clear_entries().map_err(fail)?;
    reset_diagnostics();
    Ok(json!({
        "ok": true,
        "deletedPromptLogs": deleted_prompt_logs,
        "deletedTokenUsage": deleted_token_usage,
    }))
}

fn empty_summary() -> PromptDispatchSummary {
    PromptDispatchSummary {
        total_entries: 0,
        flagged_entries: 0,
        prompt_tokens_total: 0,
        prompt_tokens_exact_count: 0,
        prompt_tokens_estimated_count: 0,
        total_cost_usd: 0.0,
    }
}

/// The `from`/`to` window of the stats route. A preset applies only when no `from`
/// is given. An unknown preset leaves `from` empty and still sets `to` to now.
fn stats_window(query: Option<&str>, now: DateTime<Local>) -> (Option<String>, Option<String>) {
    let from = non_empty(query_value(query, "from"));
    let to = non_empty(query_value(query, "to"));
    match non_empty(query_value(query, "preset")) {
        Some(preset) if from.is_none() => (
            preset_start(&preset, now).map(iso_millis),
            Some(iso_millis(now.with_timezone(&Utc))),
        ),
        _ => (from, to),
    }
}

/// The window of the prompt-logs route. An unknown preset leaves both bounds empty.
fn prompt_window(query: Option<&str>, now: DateTime<Local>) -> (Option<String>, Option<String>) {
    let from = non_empty(query_value(query, "from"));
    let to = non_empty(query_value(query, "to"));
    match non_empty(query_value(query, "preset")) {
        Some(preset) if from.is_none() => match preset_start(&preset, now) {
            Some(start) => (
                Some(iso_millis(start)),
                Some(iso_millis(now.with_timezone(&Utc))),
            ),
            None => (None, None),
        },
        _ => (from, to),
    }
}

/// `resolvePreset`: the local-time start of `today`, `week` (Sunday based) or
/// `month`. Any other preset has no start.
fn preset_start(preset: &str, now: DateTime<Local>) -> Option<DateTime<Utc>> {
    let today = now.date_naive();
    let start_date: NaiveDate = match preset {
        "today" => today,
        "week" => {
            today.checked_sub_days(Days::new(u64::from(now.weekday().num_days_from_sunday())))?
        }
        "month" => today.with_day(1)?,
        _ => return None,
    };
    let midnight = start_date.and_hms_opt(0, 0, 0)?;
    let local = Local.from_local_datetime(&midnight).earliest()?;
    Some(local.with_timezone(&Utc))
}

/// Text of a failed store call, for the 500 bodies.
fn fail(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use axum::http::Method;

    use super::super::test_support::{app, assert_keys, send, services_in, state_in, Scratch};
    use super::*;

    const OWNER: &str = "user-1";

    #[test]
    fn presets_are_local_midnight_starts_and_unknown_presets_have_none() {
        let now = Local.with_ymd_and_hms(2026, 10, 14, 15, 30, 0).unwrap(); // a Wednesday
        let today = preset_start("today", now).expect("today");
        assert_eq!(today.with_timezone(&Local).date_naive(), now.date_naive());
        let week = preset_start("week", now)
            .expect("week")
            .with_timezone(&Local);
        assert_eq!(
            week.date_naive(),
            NaiveDate::from_ymd_opt(2026, 10, 11).unwrap()
        );
        let month = preset_start("month", now)
            .expect("month")
            .with_timezone(&Local);
        assert_eq!(
            month.date_naive(),
            NaiveDate::from_ymd_opt(2026, 10, 1).unwrap()
        );
        assert!(preset_start("yesterday", now).is_none());
    }

    #[test]
    fn the_registry_loader_reports_the_typescript_errors() {
        let scratch = Scratch::new();
        let path = std::path::PathBuf::from(scratch.path("registry.json"));
        std::fs::write(&path, r#"{"domains": []}"#).unwrap();
        assert_eq!(
            load_active_domain_ids(&path).unwrap_err(),
            "Domain registry must contain at least one domain."
        );
        std::fs::write(&path, r#"{"domains": [{"id": "a", "risk": "extreme"}]}"#).unwrap();
        assert_eq!(
            load_active_domain_ids(&path).unwrap_err(),
            "Invalid risk value for domain 0: extreme"
        );
    }

    #[tokio::test]
    async fn overview_requires_a_caller_and_adds_sessions_on_request() {
        let scratch = Scratch::new();
        let state = state_in(&scratch, false);
        let services = services_in(&scratch);
        let router = app(&state, &services);

        let (status, body) = send(&router, Method::GET, "/api/stats", None, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_keys(&body, &["error", "ok"]);

        let (status, body) = send(&router, Method::GET, "/api/stats", Some(OWNER), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_keys(&body, &["ok", "overview", "tokenUsage"]);
        assert_keys(
            &body["tokenUsage"]["total"],
            &["completion", "prompt", "total"],
        );

        let (status, body) = send(
            &router,
            Method::GET,
            "/api/stats?sessions=yes&preset=month",
            Some(OWNER),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_keys(&body, &["ok", "overview", "sessionLens", "tokenUsage"]);
        assert_keys(
            &body["sessionLens"],
            &["byChannel", "topSessions", "totalSessions"],
        );
    }

    #[tokio::test]
    async fn engineering_checks_the_window_and_serves_the_snapshot() {
        let scratch = Scratch::new();
        let state = state_in(&scratch, false);
        let services = services_in(&scratch);
        let router = app(&state, &services);

        let (status, body) = send(
            &router,
            Method::GET,
            "/api/stats/engineering?windowDays=5",
            Some(OWNER),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "windowDays must be 7 or 30");

        let (status, body) = send(
            &router,
            Method::GET,
            "/api/stats/engineering?windowDays=7",
            Some(OWNER),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_keys(&body, &["ok", "snapshot"]);
        assert_eq!(body["snapshot"]["windowDays"], 7);
        assert_eq!(body["snapshot"]["domainCoverage"]["activeDomains"], 2);

        let (status, _) = send(&router, Method::GET, "/api/stats/engineering", None, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn prompt_logs_list_and_clear() {
        let scratch = Scratch::new();
        let state = state_in(&scratch, false);
        let services = services_in(&scratch);
        let router = app(&state, &services);

        let (status, body) = send(
            &router,
            Method::GET,
            "/api/stats/prompt-logs",
            Some(OWNER),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_keys(&body, &["diagnostics", "entries", "ok", "summary", "total"]);
        assert_keys(
            &body["summary"],
            &[
                "flaggedEntries",
                "promptTokensEstimatedCount",
                "promptTokensExactCount",
                "promptTokensTotal",
                "totalCostUsd",
                "totalEntries",
            ],
        );

        let (status, body) = send(
            &router,
            Method::GET,
            "/api/stats/prompt-logs?risk=bogus",
            Some(OWNER),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["total"], 0);

        let (status, body) = send(
            &router,
            Method::DELETE,
            "/api/stats/prompt-logs",
            Some(OWNER),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_keys(&body, &["deletedPromptLogs", "deletedTokenUsage", "ok"]);

        let (status, _) = send(
            &router,
            Method::DELETE,
            "/api/stats/prompt-logs",
            None,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn unhandled_methods_fall_through_to_the_proxy() {
        let scratch = Scratch::new();
        let state = state_in(&scratch, false);
        let services = services_in(&scratch);
        let router = app(&state, &services);

        let (status, _) = send(&router, Method::PATCH, "/api/stats", Some(OWNER), None).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
    }
}
