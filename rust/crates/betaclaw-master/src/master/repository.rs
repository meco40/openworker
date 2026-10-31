//! Master persistence layer — module root of `src/server/master/repository/`
//! plus the `MasterRepository` interface of its sibling `repository.ts`.
//!
//! The directory mirrors the TypeScript tree:
//!
//! | Rust | TypeScript |
//! | --- | --- |
//! | [`helpers`] | `repository/helpers.ts` |
//! | [`mappers`] | `repository/mappers.ts` |
//! | [`runs_store`] | `repository/runs.store.ts` |
//! | [`notes_store`] | `repository/notes.store.ts` |
//! | [`reminders_store`] | `repository/reminders.store.ts` |
//! | [`approvals_store`] | `repository/approvals.store.ts` |
//! | [`audit_store`] | `repository/audit.store.ts` |
//! | [`delegation_store`] | `repository/delegation.store.ts` |
//! | [`governance_store`] | `repository/governance.store.ts` |
//! | [`sessions_store`] | `repository/sessions.store.ts` |
//! | [`secrets_store`] | `repository/secrets.store.ts` |
//! | [`tool_policy_store`] | `repository/toolPolicy.store.ts` |
//! | [`toolforge_store`] | `repository/toolforge.store.ts` |
//! | [`migration_store`] | `repository/migration.store.ts` |
//! | [`scopes_store`] | `repository/scopes.store.ts` |
//! | [`db`] | `repository/db.ts` |
//! | [`sqlite_master_repository`] | `repository/sqliteMasterRepository.ts` |
//! | [`MasterRepository`] | `repository.ts` (this module) |
//!
//! # Layout deviation: `repository.rs` instead of `repository/mod.rs`
//!
//! TypeScript keeps `master/repository.ts` *next to* the `master/repository/`
//! directory. Rust has the same two shapes, but `repository.rs` and
//! `repository/mod.rs` may not coexist (E0761). The lane therefore uses the
//! 2018-edition form — `repository.rs` as the module root with `repository/*.rs`
//! as its children — so the trait file really is the sibling of the store
//! directory, exactly like the TypeScript original. Nothing else changes: every
//! submodule path (`crate::master::repository::runs_store`, …) is unaffected.
//!
//! # Why the trait returns `rusqlite::Result`
//!
//! The TypeScript interface is synchronous and throws. S9 persists exclusively
//! through SQLite (`docs/RUST_MIGRATION.md:88`, plan §4.3), the stores already
//! return `rusqlite::Result`, and the consumers in this package are generic over
//! [`MasterRepository`]. Keeping `rusqlite::Result` in the trait makes the seam
//! the same shape as its only implementation instead of adding a wrapper error
//! layer that would have to be unwrapped again at every call site. The two
//! columns the TypeScript `as`-casts keep as `String` stay `String` here as well
//! (see [`crate::master::types`]). `upsertApprovalRule`/`getApprovalRule` carry
//! the decision as `&str` because [`crate::master::types::ApprovalDecision`] is
//! the catalogue enum while the column is the raw text the mapper reads back.
//!
//! # `close(self)` is not object-safe
//!
//! `close(): void` consumes the facade, so [`MasterRepository::close`] is
//! declared `where Self: Sized`. Services that only read and write use the
//! remaining methods through a generic parameter or `&dyn MasterRepository`.
//!
//! Everything here speaks to the same SQLite file the TypeScript
//! `createMasterSqliteDb` opens (`repository/db.ts:7-11`) and runs
//! `runMasterMigrations` from [`crate::master::migrations`] against. The stores
//! are added package by package; each one names its `.store.ts` source in its
//! module header, exactly like the S1/S3 stores.

pub mod approvals_store;
pub mod audit_store;
pub mod db;
pub mod delegation_store;
pub mod governance_store;
pub mod helpers;
pub mod mappers;
pub mod migration_store;
pub mod notes_store;
pub mod reminders_store;
pub mod runs_store;
pub mod scopes_store;
pub mod secrets_store;
pub mod sessions_store;
pub mod sqlite_master_repository;
pub mod tool_policy_store;
pub mod toolforge_store;

use crate::master::types::{
    MasterActionLedgerEntry, MasterApprovalRequest, MasterAuditEvent, MasterCapabilityProposal,
    MasterCapabilityScore, MasterConnectorSecret, MasterDelegationEvent, MasterDelegationJob,
    MasterFeedback, MasterNote, MasterReminder, MasterRun, MasterRunCreateInput, MasterStep,
    MasterSubagentSession, MasterToolForgeArtifact, MasterToolPolicy, WorkspaceScope,
};

pub use helpers::{now_iso, parse_json_array, to_bool, SqlPatch};

use approvals_store::{ApprovalPatch, MasterApprovalRequestInput};
use audit_store::MasterAuditEventInput;
use delegation_store::{DelegationPatch, MasterDelegationEventInput, MasterDelegationJobInput};
use governance_store::{MasterActionLedgerInput, MasterCapabilityProposalInput};
use notes_store::{MasterNoteInput, NotePatch};
use reminders_store::{MasterReminderInput, ReminderPatch};
use runs_store::{MasterFeedbackInput, MasterStepInput, RunPatch};
use secrets_store::MasterConnectorSecretInput;
use sessions_store::{MasterSubagentSessionInput, SubagentSessionPatch};
use tool_policy_store::MasterToolPolicyInput;
use toolforge_store::{MasterToolForgeArtifactInput, ToolForgePatch};

/// Rust stand-in for the TypeScript non-null assertion `expr!`.
///
/// The stores insert a row and then read it back with `SELECT *`; the `!` says
/// "the row is there". If it is not, the port fails loudly instead of
/// dereferencing a `null` the way the source would.
pub(crate) fn required<T>(value: Option<T>) -> rusqlite::Result<T> {
    value.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

/// `column = ?` for a required text column. Shared plumbing for the dynamic
/// `UPDATE` builders; not a port of a TypeScript helper.
pub(crate) fn push_text(
    assignments: &mut Vec<String>,
    values: &mut Vec<rusqlite::types::Value>,
    column: &str,
    value: &str,
) {
    assignments.push(format!("{column} = ?"));
    values.push(rusqlite::types::Value::Text(value.to_string()));
}

/// `column = ?` for a nullable text column (`value ?? null`).
pub(crate) fn push_optional_text(
    assignments: &mut Vec<String>,
    values: &mut Vec<rusqlite::types::Value>,
    column: &str,
    value: &Option<String>,
) {
    assignments.push(format!("{column} = ?"));
    values.push(match value {
        Some(text) => rusqlite::types::Value::Text(text.clone()),
        None => rusqlite::types::Value::Null,
    });
}

/// `MasterRepository` from `src/server/master/repository.ts:23-221`.
///
/// The interface the Master services are written against. It is declared in the
/// same order as the TypeScript members, and every method keeps the source's
/// two-shape convention:
///
/// * a *create* returns the freshly inserted row (the store re-selects it),
/// * a *get*/*update* on a missing row returns `None` (the TypeScript
///   `| null`), which is why the port never collapses the two into an error.
///
/// The `limit` parameters are explicit here even though the TypeScript stores
/// default them (`listRuns` 50, `listNotes` 100, `listReminders` 100 — see
/// `runs.store.ts:41`, `notes.store.ts:35`, `reminders.store.ts:40`). The port
/// materialises the default at the call site and names it there, so a reader can
/// still see which value a limit-less TypeScript call really used.
///
/// `Send + Sync`: the bridged futures of the runtime capture `&dyn MasterRepository`
/// and must be `Send` for the Axum handlers. The SQLite implementation therefore
/// guards its connection with a `Mutex`.
pub trait MasterRepository: Send + Sync {
    // ─── Runs ──────────────────────────────────────────────────────────────

    /// `createRun` — `repository.ts:24`.
    fn create_run(&self, input: &MasterRunCreateInput) -> rusqlite::Result<MasterRun>;
    /// `getRun` — `repository.ts:25`.
    fn get_run(&self, scope: &WorkspaceScope, run_id: &str) -> rusqlite::Result<Option<MasterRun>>;
    /// `listRuns` — `repository.ts:26`.
    fn list_runs(&self, scope: &WorkspaceScope, limit: i64) -> rusqlite::Result<Vec<MasterRun>>;
    /// `updateRun` — `repository.ts:27`.
    fn update_run(
        &self,
        scope: &WorkspaceScope,
        run_id: &str,
        patch: &RunPatch,
    ) -> rusqlite::Result<Option<MasterRun>>;
    /// `claimRun` — `repository.ts:28-33`.
    fn claim_run(
        &self,
        scope: &WorkspaceScope,
        run_id: &str,
        owner_id: &str,
        lease_expires_at: &str,
    ) -> rusqlite::Result<Option<MasterRun>>;
    /// `renewRunLease` — `repository.ts:34-40`.
    fn renew_run_lease(
        &self,
        scope: &WorkspaceScope,
        run_id: &str,
        owner_id: &str,
        lease_expires_at: &str,
        heartbeat_at: &str,
    ) -> rusqlite::Result<Option<MasterRun>>;
    /// `releaseRunLease` — `repository.ts:41`.
    fn release_run_lease(
        &self,
        scope: &WorkspaceScope,
        run_id: &str,
        owner_id: &str,
    ) -> rusqlite::Result<Option<MasterRun>>;

    /// `appendStep` — `repository.ts:43-47`.
    fn append_step(
        &self,
        scope: &WorkspaceScope,
        run_id: &str,
        step: &MasterStepInput,
    ) -> rusqlite::Result<MasterStep>;
    /// `listSteps` — `repository.ts:48`.
    fn list_steps(&self, scope: &WorkspaceScope, run_id: &str)
        -> rusqlite::Result<Vec<MasterStep>>;

    /// `addFeedback` — `repository.ts:50-53`.
    fn add_feedback(
        &self,
        scope: &WorkspaceScope,
        feedback: &MasterFeedbackInput,
    ) -> rusqlite::Result<MasterFeedback>;

    // ─── Notes ─────────────────────────────────────────────────────────────

    /// `createNote` — `repository.ts:55-58`.
    fn create_note(
        &self,
        scope: &WorkspaceScope,
        input: &MasterNoteInput,
    ) -> rusqlite::Result<MasterNote>;
    /// `listNotes` — `repository.ts:59` (TypeScript default `limit = 100`).
    fn list_notes(&self, scope: &WorkspaceScope, limit: i64) -> rusqlite::Result<Vec<MasterNote>>;
    /// `updateNote` — `repository.ts:60-64`.
    fn update_note(
        &self,
        scope: &WorkspaceScope,
        note_id: &str,
        patch: &NotePatch,
    ) -> rusqlite::Result<Option<MasterNote>>;
    /// `deleteNote` — `repository.ts:65`.
    fn delete_note(&self, scope: &WorkspaceScope, note_id: &str) -> rusqlite::Result<bool>;

    // ─── Reminders ─────────────────────────────────────────────────────────

    /// `createReminder` — `repository.ts:67-70`.
    fn create_reminder(
        &self,
        scope: &WorkspaceScope,
        input: &MasterReminderInput,
    ) -> rusqlite::Result<MasterReminder>;
    /// `listReminders` — `repository.ts:71` (TypeScript default `limit = 100`).
    fn list_reminders(
        &self,
        scope: &WorkspaceScope,
        limit: i64,
    ) -> rusqlite::Result<Vec<MasterReminder>>;
    /// `updateReminder` — `repository.ts:72-76`.
    fn update_reminder(
        &self,
        scope: &WorkspaceScope,
        reminder_id: &str,
        patch: &ReminderPatch,
    ) -> rusqlite::Result<Option<MasterReminder>>;
    /// `deleteReminder` — `repository.ts:77`.
    fn delete_reminder(&self, scope: &WorkspaceScope, reminder_id: &str) -> rusqlite::Result<bool>;

    // ─── Delegation ────────────────────────────────────────────────────────

    /// `createDelegationJob` — `repository.ts:79-85`.
    fn create_delegation_job(
        &self,
        scope: &WorkspaceScope,
        job: &MasterDelegationJobInput,
    ) -> rusqlite::Result<MasterDelegationJob>;
    /// `updateDelegationJob` — `repository.ts:86-90`.
    fn update_delegation_job(
        &self,
        scope: &WorkspaceScope,
        job_id: &str,
        patch: &DelegationPatch,
    ) -> rusqlite::Result<Option<MasterDelegationJob>>;
    /// `listDelegationJobs` — `repository.ts:91`.
    fn list_delegation_jobs(
        &self,
        scope: &WorkspaceScope,
        run_id: &str,
    ) -> rusqlite::Result<Vec<MasterDelegationJob>>;
    /// `appendDelegationEvent` — `repository.ts:92-95`.
    fn append_delegation_event(
        &self,
        scope: &WorkspaceScope,
        event: &MasterDelegationEventInput,
    ) -> rusqlite::Result<MasterDelegationEvent>;
    /// `listDelegationEvents` — `repository.ts:96`.
    fn list_delegation_events(
        &self,
        scope: &WorkspaceScope,
        run_id: &str,
    ) -> rusqlite::Result<Vec<MasterDelegationEvent>>;

    // ─── Governance ────────────────────────────────────────────────────────

    /// `upsertActionLedger` — `repository.ts:98-104`.
    fn upsert_action_ledger(
        &self,
        scope: &WorkspaceScope,
        entry: &MasterActionLedgerInput,
    ) -> rusqlite::Result<MasterActionLedgerEntry>;
    /// `getActionLedgerByKey` — `repository.ts:105-108`.
    fn get_action_ledger_by_key(
        &self,
        scope: &WorkspaceScope,
        idempotency_key: &str,
    ) -> rusqlite::Result<Option<MasterActionLedgerEntry>>;

    /// `upsertApprovalRule` — `repository.ts:110-115`.
    fn upsert_approval_rule(
        &self,
        scope: &WorkspaceScope,
        action_type: &str,
        fingerprint: &str,
        decision: &str,
    ) -> rusqlite::Result<()>;
    /// `getApprovalRule` — `repository.ts:116-120`.
    fn get_approval_rule(
        &self,
        scope: &WorkspaceScope,
        action_type: &str,
        fingerprint: &str,
    ) -> rusqlite::Result<Option<String>>;

    // ─── Approvals ─────────────────────────────────────────────────────────

    /// `createApprovalRequest` — `repository.ts:122-128`.
    fn create_approval_request(
        &self,
        scope: &WorkspaceScope,
        request: &MasterApprovalRequestInput,
    ) -> rusqlite::Result<MasterApprovalRequest>;
    /// `updateApprovalRequest` — `repository.ts:129-133`.
    fn update_approval_request(
        &self,
        scope: &WorkspaceScope,
        request_id: &str,
        patch: &ApprovalPatch,
    ) -> rusqlite::Result<Option<MasterApprovalRequest>>;
    /// `getApprovalRequest` — `repository.ts:134`.
    fn get_approval_request(
        &self,
        scope: &WorkspaceScope,
        request_id: &str,
    ) -> rusqlite::Result<Option<MasterApprovalRequest>>;
    /// `listApprovalRequests` — `repository.ts:135-139`.
    fn list_approval_requests(
        &self,
        scope: &WorkspaceScope,
        run_id: Option<&str>,
        limit: i64,
    ) -> rusqlite::Result<Vec<MasterApprovalRequest>>;

    // ─── Tool policy ───────────────────────────────────────────────────────

    /// `upsertToolPolicy` — `repository.ts:141-144`.
    fn upsert_tool_policy(
        &self,
        scope: &WorkspaceScope,
        policy: &MasterToolPolicyInput,
    ) -> rusqlite::Result<MasterToolPolicy>;
    /// `getToolPolicy` — `repository.ts:145`.
    fn get_tool_policy(&self, scope: &WorkspaceScope)
        -> rusqlite::Result<Option<MasterToolPolicy>>;

    // ─── Subagent sessions ─────────────────────────────────────────────────

    /// `createSubagentSession` — `repository.ts:147-153`.
    fn create_subagent_session(
        &self,
        scope: &WorkspaceScope,
        session: &MasterSubagentSessionInput,
    ) -> rusqlite::Result<MasterSubagentSession>;
    /// `updateSubagentSession` — `repository.ts:154-158`.
    fn update_subagent_session(
        &self,
        scope: &WorkspaceScope,
        session_id: &str,
        patch: &SubagentSessionPatch,
    ) -> rusqlite::Result<Option<MasterSubagentSession>>;
    /// `getSubagentSession` — `repository.ts:159`.
    fn get_subagent_session(
        &self,
        scope: &WorkspaceScope,
        session_id: &str,
    ) -> rusqlite::Result<Option<MasterSubagentSession>>;
    /// `listSubagentSessions` — `repository.ts:160-164`.
    fn list_subagent_sessions(
        &self,
        scope: &WorkspaceScope,
        run_id: Option<&str>,
        limit: i64,
    ) -> rusqlite::Result<Vec<MasterSubagentSession>>;

    // ─── Capability scores / proposals ─────────────────────────────────────

    /// `upsertCapabilityScore` — `repository.ts:166-172`.
    fn upsert_capability_score(
        &self,
        scope: &WorkspaceScope,
        capability: &str,
        confidence: f64,
        benchmark_summary: &str,
        last_verified_at: Option<&str>,
    ) -> rusqlite::Result<MasterCapabilityScore>;
    /// `listCapabilityScores` — `repository.ts:173`.
    fn list_capability_scores(
        &self,
        scope: &WorkspaceScope,
    ) -> rusqlite::Result<Vec<MasterCapabilityScore>>;
    /// `createCapabilityProposal` — `repository.ts:175-181`.
    fn create_capability_proposal(
        &self,
        scope: &WorkspaceScope,
        proposal: &MasterCapabilityProposalInput,
    ) -> rusqlite::Result<MasterCapabilityProposal>;
    /// `listCapabilityProposals` — `repository.ts:182`.
    fn list_capability_proposals(
        &self,
        scope: &WorkspaceScope,
    ) -> rusqlite::Result<Vec<MasterCapabilityProposal>>;

    // ─── Toolforge artifacts ───────────────────────────────────────────────

    /// `createToolForgeArtifact` — `repository.ts:184-190`.
    fn create_toolforge_artifact(
        &self,
        scope: &WorkspaceScope,
        artifact: &MasterToolForgeArtifactInput,
    ) -> rusqlite::Result<MasterToolForgeArtifact>;
    /// `updateToolForgeArtifact` — `repository.ts:191-195`.
    fn update_toolforge_artifact(
        &self,
        scope: &WorkspaceScope,
        artifact_id: &str,
        patch: &ToolForgePatch,
    ) -> rusqlite::Result<Option<MasterToolForgeArtifact>>;
    /// `listToolForgeArtifacts` — `repository.ts:196`.
    fn list_toolforge_artifacts(
        &self,
        scope: &WorkspaceScope,
    ) -> rusqlite::Result<Vec<MasterToolForgeArtifact>>;
    /// `listGlobalToolForgeArtifacts` — `repository.ts:197`.
    fn list_global_toolforge_artifacts(
        &self,
        limit: i64,
    ) -> rusqlite::Result<Vec<MasterToolForgeArtifact>>;

    // ─── Connector secrets ─────────────────────────────────────────────────

    /// `upsertConnectorSecret` — `repository.ts:199-205`.
    fn upsert_connector_secret(
        &self,
        scope: &WorkspaceScope,
        secret: &MasterConnectorSecretInput,
    ) -> rusqlite::Result<MasterConnectorSecret>;
    /// `getConnectorSecret` — `repository.ts:206-210`.
    fn get_connector_secret(
        &self,
        scope: &WorkspaceScope,
        provider: &str,
        key_ref: &str,
    ) -> rusqlite::Result<Option<MasterConnectorSecret>>;

    // ─── Audit ─────────────────────────────────────────────────────────────

    /// `appendAuditEvent` — `repository.ts:212-215`.
    fn append_audit_event(
        &self,
        scope: &WorkspaceScope,
        input: &MasterAuditEventInput,
    ) -> rusqlite::Result<MasterAuditEvent>;
    /// `listAuditEvents` — `repository.ts:216`.
    fn list_audit_events(
        &self,
        scope: &WorkspaceScope,
        limit: i64,
    ) -> rusqlite::Result<Vec<MasterAuditEvent>>;

    // ─── Scopes ────────────────────────────────────────────────────────────

    /// `listKnownScopes` — `repository.ts:218`.
    fn list_known_scopes(&self, limit: i64) -> rusqlite::Result<Vec<WorkspaceScope>>;

    /// `close(): void` — `repository.ts:220`.
    ///
    /// `where Self: Sized` because it consumes the handle; see the module note.
    fn close(self)
    where
        Self: Sized;
}
