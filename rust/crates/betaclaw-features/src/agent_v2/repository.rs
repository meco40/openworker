//! Port of `src/server/agent-v2/repository.ts` and `src/server/agent-v2/repository/index.ts`:
//! the `AgentV2Repository` facade over the per-table modules.
//!
//! The constructor takes a path. [`AgentV2Repository::open_default`] resolves
//! `MESSAGES_DB_PATH`, as the TypeScript constructor does. The process-wide singleton
//! of `runtime.ts` is not here; it belongs in `state.rs`.
//!
//! Each write runs in one transaction, which is what `db.transaction(...)` does in
//! the TypeScript. Reads run on the same connection without one.

use std::collections::HashSet;
use std::sync::{Mutex, MutexGuard, PoisonError};

use chrono::{DateTime, Utc};
use rusqlite::Connection;

use super::command_repository;
use super::errors::AgentV2Error;
use super::event_repository;
use super::extension_repository;
use super::migrations;
use super::recovery_repository;
use super::session_repository;
use super::signing_key_repository;
use super::types::{
    AgentSessionSnapshot, AppendEventInput, CompleteCommandInput, CompleteCommandResult,
    CreateSessionInput, CreateSessionResult, EnqueueAgentCommandInput, EnqueueAgentCommandResult,
    EventEnvelope, ExtensionManifestV1, RecoveryResult, ReplayEventsInput, SigningKeyRecord,
    StartNextCommandResult, UpsertSigningKeyInput,
};
use crate::db::{self, OpenOptions};
use crate::messages_store::default_messages_db_path;

pub struct AgentV2Repository {
    connection: Mutex<Connection>,
}

impl AgentV2Repository {
    /// Opens the database at `db_path` with the shared SQLite pragmas and runs the
    /// migrations, as the TypeScript constructor does.
    pub fn open(db_path: &str) -> Result<Self, AgentV2Error> {
        let connection = db::open(OpenOptions::new(db_path))?;
        migrations::run_migrations(&connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    /// `new AgentV2Repository()`: `MESSAGES_DB_PATH || .local/messages.db`.
    pub fn open_default() -> Result<Self, AgentV2Error> {
        Self::open(&default_messages_db_path())
    }

    pub fn in_memory() -> Result<Self, AgentV2Error> {
        Self::open(":memory:")
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        self.connection
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// A write inside one transaction. The transaction commits when `f` succeeds
    /// and rolls back when it fails.
    fn write<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, AgentV2Error>,
    ) -> Result<T, AgentV2Error> {
        let mut connection = self.lock();
        let transaction = connection.transaction()?;
        let value = f(&transaction)?;
        transaction.commit()?;
        Ok(value)
    }

    fn read<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, AgentV2Error>,
    ) -> Result<T, AgentV2Error> {
        let connection = self.lock();
        f(&connection)
    }

    // Session methods

    pub fn create_session(
        &self,
        input: &CreateSessionInput,
    ) -> Result<CreateSessionResult, AgentV2Error> {
        self.write(|connection| session_repository::create_session(connection, input))
    }

    pub fn get_session(
        &self,
        session_id: &str,
        user_id: &str,
    ) -> Result<Option<AgentSessionSnapshot>, AgentV2Error> {
        self.read(|connection| session_repository::get_session(connection, session_id, user_id))
    }

    pub fn list_sessions(
        &self,
        user_id: &str,
        limit: Option<i64>,
    ) -> Result<Vec<AgentSessionSnapshot>, AgentV2Error> {
        self.read(|connection| session_repository::list_sessions(connection, user_id, limit))
    }

    // Command methods

    pub fn count_queued_commands(
        &self,
        session_id: &str,
        user_id: &str,
    ) -> Result<i64, AgentV2Error> {
        self.read(|connection| {
            command_repository::count_queued_commands(connection, session_id, user_id)
        })
    }

    pub fn has_queued_abort(&self, session_id: &str) -> Result<bool, AgentV2Error> {
        self.read(|connection| command_repository::has_queued_abort(connection, session_id))
    }

    pub fn enqueue_command(
        &self,
        input: &EnqueueAgentCommandInput,
    ) -> Result<EnqueueAgentCommandResult, AgentV2Error> {
        self.write(|connection| command_repository::enqueue_command(connection, input))
    }

    pub fn start_next_queued_command(
        &self,
        session_id: &str,
        user_id: &str,
    ) -> Result<Option<StartNextCommandResult>, AgentV2Error> {
        self.write(|connection| {
            command_repository::start_next_queued_command(connection, session_id, user_id)
        })
    }

    pub fn complete_command(
        &self,
        input: &CompleteCommandInput,
    ) -> Result<CompleteCommandResult, AgentV2Error> {
        self.write(|connection| command_repository::complete_command(connection, input))
    }

    // Event methods

    pub fn append_event(&self, input: &AppendEventInput) -> Result<EventEnvelope, AgentV2Error> {
        self.write(|connection| event_repository::append_event(connection, input))
    }

    /// Replays the events after `from_seq`, with the clock at the call.
    pub fn replay_events(
        &self,
        input: &ReplayEventsInput,
    ) -> Result<Vec<EventEnvelope>, AgentV2Error> {
        self.read(|connection| event_repository::replay_events(connection, input, Utc::now()))
    }

    pub fn get_command_result(
        &self,
        command_id: &str,
        session_id: &str,
    ) -> Result<Option<EventEnvelope>, AgentV2Error> {
        self.read(|connection| {
            event_repository::get_command_result(connection, command_id, session_id)
        })
    }

    /// Deletes the events older than the retention window before `now`.
    pub fn prune_expired_events(&self, now: DateTime<Utc>) -> Result<usize, AgentV2Error> {
        self.write(|connection| event_repository::prune_expired_events(connection, now))
    }

    // Recovery methods

    pub fn recover_running_commands_on_startup(&self) -> Result<RecoveryResult, AgentV2Error> {
        self.write(recovery_repository::recover_running_commands_on_startup)
    }

    // Extension methods

    pub fn upsert_extension_manifest(
        &self,
        manifest: &ExtensionManifestV1,
        enabled: bool,
    ) -> Result<(), AgentV2Error> {
        self.write(|connection| {
            extension_repository::upsert_extension_manifest(connection, manifest, enabled)
        })
    }

    pub fn list_enabled_extension_manifests(
        &self,
    ) -> Result<Vec<ExtensionManifestV1>, AgentV2Error> {
        self.read(extension_repository::list_enabled_extension_manifests)
    }

    // Signing key methods

    pub fn upsert_signing_key(&self, input: &UpsertSigningKeyInput) -> Result<(), AgentV2Error> {
        self.write(|connection| signing_key_repository::upsert_signing_key(connection, input))
    }

    pub fn list_signing_keys(&self) -> Result<Vec<SigningKeyRecord>, AgentV2Error> {
        self.read(signing_key_repository::list_signing_keys)
    }

    pub fn revoke_signature(
        &self,
        signature_digest: &str,
        reason: Option<&str>,
    ) -> Result<(), AgentV2Error> {
        self.write(|connection| {
            signing_key_repository::revoke_signature(connection, signature_digest, reason)
        })
    }

    pub fn list_revoked_signature_digests(&self) -> Result<HashSet<String>, AgentV2Error> {
        self.read(signing_key_repository::list_revoked_signature_digests)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_v2::errors::ErrorCode;
    use crate::agent_v2::types::{
        CommandStatus, CommandType, EventType, JsonObject, SessionStatus,
    };
    use chrono::Duration;
    use serde_json::json;

    fn session(repository: &AgentV2Repository, user: &str) -> String {
        repository
            .create_session(&CreateSessionInput {
                user_id: user.into(),
                conversation_id: "conv".into(),
                status: None,
            })
            .expect("create session")
            .session
            .id
    }

    fn enqueue(
        repository: &AgentV2Repository,
        session_id: &str,
        user: &str,
        command_type: CommandType,
        priority: i64,
        idempotency_key: Option<&str>,
    ) -> EnqueueAgentCommandResult {
        repository
            .enqueue_command(&EnqueueAgentCommandInput {
                session_id: session_id.into(),
                user_id: user.into(),
                command_type,
                priority,
                payload: JsonObject::new(),
                idempotency_key: idempotency_key.map(str::to_string),
                command_id: None,
            })
            .expect("enqueue")
    }

    #[test]
    fn enforces_idempotency_per_session_and_command_type() {
        let repository = AgentV2Repository::in_memory().expect("open");
        let session_id = session(&repository, "user-1");

        let first = enqueue(
            &repository,
            &session_id,
            "user-1",
            CommandType::Input,
            100,
            Some("k-1"),
        );
        let second = enqueue(
            &repository,
            &session_id,
            "user-1",
            CommandType::Input,
            100,
            Some("k-1"),
        );

        assert!(!first.reused);
        assert!(second.reused);
        assert_eq!(second.command.id, first.command.id);
        assert!(second.events.is_empty());
    }

    #[test]
    fn starts_queued_commands_by_priority_then_age() {
        let repository = AgentV2Repository::in_memory().expect("open");
        let session_id = session(&repository, "user-2");
        enqueue(
            &repository,
            &session_id,
            "user-2",
            CommandType::FollowUp,
            200,
            None,
        );
        enqueue(
            &repository,
            &session_id,
            "user-2",
            CommandType::Steer,
            300,
            None,
        );

        let started = repository
            .start_next_queued_command(&session_id, "user-2")
            .expect("start")
            .expect("one command");
        assert_eq!(started.command.command_type, CommandType::Steer);
        assert_eq!(started.session.status, SessionStatus::Running);
        assert_eq!(started.session.queue_depth, 1);
        assert_eq!(started.session.running_command_id, Some(started.command.id));
    }

    #[test]
    fn replay_returns_events_after_the_cursor_and_respects_the_limit() {
        let repository = AgentV2Repository::in_memory().expect("open");
        let session_id = session(&repository, "user-4");
        enqueue(
            &repository,
            &session_id,
            "user-4",
            CommandType::Input,
            100,
            None,
        );
        enqueue(
            &repository,
            &session_id,
            "user-4",
            CommandType::Input,
            100,
            None,
        );

        let after_first = repository
            .replay_events(&ReplayEventsInput {
                session_id: session_id.clone(),
                user_id: "user-4".into(),
                from_seq: 1,
                limit: None,
            })
            .expect("replay");
        // Seq 1 is the session start; each enqueue writes two events.
        let seqs: Vec<i64> = after_first.iter().map(|event| event.seq).collect();
        assert_eq!(seqs, vec![2, 3, 4, 5]);

        let limited = repository
            .replay_events(&ReplayEventsInput {
                session_id,
                user_id: "user-4".into(),
                from_seq: 1,
                limit: Some(1),
            })
            .expect("limited");
        assert_eq!(limited.len(), 1);
        assert_eq!(limited[0].seq, 2);
    }

    #[test]
    fn replay_window_expires_after_retention_prune() {
        let repository = AgentV2Repository::in_memory().expect("open");
        let session_id = session(&repository, "user-3");
        enqueue(
            &repository,
            &session_id,
            "user-3",
            CommandType::Input,
            100,
            None,
        );

        let pruned = repository
            .prune_expired_events(Utc::now() + Duration::hours(25))
            .expect("prune");
        assert!(pruned > 0);

        let error = repository
            .replay_events(&ReplayEventsInput {
                session_id,
                user_id: "user-3".into(),
                from_seq: 0,
                limit: None,
            })
            .expect_err("expired");
        assert_eq!(error.code(), Some(ErrorCode::ReplayWindowExpired));
    }

    #[test]
    fn a_failed_completion_sets_the_error_state_and_is_findable_by_command() {
        let repository = AgentV2Repository::in_memory().expect("open");
        let session_id = session(&repository, "user-5");
        let queued = enqueue(
            &repository,
            &session_id,
            "user-5",
            CommandType::Input,
            100,
            None,
        );
        repository
            .start_next_queued_command(&session_id, "user-5")
            .expect("start");

        let completed = repository
            .complete_command(&CompleteCommandInput {
                session_id: session_id.clone(),
                user_id: "user-5".into(),
                command_id: queued.command.id.clone(),
                status: CommandStatus::Failed,
                result: None,
                error_code: Some("MODEL_DOWN".into()),
                error_message: Some("model unreachable".into()),
            })
            .expect("complete");

        assert_eq!(completed.session.status, SessionStatus::Error);
        assert_eq!(
            completed.session.last_error.as_deref(),
            Some("model unreachable")
        );
        assert_eq!(completed.session.running_command_id, None);
        assert_eq!(completed.events[0].event_type, EventType::Error);
        assert_eq!(
            completed.events[0].payload["errorCode"],
            json!("MODEL_DOWN")
        );

        let terminal = repository
            .get_command_result(&queued.command.id, &session_id)
            .expect("lookup")
            .expect("terminal event");
        assert_eq!(terminal.event_type, EventType::Error);
    }

    #[test]
    fn a_completed_command_stores_its_result_object() {
        let repository = AgentV2Repository::in_memory().expect("open");
        let session_id = session(&repository, "user-6");
        let queued = enqueue(
            &repository,
            &session_id,
            "user-6",
            CommandType::Input,
            100,
            None,
        );
        repository
            .start_next_queued_command(&session_id, "user-6")
            .expect("start");

        let mut result = JsonObject::new();
        result.insert("answer".into(), json!(42));
        let completed = repository
            .complete_command(&CompleteCommandInput {
                session_id,
                user_id: "user-6".into(),
                command_id: queued.command.id.clone(),
                status: CommandStatus::Completed,
                result: Some(result),
                error_code: None,
                error_message: None,
            })
            .expect("complete");

        assert_eq!(completed.session.status, SessionStatus::Idle);
        assert_eq!(completed.session.completed_at, None);
        assert_eq!(
            completed.command.result.expect("stored")["answer"],
            json!(42)
        );
    }

    #[test]
    fn sessions_and_commands_are_scoped_to_their_owner() {
        let repository = AgentV2Repository::in_memory().expect("open");
        let session_id = session(&repository, "owner");

        assert!(repository
            .get_session(&session_id, "stranger")
            .expect("get")
            .is_none());
        let error = repository
            .enqueue_command(&EnqueueAgentCommandInput {
                session_id,
                user_id: "stranger".into(),
                command_type: CommandType::Input,
                priority: 100,
                payload: JsonObject::new(),
                idempotency_key: None,
                command_id: None,
            })
            .expect_err("not the owner");
        assert_eq!(error.code(), Some(ErrorCode::NotFound));
    }

    #[test]
    fn startup_recovery_marks_running_commands_recoverable() {
        let repository = AgentV2Repository::in_memory().expect("open");
        let session_id = session(&repository, "user-7");
        enqueue(
            &repository,
            &session_id,
            "user-7",
            CommandType::Input,
            100,
            None,
        );
        repository
            .start_next_queued_command(&session_id, "user-7")
            .expect("start");

        let recovered = repository
            .recover_running_commands_on_startup()
            .expect("recover");
        assert_eq!(recovered.recovered_commands, 1);
        assert_eq!(recovered.touched_sessions, 1);

        let session = repository
            .get_session(&session_id, "user-7")
            .expect("get")
            .expect("session");
        assert_eq!(session.status, SessionStatus::ErrorRecoverable);
        assert_eq!(session.running_command_id, None);
    }

    #[test]
    fn signing_keys_and_revocations_are_persisted() {
        let repository = AgentV2Repository::in_memory().expect("open");
        repository
            .upsert_signing_key(&UpsertSigningKeyInput {
                key_id: "key-1".into(),
                algorithm: "RSA-SHA256".into(),
                public_key_pem: "pem".into(),
                status: None,
                rotated_at: None,
                revoked_at: None,
            })
            .expect("key");
        repository
            .revoke_signature("digest-1", Some("test"))
            .expect("revoke");

        assert_eq!(repository.list_signing_keys().expect("keys").len(), 1);
        assert!(repository
            .list_revoked_signature_digests()
            .expect("digests")
            .contains("digest-1"));
    }
}
