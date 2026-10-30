//! Port of `src/server/knowledge/repositories/checkpointRepository.ts`.
//!
//! | TypeScript member                                   | Rust member |
//! | --------------------------------------------------- | ----------- |
//! | `checkpointRepository.ts:8` (class)                  | [`CheckpointRepository`] |
//! | `checkpointRepository.ts:11-46` (`getIngestionCheckpoint`) | [`CheckpointRepository::get_ingestion_checkpoint`] |
//! | `checkpointRepository.ts:48-71` (`upsertIngestionCheckpoint`) | [`CheckpointRepository::upsert_ingestion_checkpoint`] |
//!
//! # The two-argument scope
//!
//! `getIngestionCheckpoint(conversationId, userIdOrPersonaId, personaId?)` is a
//! convenience overload: when `personaIdArg` is absent the caller passed a
//! persona id, not a user id. `userId` is then the legacy local user and
//! `personaId` is the argument itself (`checkpointRepository.ts:16-17`). The port
//! reproduces that branch, including the `||` fallback for an empty string.

use rusqlite::{params, Connection, OptionalExtension};

use super::KnowledgeRepositoryError;
use crate::knowledge::repository::{KnowledgeCheckpoint, UpsertKnowledgeCheckpointInput};
use crate::messages_store::LEGACY_MESSAGES_USER_ID as LEGACY_LOCAL_USER_ID;

/// `CheckpointRepository` from `checkpointRepository.ts:8`.
pub struct CheckpointRepository<'a> {
    db: &'a Connection,
}

impl<'a> CheckpointRepository<'a> {
    pub fn new(db: &'a Connection) -> Self {
        Self { db }
    }

    /// `getIngestionCheckpoint` from `checkpointRepository.ts:11-46`.
    pub fn get_ingestion_checkpoint(
        &self,
        conversation_id: &str,
        user_id_or_persona_id: &str,
        persona_id_arg: Option<&str>,
    ) -> Result<Option<KnowledgeCheckpoint>, KnowledgeRepositoryError> {
        // `personaIdArg ? userIdOrPersonaId : LEGACY_LOCAL_USER_ID`
        // (`checkpointRepository.ts:16`): with three arguments the *second*
        // argument is the user id; the two-argument form carries a persona id
        // and falls back to the legacy local user.
        let persona_id_arg = persona_id_arg.filter(|value| !value.is_empty());
        let user_id = match persona_id_arg {
            Some(_) => user_id_or_persona_id,
            None => LEGACY_LOCAL_USER_ID,
        };
        // `personaIdArg || userIdOrPersonaId`.
        let persona_id = persona_id_arg.unwrap_or(user_id_or_persona_id);

        let row = self
            .db
            .query_row(
                "
                SELECT conversation_id, user_id, persona_id, last_seq, updated_at
                FROM knowledge_ingestion_checkpoints
                WHERE conversation_id = ? AND user_id = ? AND persona_id = ?
                LIMIT 1
              ",
                params![conversation_id, user_id, persona_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<i64>>(3)?,
                        row.get::<_, String>(4)?,
                    ))
                },
            )
            .optional()?;

        let Some((conversation_id, user_id, persona_id, last_seq, updated_at)) = row else {
            return Ok(None);
        };

        Ok(Some(KnowledgeCheckpoint {
            conversation_id,
            user_id: Some(user_id),
            persona_id,
            // `Number(row.last_seq || 0)`.
            last_seq: last_seq.unwrap_or(0),
            updated_at,
        }))
    }

    /// `upsertIngestionCheckpoint` from `checkpointRepository.ts:48-71`.
    pub fn upsert_ingestion_checkpoint(
        &self,
        input: &UpsertKnowledgeCheckpointInput,
    ) -> Result<KnowledgeCheckpoint, KnowledgeRepositoryError> {
        let now = super::now_iso();
        // `String(input.userId || LEGACY).trim() || LEGACY`.
        let user_id = input
            .user_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(LEGACY_LOCAL_USER_ID)
            .to_string();
        // `Math.max(0, Math.floor(Number(input.lastSeq || 0)))`.
        let last_seq = input.last_seq.max(0);

        self.db.execute(
            "
            INSERT INTO knowledge_ingestion_checkpoints (conversation_id, user_id, persona_id, last_seq, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(conversation_id, user_id, persona_id)
            DO UPDATE SET last_seq = excluded.last_seq, updated_at = excluded.updated_at
          ",
            params![
                input.conversation_id,
                user_id,
                input.persona_id,
                last_seq,
                now
            ],
        )?;

        Ok(KnowledgeCheckpoint {
            conversation_id: input.conversation_id.clone(),
            user_id: Some(user_id),
            persona_id: input.persona_id.clone(),
            last_seq,
            updated_at: now,
        })
    }
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

    fn input(conversation: &str, persona: &str, last_seq: i64) -> UpsertKnowledgeCheckpointInput {
        UpsertKnowledgeCheckpointInput {
            conversation_id: conversation.to_string(),
            user_id: None,
            persona_id: persona.to_string(),
            last_seq,
        }
    }

    #[test]
    fn the_two_argument_form_reads_the_legacy_local_user() {
        let connection = connection();
        let repo = CheckpointRepository::new(&connection);

        let written = repo
            .upsert_ingestion_checkpoint(&input("c-1", "p-1", 7))
            .expect("upsert");
        assert_eq!(written.user_id.as_deref(), Some(LEGACY_LOCAL_USER_ID));
        assert_eq!(written.last_seq, 7);

        // `getIngestionCheckpoint('c-1', 'p-1')` — persona only.
        let found = repo
            .get_ingestion_checkpoint("c-1", "p-1", None)
            .expect("get")
            .expect("some");
        assert_eq!(found.persona_id, "p-1");
        assert_eq!(found.user_id.as_deref(), Some(LEGACY_LOCAL_USER_ID));
        assert_eq!(found.last_seq, 7);
    }

    #[test]
    fn the_three_argument_form_matches_the_stored_user() {
        let connection = connection();
        let repo = CheckpointRepository::new(&connection);

        repo.upsert_ingestion_checkpoint(&input("c-1", "p-1", 3))
            .expect("upsert");

        let found = repo
            .get_ingestion_checkpoint("c-1", "u-9", Some("p-1"))
            .expect("get");
        assert!(
            found.is_none(),
            "a different user_id must not match the legacy row"
        );

        let mut scoped = input("c-1", "p-1", 3);
        scoped.user_id = Some("u-9".to_string());
        repo.upsert_ingestion_checkpoint(&scoped).expect("upsert");

        let found = repo
            .get_ingestion_checkpoint("c-1", "u-9", Some("p-1"))
            .expect("get")
            .expect("some");
        assert_eq!(found.user_id.as_deref(), Some("u-9"));
    }

    #[test]
    fn a_second_upsert_updates_the_checkpoint() {
        let connection = connection();
        let repo = CheckpointRepository::new(&connection);

        repo.upsert_ingestion_checkpoint(&input("c-1", "p-1", 1))
            .expect("first");
        repo.upsert_ingestion_checkpoint(&input("c-1", "p-1", 42))
            .expect("second");

        let found = repo
            .get_ingestion_checkpoint("c-1", "p-1", None)
            .expect("get")
            .expect("some");
        assert_eq!(found.last_seq, 42);

        let rows: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM knowledge_ingestion_checkpoints",
                [],
                |row| row.get(0),
            )
            .expect("count");
        assert_eq!(
            rows, 1,
            "the conflict clause upserts, it does not insert twice"
        );
    }

    #[test]
    fn a_blank_user_id_falls_back_and_a_negative_seq_is_clamped() {
        let connection = connection();
        let repo = CheckpointRepository::new(&connection);

        let mut blank = input("c-1", "p-1", -5);
        blank.user_id = Some("   ".to_string());
        let written = repo.upsert_ingestion_checkpoint(&blank).expect("upsert");
        assert_eq!(written.user_id.as_deref(), Some(LEGACY_LOCAL_USER_ID));
        assert_eq!(written.last_seq, 0);
    }

    #[test]
    fn a_missing_checkpoint_is_none() {
        let connection = connection();
        let repo = CheckpointRepository::new(&connection);
        assert!(repo
            .get_ingestion_checkpoint("missing", "p-1", None)
            .expect("get")
            .is_none());
    }
}
