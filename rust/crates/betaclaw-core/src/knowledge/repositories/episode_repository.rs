//! Port of `src/server/knowledge/repositories/episodeRepository.ts`.
//!
//! | TypeScript member                             | Rust member |
//! | --------------------------------------------- | ----------- |
//! | `episodeRepository.ts:10` (class)              | [`EpisodeRepository`] |
//! | `episodeRepository.ts:13-94` (`upsertEpisode`) | [`EpisodeRepository::upsert_episode`] |
//! | `episodeRepository.ts:96-133` (`listEpisodes`) | [`EpisodeRepository::list_episodes`] |
//! | `episodeRepository.ts:135-153` (`mapEpisode`)  | [`EpisodeRepository::map_episode`] |
//!
//! # JavaScript semantics that are reproduced explicitly
//!
//! * `Math.max(0, …)` clamps the start sequence; `Math.max(start, …)` clamps the
//!   end sequence, and `input.sourceSeqEnd || sourceSeqStart` means a stored `0`
//!   falls back to the start — `0` is falsy.
//! * `String(input.topicKey || '').trim() || 'general'` yields `general` for an
//!   empty key; `String(input.counterpart || '').trim() || null` yields `null`.
//! * The `counterpart`/`topicKey` filters lower-case both sides and wrap the value
//!   in `%…%`, and the `from`/`to` bounds keep rows whose `event_at` is `NULL`.
//! * `parseIso` normalizes `event_at` on both write and read, so the stored text
//!   is always a `toISOString()` value.
//!
//! # Deviation
//!
//! `memory_ids_json` is `JSON.stringify(input.memoryIds || [])`, i.e. it is
//! **not** passed through `toStringArray`. The port serializes the input vector
//! verbatim, keeping that asymmetry.

use rusqlite::params_from_iter;
use rusqlite::types::Value;
use rusqlite::{params, Connection, OptionalExtension};

use super::{
    as_limit, now_iso, parse_iso, parse_json_array, to_source_refs, to_string_array, trimmed_or,
    KnowledgeRepositoryError,
};
use crate::knowledge::repository::{
    KnowledgeEpisode, ListKnowledgeFilter, UpsertKnowledgeEpisodeInput,
};

/// `EpisodeRepository` from `episodeRepository.ts:10`.
pub struct EpisodeRepository<'a> {
    db: &'a Connection,
}

impl<'a> EpisodeRepository<'a> {
    pub fn new(db: &'a Connection) -> Self {
        Self { db }
    }

    /// `upsertEpisode` from `episodeRepository.ts:13-94`.
    pub fn upsert_episode(
        &self,
        input: &UpsertKnowledgeEpisodeInput,
    ) -> Result<KnowledgeEpisode, KnowledgeRepositoryError> {
        let now = now_iso();
        let source_seq_start = input.source_seq_start.max(0);
        // `Math.floor(Number(input.sourceSeqEnd || sourceSeqStart))`.
        let raw_end = if input.source_seq_end == 0 {
            source_seq_start
        } else {
            input.source_seq_end
        };
        let source_seq_end = raw_end.max(source_seq_start);

        let existing_id = self
            .db
            .query_row(
                "
                SELECT id
                FROM knowledge_episodes
                WHERE conversation_id = ? AND persona_id = ? AND source_seq_start = ? AND source_seq_end = ?
                LIMIT 1
              ",
                params![
                    input.conversation_id,
                    input.persona_id,
                    source_seq_start,
                    source_seq_end
                ],
                |row| row.get::<_, String>(0),
            )
            .optional()?;

        let id = existing_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

        // `String(input.topicKey || '').trim() || 'general'`.
        let topic_key = trimmed_or(&input.topic_key, "general");
        // `String(input.counterpart || '').trim() || null`.
        let counterpart = input
            .counterpart
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let teaser = input.teaser.trim();
        let episode = input.episode.trim();
        let facts_json = serde_json::to_string(&to_string_array(&input.facts))?;
        let source_refs_json = serde_json::to_string(&to_source_refs(&input.source_refs))?;
        let memory_ids_json = serde_json::to_string(&input.memory_ids)?;
        let event_at = parse_iso(input.event_at.as_deref());

        self.db.execute(
            "
            INSERT INTO knowledge_episodes (
              id,
              user_id,
              persona_id,
              conversation_id,
              topic_key,
              counterpart,
              teaser,
              episode,
              facts_json,
              source_seq_start,
              source_seq_end,
              source_refs_json,
              memory_ids_json,
              event_at,
              created_at,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(conversation_id, persona_id, source_seq_start, source_seq_end)
            DO UPDATE SET
              topic_key = excluded.topic_key,
              counterpart = excluded.counterpart,
              teaser = excluded.teaser,
              episode = excluded.episode,
              facts_json = excluded.facts_json,
              source_refs_json = excluded.source_refs_json,
              memory_ids_json = excluded.memory_ids_json,
              event_at = excluded.event_at,
              updated_at = excluded.updated_at
          ",
            params![
                id,
                input.user_id,
                input.persona_id,
                input.conversation_id,
                topic_key,
                counterpart,
                teaser,
                episode,
                facts_json,
                source_seq_start,
                source_seq_end,
                source_refs_json,
                memory_ids_json,
                event_at,
                now,
                now
            ],
        )?;

        let row = self
            .db
            .query_row(
                "SELECT * FROM knowledge_episodes WHERE id = ?",
                params![id],
                read_episode_row,
            )
            .optional()?
            .ok_or_else(|| KnowledgeRepositoryError::MissingRow {
                context: "knowledge_episodes".to_string(),
            })?;
        Ok(self.map_episode(row))
    }

    /// `listEpisodes` from `episodeRepository.ts:96-133`.
    pub fn list_episodes(
        &self,
        filter: &ListKnowledgeFilter,
    ) -> Result<Vec<KnowledgeEpisode>, KnowledgeRepositoryError> {
        let limit = as_limit(filter.limit, 20);
        let mut conditions = vec!["user_id = ?".to_string(), "persona_id = ?".to_string()];
        let mut values = vec![
            Value::Text(filter.user_id.clone()),
            Value::Text(filter.persona_id.clone()),
        ];

        if let Some(counterpart) = filter
            .counterpart
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            conditions.push("LOWER(COALESCE(counterpart, '')) LIKE ?".to_string());
            values.push(Value::Text(format!("%{}%", counterpart.to_lowercase())));
        }
        if let Some(topic_key) = filter
            .topic_key
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            conditions.push("LOWER(topic_key) LIKE ?".to_string());
            values.push(Value::Text(format!("%{}%", topic_key.to_lowercase())));
        }
        if let Some(from_iso) = parse_iso(filter.from.as_deref()) {
            conditions.push("(event_at IS NULL OR event_at >= ?)".to_string());
            values.push(Value::Text(from_iso));
        }
        if let Some(to_iso) = parse_iso(filter.to.as_deref()) {
            conditions.push("(event_at IS NULL OR event_at <= ?)".to_string());
            values.push(Value::Text(to_iso));
        }
        values.push(Value::Integer(limit));

        let sql = format!(
            "
            SELECT *
            FROM knowledge_episodes
            WHERE {}
            ORDER BY COALESCE(event_at, updated_at) DESC
            LIMIT ?
          ",
            conditions.join(" AND ")
        );
        let mut statement = self.db.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(values), read_episode_row)?;
        let mut episodes = Vec::new();
        for row in rows {
            episodes.push(self.map_episode(row?));
        }
        Ok(episodes)
    }

    /// `mapEpisode` from `episodeRepository.ts:135-153`.
    fn map_episode(&self, row: EpisodeRow) -> KnowledgeEpisode {
        KnowledgeEpisode {
            id: row.id,
            user_id: row.user_id,
            persona_id: row.persona_id,
            conversation_id: row.conversation_id,
            topic_key: row.topic_key,
            counterpart: row
                .counterpart
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
            teaser: row.teaser,
            episode: row.episode,
            facts: parse_json_array(row.facts_json.as_deref()),
            source_seq_start: row.source_seq_start.unwrap_or(0),
            source_seq_end: row.source_seq_end.unwrap_or(0),
            source_refs: parse_json_array(row.source_refs_json.as_deref()),
            memory_ids: parse_json_array(row.memory_ids_json.as_deref()),
            event_at: parse_iso(row.event_at.as_deref()),
            updated_at: row.updated_at.unwrap_or_default(),
        }
    }
}

/// The columns of a `knowledge_episodes` row, before `mapEpisode` coerces them
/// exactly like the TypeScript reader. `created_at` is not read because
/// `mapEpisode` never exposes it.
struct EpisodeRow {
    id: String,
    user_id: String,
    persona_id: String,
    conversation_id: String,
    topic_key: String,
    counterpart: Option<String>,
    teaser: String,
    episode: String,
    facts_json: Option<String>,
    source_seq_start: Option<i64>,
    source_seq_end: Option<i64>,
    source_refs_json: Option<String>,
    event_at: Option<String>,
    updated_at: Option<String>,
    memory_ids_json: Option<String>,
}

/// Reads the `SELECT *` projection by position, matching the table column order
/// declared in [`super::migrations`]; `memory_ids_json` was appended by the
/// additive `ALTER TABLE` and is therefore the last column.
fn read_episode_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<EpisodeRow> {
    Ok(EpisodeRow {
        id: row.get(0)?,
        user_id: row.get(1)?,
        persona_id: row.get(2)?,
        conversation_id: row.get(3)?,
        topic_key: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
        counterpart: row.get(5)?,
        teaser: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
        episode: row.get::<_, Option<String>>(7)?.unwrap_or_default(),
        facts_json: row.get(8)?,
        source_seq_start: row.get(9)?,
        source_seq_end: row.get(10)?,
        source_refs_json: row.get(11)?,
        event_at: row.get(12)?,
        updated_at: row.get(14)?,
        memory_ids_json: row.get(15)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{open, OpenOptions};
    use crate::knowledge::repositories::migrations::run_knowledge_migrations;
    use crate::knowledge::repository::KnowledgeSourceRef;

    fn connection() -> Connection {
        let connection = open(OpenOptions::new(":memory:")).expect("open");
        run_knowledge_migrations(&connection).expect("migrate");
        connection
    }

    fn input(start: i64, end: i64) -> UpsertKnowledgeEpisodeInput {
        UpsertKnowledgeEpisodeInput {
            user_id: "u-1".to_string(),
            persona_id: "p-1".to_string(),
            conversation_id: "c-1".to_string(),
            topic_key: "  ".to_string(),
            counterpart: Some("  Max  ".to_string()),
            teaser: "  teaser  ".to_string(),
            episode: "  the episode  ".to_string(),
            facts: vec!["  alpha ".to_string(), String::new(), "beta".to_string()],
            source_seq_start: start,
            source_seq_end: end,
            source_refs: vec![
                KnowledgeSourceRef {
                    seq: 1,
                    quote: "  q1  ".to_string(),
                },
                KnowledgeSourceRef {
                    seq: 2,
                    quote: "  ".to_string(),
                },
            ],
            memory_ids: vec!["m-1".to_string()],
            event_at: Some("2026-01-02T03:04:05Z".to_string()),
        }
    }

    #[test]
    fn an_upsert_normalizes_the_blank_fields() {
        let connection = connection();
        let repo = EpisodeRepository::new(&connection);

        let episode = repo.upsert_episode(&input(1, 2)).expect("upsert");
        assert_eq!(episode.topic_key, "general");
        assert_eq!(episode.counterpart.as_deref(), Some("Max"));
        assert_eq!(episode.teaser, "teaser");
        assert_eq!(episode.episode, "the episode");
        assert_eq!(episode.facts, vec!["alpha", "beta"]);
        assert_eq!(episode.source_refs.len(), 1);
        assert_eq!(episode.source_refs[0].quote, "q1");
        assert_eq!(episode.memory_ids, vec!["m-1"]);
        assert_eq!(
            episode.event_at.as_deref(),
            Some("2026-01-02T03:04:05.000Z")
        );
    }

    #[test]
    fn a_zero_end_falls_back_to_the_start_sequence() {
        let connection = connection();
        let repo = EpisodeRepository::new(&connection);

        let episode = repo.upsert_episode(&input(5, 0)).expect("upsert");
        assert_eq!(episode.source_seq_start, 5);
        assert_eq!(episode.source_seq_end, 5);
    }

    #[test]
    fn a_conflicting_upsert_reuses_the_row() {
        let connection = connection();
        let repo = EpisodeRepository::new(&connection);

        let first = repo.upsert_episode(&input(1, 2)).expect("first");
        let mut second_input = input(1, 2);
        second_input.teaser = "changed".to_string();
        let second = repo.upsert_episode(&second_input).expect("second");

        assert_eq!(first.id, second.id, "the same unique key updates in place");
        assert_eq!(second.teaser, "changed");
        let rows: i64 = connection
            .query_row("SELECT COUNT(*) FROM knowledge_episodes", [], |row| {
                row.get(0)
            })
            .expect("count");
        assert_eq!(rows, 1);
    }

    #[test]
    fn list_filters_by_counterpart_topic_and_window() {
        let connection = connection();
        let repo = EpisodeRepository::new(&connection);
        connection
            .execute_batch(
                r#"
                INSERT INTO knowledge_episodes
                  (id,user_id,persona_id,conversation_id,topic_key,counterpart,teaser,episode,
                   facts_json,source_seq_start,source_seq_end,source_refs_json,event_at,
                   created_at,updated_at,memory_ids_json)
                VALUES
                  ('e-1','u-1','p-1','c-1','work','Max','t','e','[]',1,2,'[]',
                   '2026-01-05T00:00:00.000Z','t','2026-01-05T00:00:00.000Z','[]'),
                  ('e-2','u-1','p-1','c-1','home','Nata','t','e','[]',3,4,'[]',
                   NULL,'t','2026-02-01T00:00:00.000Z','[]'),
                  ('e-3','u-1','p-1','c-1','work','Someone','t','e','[]',5,6,'[]',
                   '2026-03-01T00:00:00.000Z','t','2026-03-01T00:00:00.000Z','[]');
                "#,
            )
            .expect("seed");

        let by_counterpart = repo
            .list_episodes(&ListKnowledgeFilter {
                user_id: "u-1".to_string(),
                persona_id: "p-1".to_string(),
                counterpart: Some("MAX".to_string()),
                ..Default::default()
            })
            .expect("list");
        assert_eq!(by_counterpart.len(), 1);
        assert_eq!(by_counterpart[0].id, "e-1");

        // A window keeps the NULL event_at row (e-2) plus e-1.
        let by_window = repo
            .list_episodes(&ListKnowledgeFilter {
                user_id: "u-1".to_string(),
                persona_id: "p-1".to_string(),
                from: Some("2026-01-01T00:00:00Z".to_string()),
                to: Some("2026-02-28T00:00:00Z".to_string()),
                ..Default::default()
            })
            .expect("list");
        let ids: Vec<&str> = by_window.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["e-2", "e-1"],
            "ordered by COALESCE(event_at, updated_at) DESC"
        );
    }
}
