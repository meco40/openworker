//! Port of `src/server/knowledge/repositories/eventRepository.ts`.
//!
//! | TypeScript member                                | Rust member |
//! | ------------------------------------------------ | ----------- |
//! | `eventRepository.ts:10` (class)                   | [`EventRepository`] |
//! | `eventRepository.ts:13-59` (`upsertEvent`)        | [`EventRepository::upsert_event`] |
//! | `eventRepository.ts:61-78` (`appendEventSources`)| [`EventRepository::append_event_sources`] |
//! | `eventRepository.ts:80-123` (`listEvents`)        | [`EventRepository::list_events`] |
//! | `eventRepository.ts:125-156` (`findOverlappingEvents`) | [`EventRepository::find_overlapping_events`] |
//! | `eventRepository.ts:158-180` (`countUniqueDays`)  | [`EventRepository::count_unique_days`] |
//! | `eventRepository.ts:182-204` (`mapEvent`)         | [`EventRepository::map_event`] |
//!
//! # JavaScript semantics that are reproduced explicitly
//!
//! * The upsert defaults are `??`, not `||`: `input.relationLabel ?? null`,
//!   `input.sourceSeqJson ?? '[]'`, `input.sourceSummary ?? ''`,
//!   `input.isConfirmation ? 1 : 0` and `input.confidence ?? 0.8`. An explicit
//!   empty string therefore survives, and only `null`/`undefined` fall back.
//! * `appendEventSources` de-duplicates and sorts numerically:
//!   `[...new Set([...existing, ...new])].sort((a, b) => a - b)`.
//! * The list filters lower-case the *value* and compare against a `LOWER(...)`
//!   column expression; `relation_label` is wrapped in `COALESCE(..., '')`.
//! * `countUniqueDays` expands each non-confirmation event's inclusive
//!   `start_date`..`end_date` window into unique `YYYY-MM-DD` keys, sorts them
//!   lexicographically and returns the *unfiltered* `events` alongside the
//!   non-confirmation `eventCount`.
//!
//! # Deviation
//!
//! The day expansion reads `start_date`/`end_date` as `YYYY-MM-DD` (what the
//! slice stores). V8 additionally accepts `YYYY-MM` and a full timestamp in
//! `new Date(date + 'T00:00:00Z')`; those spellings yield no days here, the same
//! result an invalid `Date` produces.

use std::collections::BTreeSet;

use chrono::{Datelike, NaiveDate};
use rusqlite::params_from_iter;
use rusqlite::types::Value;
use rusqlite::{params, Connection, OptionalExtension};

use super::{parse_json_array, KnowledgeRepositoryError};
use crate::knowledge::event_types::{
    EventAggregationResult, KnowledgeEvent, KnowledgeEventFilter, SpeakerRole,
    UpsertKnowledgeEventInput,
};

/// `EventRepository` from `eventRepository.ts:10`.
pub struct EventRepository<'a> {
    db: &'a Connection,
}

impl<'a> EventRepository<'a> {
    pub fn new(db: &'a Connection) -> Self {
        Self { db }
    }

    /// `upsertEvent` from `eventRepository.ts:13-59`.
    pub fn upsert_event(
        &self,
        input: &UpsertKnowledgeEventInput,
    ) -> Result<(), KnowledgeRepositoryError> {
        let now = super::now_iso();
        self.db.execute(
            "
            INSERT INTO knowledge_events (
              id, user_id, persona_id, conversation_id,
              event_type, speaker_role, speaker_entity, subject_entity,
              counterpart_entity, relation_label,
              start_date, end_date, day_count,
              source_seq_json, source_summary, is_confirmation, confidence,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, persona_id, event_type, subject_entity, counterpart_entity, start_date, end_date)
            DO UPDATE SET
              speaker_role = excluded.speaker_role,
              speaker_entity = excluded.speaker_entity,
              relation_label = excluded.relation_label,
              source_seq_json = excluded.source_seq_json,
              source_summary = excluded.source_summary,
              is_confirmation = excluded.is_confirmation,
              confidence = excluded.confidence,
              updated_at = excluded.updated_at
          ",
            params![
                input.id,
                input.user_id,
                input.persona_id,
                input.conversation_id,
                input.event_type,
                input.speaker_role.as_str(),
                input.speaker_entity,
                input.subject_entity,
                input.counterpart_entity,
                input.relation_label,
                input.start_date,
                input.end_date,
                input.day_count,
                input.source_seq_json.as_deref().unwrap_or("[]"),
                input.source_summary.as_deref().unwrap_or(""),
                if input.is_confirmation.unwrap_or(false) { 1 } else { 0 },
                input.confidence.unwrap_or(0.8),
                now,
                now
            ],
        )?;
        Ok(())
    }

    /// `appendEventSources` from `eventRepository.ts:61-78`.
    pub fn append_event_sources(
        &self,
        event_id: &str,
        new_seqs: &[i64],
        new_summary: Option<&str>,
    ) -> Result<(), KnowledgeRepositoryError> {
        let row = self
            .db
            .query_row(
                "SELECT source_seq_json, source_summary FROM knowledge_events WHERE id = ?",
                params![event_id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                    ))
                },
            )
            .optional()?;
        let Some((source_seq_json, source_summary)) = row else {
            return Ok(());
        };
        let source_summary = source_summary.unwrap_or_default();

        let existing_seqs: Vec<i64> = parse_json_array(source_seq_json.as_deref());
        // `[...new Set([...existingSeqs, ...newSeqs])].sort((a, b) => a - b)`.
        let mut merged: BTreeSet<i64> = existing_seqs.into_iter().collect();
        merged.extend(new_seqs.iter().copied());
        let merged: Vec<i64> = merged.into_iter().collect();

        // `newSummary ? `${row.source_summary}\n${newSummary}`.trim() : row.source_summary`.
        let summary = match new_summary {
            Some(summary) if !summary.is_empty() => {
                format!("{source_summary}\n{summary}").trim().to_string()
            }
            _ => source_summary,
        };

        self.db.execute(
            "UPDATE knowledge_events
             SET source_seq_json = ?, source_summary = ?, updated_at = ?
             WHERE id = ?",
            params![
                serde_json::to_string(&merged)?,
                summary,
                super::now_iso(),
                event_id
            ],
        )?;
        Ok(())
    }

    /// `listEvents` from `eventRepository.ts:80-123`.
    pub fn list_events(
        &self,
        filter: &KnowledgeEventFilter,
        limit: Option<i64>,
    ) -> Result<Vec<KnowledgeEvent>, KnowledgeRepositoryError> {
        let limit = limit.unwrap_or(100);
        let mut conditions = vec!["user_id = ?".to_string(), "persona_id = ?".to_string()];
        let mut values = vec![
            Value::Text(filter.user_id.clone()),
            Value::Text(filter.persona_id.clone()),
        ];

        if let Some(event_type) = filter.event_type.as_deref() {
            conditions.push("event_type = ?".to_string());
            values.push(Value::Text(event_type.to_string()));
        }
        if let Some(speaker_role) = filter.speaker_role {
            conditions.push("speaker_role = ?".to_string());
            values.push(Value::Text(speaker_role.as_str().to_string()));
        }
        if let Some(subject) = filter.subject_entity.as_deref() {
            conditions.push("LOWER(subject_entity) = ?".to_string());
            values.push(Value::Text(subject.to_lowercase()));
        }
        if let Some(counterpart) = filter.counterpart_entity.as_deref() {
            conditions.push("LOWER(counterpart_entity) = ?".to_string());
            values.push(Value::Text(counterpart.to_lowercase()));
        }
        if let Some(relation) = filter.relation_label.as_deref() {
            conditions.push("LOWER(COALESCE(relation_label, '')) = ?".to_string());
            values.push(Value::Text(relation.to_lowercase()));
        }
        if let Some(from) = filter.from.as_deref() {
            conditions.push("end_date >= ?".to_string());
            values.push(Value::Text(from.to_string()));
        }
        if let Some(to) = filter.to.as_deref() {
            conditions.push("start_date <= ?".to_string());
            values.push(Value::Text(to.to_string()));
        }
        values.push(Value::Integer(limit));

        let sql = format!(
            "SELECT * FROM knowledge_events
             WHERE {}
             ORDER BY start_date DESC
             LIMIT ?",
            conditions.join(" AND ")
        );
        let mut statement = self.db.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(values), read_event_row)?;
        let mut events = Vec::new();
        for row in rows {
            events.push(self.map_event(row?));
        }
        Ok(events)
    }

    /// `findOverlappingEvents` from `eventRepository.ts:125-156`.
    pub fn find_overlapping_events(
        &self,
        filter: &KnowledgeEventFilter,
    ) -> Result<Vec<KnowledgeEvent>, KnowledgeRepositoryError> {
        let mut conditions = vec!["user_id = ?".to_string(), "persona_id = ?".to_string()];
        let mut values = vec![
            Value::Text(filter.user_id.clone()),
            Value::Text(filter.persona_id.clone()),
        ];

        if let Some(event_type) = filter.event_type.as_deref() {
            conditions.push("event_type = ?".to_string());
            values.push(Value::Text(event_type.to_string()));
        }
        if let Some(speaker_role) = filter.speaker_role {
            conditions.push("speaker_role = ?".to_string());
            values.push(Value::Text(speaker_role.as_str().to_string()));
        }
        if let Some(counterpart) = filter.counterpart_entity.as_deref() {
            conditions.push("LOWER(counterpart_entity) = ?".to_string());
            values.push(Value::Text(counterpart.to_lowercase()));
        }
        if let (Some(from), Some(to)) = (filter.from.as_deref(), filter.to.as_deref()) {
            // Overlap: existing.start <= candidate.end AND existing.end >= candidate.start
            conditions.push("start_date <= ? AND end_date >= ?".to_string());
            values.push(Value::Text(to.to_string()));
            values.push(Value::Text(from.to_string()));
        }

        let sql = format!(
            "SELECT * FROM knowledge_events
             WHERE {}
             ORDER BY start_date DESC",
            conditions.join(" AND ")
        );
        let mut statement = self.db.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(values), read_event_row)?;
        let mut events = Vec::new();
        for row in rows {
            events.push(self.map_event(row?));
        }
        Ok(events)
    }

    /// `countUniqueDays` from `eventRepository.ts:158-180`.
    pub fn count_unique_days(
        &self,
        filter: &KnowledgeEventFilter,
    ) -> Result<EventAggregationResult, KnowledgeRepositoryError> {
        let events = self.list_events(filter, None)?;
        let mut day_set: BTreeSet<String> = BTreeSet::new();
        let mut real_events: Vec<KnowledgeEvent> = Vec::new();

        for event in &events {
            if event.is_confirmation {
                continue;
            }
            real_events.push(event.clone());

            let (Ok(start), Ok(end)) = (
                NaiveDate::parse_from_str(&event.start_date, "%Y-%m-%d"),
                NaiveDate::parse_from_str(&event.end_date, "%Y-%m-%d"),
            ) else {
                continue;
            };
            let mut day = start;
            while day <= end {
                day_set.insert(format!(
                    "{:04}-{:02}-{:02}",
                    day.year(),
                    day.month(),
                    day.day()
                ));
                match day.succ_opt() {
                    Some(next) => day = next,
                    None => break,
                }
            }
        }

        let unique_days: Vec<String> = day_set.into_iter().collect();
        Ok(EventAggregationResult {
            unique_day_count: unique_days.len(),
            unique_days,
            event_count: real_events.len(),
            events,
        })
    }

    /// `mapEvent` from `eventRepository.ts:182-204`.
    fn map_event(&self, row: EventRow) -> KnowledgeEvent {
        KnowledgeEvent {
            id: row.id,
            user_id: row.user_id,
            persona_id: row.persona_id,
            conversation_id: row.conversation_id,
            event_type: row.event_type,
            speaker_role: SpeakerRole::from_column(&row.speaker_role),
            speaker_entity: row.speaker_entity,
            subject_entity: row.subject_entity,
            counterpart_entity: row.counterpart_entity,
            // `row.relation_label ? String(row.relation_label) : null`.
            relation_label: row.relation_label.filter(|value| !value.is_empty()),
            start_date: row.start_date,
            end_date: row.end_date,
            day_count: row.day_count.unwrap_or(0),
            source_seq_json: row.source_seq_json.unwrap_or_else(|| "[]".to_string()),
            source_summary: row.source_summary.unwrap_or_default(),
            is_confirmation: row.is_confirmation.unwrap_or(0) == 1,
            confidence: row.confidence.unwrap_or(0.0),
            created_at: row.created_at.unwrap_or_default(),
            updated_at: row.updated_at.unwrap_or_default(),
        }
    }
}

/// The columns of a `knowledge_events` row, before `mapEvent` coerces them
/// exactly like the TypeScript reader.
struct EventRow {
    id: String,
    user_id: String,
    persona_id: String,
    conversation_id: String,
    event_type: String,
    speaker_role: String,
    speaker_entity: String,
    subject_entity: String,
    counterpart_entity: String,
    relation_label: Option<String>,
    start_date: String,
    end_date: String,
    day_count: Option<i64>,
    source_seq_json: Option<String>,
    source_summary: Option<String>,
    is_confirmation: Option<i64>,
    confidence: Option<f64>,
    created_at: Option<String>,
    updated_at: Option<String>,
}

/// Reads the `SELECT *` projection by position, matching the table column order
/// declared in [`super::migrations`].
fn read_event_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<EventRow> {
    Ok(EventRow {
        id: row.get(0)?,
        user_id: row.get(1)?,
        persona_id: row.get(2)?,
        conversation_id: row.get(3)?,
        event_type: row.get(4)?,
        speaker_role: row.get(5)?,
        speaker_entity: row.get(6)?,
        subject_entity: row.get(7)?,
        counterpart_entity: row.get(8)?,
        relation_label: row.get(9)?,
        start_date: row.get(10)?,
        end_date: row.get(11)?,
        day_count: row.get(12)?,
        source_seq_json: row.get(13)?,
        source_summary: row.get(14)?,
        is_confirmation: row.get(15)?,
        confidence: row.get(16)?,
        created_at: row.get(17)?,
        updated_at: row.get(18)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{open, OpenOptions};
    use crate::knowledge::repositories::migrations::run_knowledge_migrations;

    fn connection() -> Connection {
        let connection = open(OpenOptions::new(":memory:")).expect("open");
        run_knowledge_migrations(&connection).expect("migrate");
        connection
    }

    fn input(id: &str, start: &str, end: &str) -> UpsertKnowledgeEventInput {
        UpsertKnowledgeEventInput {
            id: id.to_string(),
            user_id: "u-1".to_string(),
            persona_id: "p-1".to_string(),
            conversation_id: "c-1".to_string(),
            event_type: "meeting".to_string(),
            speaker_role: SpeakerRole::Assistant,
            speaker_entity: "persona".to_string(),
            subject_entity: "Max".to_string(),
            counterpart_entity: "Nata".to_string(),
            relation_label: None,
            start_date: start.to_string(),
            end_date: end.to_string(),
            day_count: 1,
            source_seq_json: None,
            source_summary: None,
            is_confirmation: None,
            confidence: None,
        }
    }

    fn filter() -> KnowledgeEventFilter {
        KnowledgeEventFilter {
            user_id: "u-1".to_string(),
            persona_id: "p-1".to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn an_upsert_applies_the_nullish_defaults() {
        let connection = connection();
        let repo = EventRepository::new(&connection);
        repo.upsert_event(&input("e-1", "2026-01-01", "2026-01-01"))
            .expect("upsert");

        let events = repo.list_events(&filter(), None).expect("list");
        assert_eq!(events.len(), 1);
        let event = &events[0];
        assert_eq!(event.speaker_role, SpeakerRole::Assistant);
        assert_eq!(event.source_seq_json, "[]");
        assert_eq!(event.source_summary, "");
        assert!(!event.is_confirmation);
        assert_eq!(event.confidence, 0.8);
        assert!(event.relation_label.is_none());
    }

    #[test]
    fn a_conflicting_upsert_updates_the_row() {
        let connection = connection();
        let repo = EventRepository::new(&connection);
        repo.upsert_event(&input("e-1", "2026-01-01", "2026-01-01"))
            .expect("first");

        let mut second = input("e-2", "2026-01-01", "2026-01-01");
        second.speaker_role = SpeakerRole::User;
        second.confidence = Some(0.2);
        repo.upsert_event(&second).expect("second");

        let events = repo.list_events(&filter(), None).expect("list");
        assert_eq!(events.len(), 1, "the unique tuple updates in place");
        assert_eq!(events[0].id, "e-1", "the original id is kept");
        assert_eq!(events[0].speaker_role, SpeakerRole::User);
        assert_eq!(events[0].confidence, 0.2);
    }

    #[test]
    fn append_event_sources_merges_sorts_and_summarizes() {
        let connection = connection();
        let repo = EventRepository::new(&connection);
        repo.upsert_event(&input("e-1", "2026-01-01", "2026-01-01"))
            .expect("upsert");

        repo.append_event_sources("e-1", &[5, 3], Some("first note"))
            .expect("append");
        repo.append_event_sources("e-1", &[3, 9], Some("second note"))
            .expect("append");

        let events = repo.list_events(&filter(), None).expect("list");
        assert_eq!(events[0].source_seq_json, "[3,5,9]");
        assert_eq!(events[0].source_summary, "first note\nsecond note");

        // An unknown id is a no-op, not an error.
        repo.append_event_sources("missing", &[1], None)
            .expect("no-op");
    }

    #[test]
    fn count_unique_days_expands_the_inclusive_window() {
        let connection = connection();
        let repo = EventRepository::new(&connection);
        repo.upsert_event(&input("e-1", "2026-01-01", "2026-01-03"))
            .expect("event");
        let mut confirmation = input("e-2", "2026-02-01", "2026-02-05");
        confirmation.is_confirmation = Some(true);
        repo.upsert_event(&confirmation).expect("confirmation");

        let result = repo.count_unique_days(&filter()).expect("aggregate");
        assert_eq!(
            result.unique_days,
            vec!["2026-01-01", "2026-01-02", "2026-01-03"]
        );
        assert_eq!(result.unique_day_count, 3);
        assert_eq!(
            result.event_count, 1,
            "the confirmation is not a real event"
        );
        assert_eq!(result.events.len(), 2, "but it stays in the events list");
    }

    #[test]
    fn the_overlap_filter_keeps_intersecting_windows() {
        let connection = connection();
        let repo = EventRepository::new(&connection);
        repo.upsert_event(&input("e-1", "2026-01-01", "2026-01-10"))
            .expect("inside");
        repo.upsert_event(&input("e-2", "2026-03-01", "2026-03-05"))
            .expect("outside");

        let mut overlap = filter();
        overlap.from = Some("2026-01-05".to_string());
        overlap.to = Some("2026-01-20".to_string());
        let events = repo.find_overlapping_events(&overlap).expect("overlap");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, "e-1");
    }
}
