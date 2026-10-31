//! Port of `src/server/master/repository/sqliteMasterRepository.ts:1-449`.
//!
//! The `SqliteMasterRepository` facade: it owns one [`Connection`] behind a
//! `Mutex`, so the type is `Send + Sync` as [`MasterRepository`] requires, and
//! forwards every method to the matching `*.store.ts` function. The TypeScript class
//! declares `implements MasterRepository`; the port implements the
//! [`MasterRepository`] trait declared in `master/repository.rs` (the sibling
//! file of this directory) by forwarding to the inherent methods below, so both
//! entry points are the same code. No behaviour is added — the facade is pure
//! delegation.
//!
//! Two methods have no counterpart in the interface, because `getMasterRepository()`
//! returns the concrete `SqliteMasterRepository`: [`SqliteMasterRepository::migrate_workspace_scope`]
//! and [`SqliteMasterRepository::migrate_user_legacy_scopes_to_master_persona`]
//! (`workspaceScope.ts:66` calls the latter on the concrete type). They stay
//! inherent, exactly like in TypeScript.
//!
//! The constructor argument defaults to `MASTER_DB_PATH || '.local/master.db'`
//! through [`default_master_db_path`], and [`SqliteMasterRepository::close`]
//! drops the connection (`close(): void`).

use std::sync::{Mutex, MutexGuard, PoisonError};

use rusqlite::Connection;

use crate::master::repository::MasterRepository;

use crate::master::repository::approvals_store::{
    create_approval_request, get_approval_request, list_approval_requests, update_approval_request,
    ApprovalPatch, MasterApprovalRequestInput,
};
use crate::master::repository::audit_store::{
    append_audit_event, list_audit_events, MasterAuditEventInput,
};
use crate::master::repository::db::{
    create_master_sqlite_db, default_master_db_path, MasterSqliteDb,
};
use crate::master::repository::delegation_store::{
    append_delegation_event, create_delegation_job, list_delegation_events, list_delegation_jobs,
    update_delegation_job, DelegationPatch, MasterDelegationEventInput, MasterDelegationJobInput,
};
use crate::master::repository::governance_store::{
    create_capability_proposal, get_action_ledger_by_key, get_approval_rule,
    list_capability_proposals, list_capability_scores, upsert_action_ledger, upsert_approval_rule,
    upsert_capability_score, MasterActionLedgerInput, MasterCapabilityProposalInput,
};
use crate::master::repository::migration_store::migrate_user_legacy_scopes_to_master_persona;
use crate::master::repository::migration_store::{migrate_workspace_scope, ScopeMigrationInput};
use crate::master::repository::notes_store::{
    create_note, delete_note, list_notes, update_note, MasterNoteInput, NotePatch,
};
use crate::master::repository::reminders_store::{
    create_reminder, delete_reminder, list_reminders, update_reminder, MasterReminderInput,
    ReminderPatch,
};
use crate::master::repository::runs_store::{
    add_feedback, append_step, claim_run, create_run, get_run, list_runs, list_steps,
    release_run_lease, renew_run_lease, update_run, MasterFeedbackInput, MasterStepInput, RunPatch,
};
use crate::master::repository::scopes_store::list_known_scopes;
use crate::master::repository::secrets_store::{
    get_connector_secret, upsert_connector_secret, MasterConnectorSecretInput,
};
use crate::master::repository::sessions_store::{
    create_subagent_session, get_subagent_session, list_subagent_sessions, update_subagent_session,
    MasterSubagentSessionInput, SubagentSessionPatch,
};
use crate::master::repository::tool_policy_store::{
    get_tool_policy, upsert_tool_policy, MasterToolPolicyInput,
};
use crate::master::repository::toolforge_store::{
    create_toolforge_artifact, list_global_toolforge_artifacts, list_toolforge_artifacts,
    update_toolforge_artifact, MasterToolForgeArtifactInput, ToolForgePatch,
};
use crate::master::types::{
    MasterActionLedgerEntry, MasterApprovalRequest, MasterAuditEvent, MasterCapabilityProposal,
    MasterCapabilityScore, MasterConnectorSecret, MasterDelegationEvent, MasterDelegationJob,
    MasterFeedback, MasterNote, MasterReminder, MasterRun, MasterRunCreateInput, MasterStep,
    MasterSubagentSession, MasterToolForgeArtifact, MasterToolPolicy, WorkspaceScope,
};

/// `SqliteMasterRepository` from `sqliteMasterRepository.ts:95-449`.
pub struct SqliteMasterRepository {
    db: Mutex<MasterSqliteDb>,
}

impl SqliteMasterRepository {
    /// `constructor(dbPath = process.env.MASTER_DB_PATH || '.local/master.db')`
    /// — `sqliteMasterRepository.ts:98-100`.
    pub fn open(db_path: &str) -> rusqlite::Result<Self> {
        Ok(Self {
            db: Mutex::new(create_master_sqlite_db(db_path)?),
        })
    }

    /// The connection behind its lock. A poisoned lock still yields the
    /// connection, so one panicked caller does not wedge the repository.
    fn db(&self) -> MutexGuard<'_, Connection> {
        self.db.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Constructor with the `MASTER_DB_PATH || '.local/master.db'` default.
    pub fn open_default() -> rusqlite::Result<Self> {
        Self::open(&default_master_db_path())
    }

    /// Read-only access for diagnostics and the migration/parity checks. The
    /// guard holds the lock until it is dropped.
    pub fn connection(&self) -> MutexGuard<'_, Connection> {
        self.db()
    }

    /// `close(): void` — `sqliteMasterRepository.ts:446-448`.
    pub fn close(self) {
        drop(self.db);
    }

    // ─── Runs ──────────────────────────────────────────────────────────────

    /// `createRun` — `sqliteMasterRepository.ts:102-104`.
    pub fn create_run(&self, input: &MasterRunCreateInput) -> rusqlite::Result<MasterRun> {
        create_run(&self.db(), input)
    }

    /// `getRun` — `:106-108`.
    pub fn get_run(
        &self,
        scope: &WorkspaceScope,
        run_id: &str,
    ) -> rusqlite::Result<Option<MasterRun>> {
        get_run(&self.db(), scope, run_id)
    }

    /// `listRuns` — `:110-112`.
    pub fn list_runs(
        &self,
        scope: &WorkspaceScope,
        limit: i64,
    ) -> rusqlite::Result<Vec<MasterRun>> {
        list_runs(&self.db(), scope, limit)
    }

    /// `updateRun` — `:114-116`.
    pub fn update_run(
        &self,
        scope: &WorkspaceScope,
        run_id: &str,
        patch: &RunPatch,
    ) -> rusqlite::Result<Option<MasterRun>> {
        update_run(&self.db(), scope, run_id, patch)
    }

    /// `claimRun` — `:118-127`.
    pub fn claim_run(
        &self,
        scope: &WorkspaceScope,
        run_id: &str,
        owner_id: &str,
        lease_expires_at: &str,
    ) -> rusqlite::Result<Option<MasterRun>> {
        claim_run(&self.db(), scope, run_id, owner_id, lease_expires_at)
    }

    /// `renewRunLease` — `:129-138`.
    pub fn renew_run_lease(
        &self,
        scope: &WorkspaceScope,
        run_id: &str,
        owner_id: &str,
        lease_expires_at: &str,
        heartbeat_at: &str,
    ) -> rusqlite::Result<Option<MasterRun>> {
        renew_run_lease(
            &self.db(),
            scope,
            run_id,
            owner_id,
            lease_expires_at,
            heartbeat_at,
        )
    }

    /// `releaseRunLease` — `:140-142`.
    pub fn release_run_lease(
        &self,
        scope: &WorkspaceScope,
        run_id: &str,
        owner_id: &str,
    ) -> rusqlite::Result<Option<MasterRun>> {
        release_run_lease(&self.db(), scope, run_id, owner_id)
    }

    /// `appendStep` — `:144-151`.
    pub fn append_step(
        &self,
        scope: &WorkspaceScope,
        run_id: &str,
        step: &MasterStepInput,
    ) -> rusqlite::Result<MasterStep> {
        append_step(&self.db(), scope, run_id, step)
    }

    /// `listSteps` — `:153-155`.
    pub fn list_steps(
        &self,
        scope: &WorkspaceScope,
        run_id: &str,
    ) -> rusqlite::Result<Vec<MasterStep>> {
        list_steps(&self.db(), scope, run_id)
    }

    /// `addFeedback` — `:157-162`.
    pub fn add_feedback(
        &self,
        scope: &WorkspaceScope,
        feedback: &MasterFeedbackInput,
    ) -> rusqlite::Result<MasterFeedback> {
        add_feedback(&self.db(), scope, feedback)
    }

    // ─── Notes ─────────────────────────────────────────────────────────────

    /// `createNote` — `:164-169`.
    pub fn create_note(
        &self,
        scope: &WorkspaceScope,
        input: &MasterNoteInput,
    ) -> rusqlite::Result<MasterNote> {
        create_note(&self.db(), scope, input)
    }

    /// `listNotes` — `:171-173`.
    pub fn list_notes(
        &self,
        scope: &WorkspaceScope,
        limit: i64,
    ) -> rusqlite::Result<Vec<MasterNote>> {
        list_notes(&self.db(), scope, limit)
    }

    /// `updateNote` — `:175-183`.
    pub fn update_note(
        &self,
        scope: &WorkspaceScope,
        note_id: &str,
        patch: &NotePatch,
    ) -> rusqlite::Result<Option<MasterNote>> {
        update_note(&self.db(), scope, note_id, patch)
    }

    /// `deleteNote` — `:185-187`.
    pub fn delete_note(&self, scope: &WorkspaceScope, note_id: &str) -> rusqlite::Result<bool> {
        delete_note(&self.db(), scope, note_id)
    }

    // ─── Reminders ─────────────────────────────────────────────────────────

    /// `createReminder` — `:189-194`.
    pub fn create_reminder(
        &self,
        scope: &WorkspaceScope,
        input: &MasterReminderInput,
    ) -> rusqlite::Result<MasterReminder> {
        create_reminder(&self.db(), scope, input)
    }

    /// `listReminders` — `:196-198`.
    pub fn list_reminders(
        &self,
        scope: &WorkspaceScope,
        limit: i64,
    ) -> rusqlite::Result<Vec<MasterReminder>> {
        list_reminders(&self.db(), scope, limit)
    }

    /// `updateReminder` — `:200-208`.
    pub fn update_reminder(
        &self,
        scope: &WorkspaceScope,
        reminder_id: &str,
        patch: &ReminderPatch,
    ) -> rusqlite::Result<Option<MasterReminder>> {
        update_reminder(&self.db(), scope, reminder_id, patch)
    }

    /// `deleteReminder` — `:210-212`.
    pub fn delete_reminder(
        &self,
        scope: &WorkspaceScope,
        reminder_id: &str,
    ) -> rusqlite::Result<bool> {
        delete_reminder(&self.db(), scope, reminder_id)
    }

    // ─── Delegation ────────────────────────────────────────────────────────

    /// `createDelegationJob` — `:214-219`.
    pub fn create_delegation_job(
        &self,
        scope: &WorkspaceScope,
        job: &MasterDelegationJobInput,
    ) -> rusqlite::Result<MasterDelegationJob> {
        create_delegation_job(&self.db(), scope, job)
    }

    /// `updateDelegationJob` — `:221-227`.
    pub fn update_delegation_job(
        &self,
        scope: &WorkspaceScope,
        job_id: &str,
        patch: &DelegationPatch,
    ) -> rusqlite::Result<Option<MasterDelegationJob>> {
        update_delegation_job(&self.db(), scope, job_id, patch)
    }

    /// `listDelegationJobs` — `:229-231`.
    pub fn list_delegation_jobs(
        &self,
        scope: &WorkspaceScope,
        run_id: &str,
    ) -> rusqlite::Result<Vec<MasterDelegationJob>> {
        list_delegation_jobs(&self.db(), scope, run_id)
    }

    /// `appendDelegationEvent` — `:233-238`.
    pub fn append_delegation_event(
        &self,
        scope: &WorkspaceScope,
        event: &MasterDelegationEventInput,
    ) -> rusqlite::Result<MasterDelegationEvent> {
        append_delegation_event(&self.db(), scope, event)
    }

    /// `listDelegationEvents` — `:240-242`.
    pub fn list_delegation_events(
        &self,
        scope: &WorkspaceScope,
        run_id: &str,
    ) -> rusqlite::Result<Vec<MasterDelegationEvent>> {
        list_delegation_events(&self.db(), scope, run_id)
    }

    // ─── Governance ────────────────────────────────────────────────────────

    /// `upsertActionLedger` — `:244-249`.
    pub fn upsert_action_ledger(
        &self,
        scope: &WorkspaceScope,
        entry: &MasterActionLedgerInput,
    ) -> rusqlite::Result<MasterActionLedgerEntry> {
        upsert_action_ledger(&self.db(), scope, entry)
    }

    /// `getActionLedgerByKey` — `:251-256`.
    pub fn get_action_ledger_by_key(
        &self,
        scope: &WorkspaceScope,
        idempotency_key: &str,
    ) -> rusqlite::Result<Option<MasterActionLedgerEntry>> {
        get_action_ledger_by_key(&self.db(), scope, idempotency_key)
    }

    /// `upsertApprovalRule` — `:258-265`.
    pub fn upsert_approval_rule(
        &self,
        scope: &WorkspaceScope,
        action_type: &str,
        fingerprint: &str,
        decision: &str,
    ) -> rusqlite::Result<()> {
        upsert_approval_rule(&self.db(), scope, action_type, fingerprint, decision)
    }

    /// `getApprovalRule` — `:267-272`.
    pub fn get_approval_rule(
        &self,
        scope: &WorkspaceScope,
        action_type: &str,
        fingerprint: &str,
    ) -> rusqlite::Result<Option<String>> {
        get_approval_rule(&self.db(), scope, action_type, fingerprint)
    }

    // ─── Approvals ─────────────────────────────────────────────────────────

    /// `createApprovalRequest` — `:274-279`.
    pub fn create_approval_request(
        &self,
        scope: &WorkspaceScope,
        request: &MasterApprovalRequestInput,
    ) -> rusqlite::Result<MasterApprovalRequest> {
        create_approval_request(&self.db(), scope, request)
    }

    /// `updateApprovalRequest` — `:281-287`.
    pub fn update_approval_request(
        &self,
        scope: &WorkspaceScope,
        request_id: &str,
        patch: &ApprovalPatch,
    ) -> rusqlite::Result<Option<MasterApprovalRequest>> {
        update_approval_request(&self.db(), scope, request_id, patch)
    }

    /// `getApprovalRequest` — `:289-291`.
    pub fn get_approval_request(
        &self,
        scope: &WorkspaceScope,
        request_id: &str,
    ) -> rusqlite::Result<Option<MasterApprovalRequest>> {
        get_approval_request(&self.db(), scope, request_id)
    }

    /// `listApprovalRequests` — `:293-300`.
    pub fn list_approval_requests(
        &self,
        scope: &WorkspaceScope,
        run_id: Option<&str>,
        limit: i64,
    ) -> rusqlite::Result<Vec<MasterApprovalRequest>> {
        list_approval_requests(&self.db(), scope, run_id, limit)
    }

    // ─── Tool policy ───────────────────────────────────────────────────────

    /// `upsertToolPolicy` — `:302-307`.
    pub fn upsert_tool_policy(
        &self,
        scope: &WorkspaceScope,
        policy: &MasterToolPolicyInput,
    ) -> rusqlite::Result<MasterToolPolicy> {
        upsert_tool_policy(&self.db(), scope, policy)
    }

    /// `getToolPolicy` — `:309-311`.
    pub fn get_tool_policy(
        &self,
        scope: &WorkspaceScope,
    ) -> rusqlite::Result<Option<MasterToolPolicy>> {
        get_tool_policy(&self.db(), scope)
    }

    // ─── Subagent sessions ─────────────────────────────────────────────────

    /// `createSubagentSession` — `:313-318`.
    pub fn create_subagent_session(
        &self,
        scope: &WorkspaceScope,
        session: &MasterSubagentSessionInput,
    ) -> rusqlite::Result<MasterSubagentSession> {
        create_subagent_session(&self.db(), scope, session)
    }

    /// `updateSubagentSession` — `:320-326`.
    pub fn update_subagent_session(
        &self,
        scope: &WorkspaceScope,
        session_id: &str,
        patch: &SubagentSessionPatch,
    ) -> rusqlite::Result<Option<MasterSubagentSession>> {
        update_subagent_session(&self.db(), scope, session_id, patch)
    }

    /// `getSubagentSession` — `:328-334`.
    pub fn get_subagent_session(
        &self,
        scope: &WorkspaceScope,
        session_id: &str,
    ) -> rusqlite::Result<Option<MasterSubagentSession>> {
        get_subagent_session(&self.db(), scope, session_id)
    }

    /// `listSubagentSessions` — `:336-342`.
    pub fn list_subagent_sessions(
        &self,
        scope: &WorkspaceScope,
        run_id: Option<&str>,
        limit: i64,
    ) -> rusqlite::Result<Vec<MasterSubagentSession>> {
        list_subagent_sessions(&self.db(), scope, run_id, limit)
    }

    // ─── Capability scores / proposals ─────────────────────────────────────

    /// `upsertCapabilityScore` — `:344-359`.
    pub fn upsert_capability_score(
        &self,
        scope: &WorkspaceScope,
        capability: &str,
        confidence: f64,
        benchmark_summary: &str,
        last_verified_at: Option<&str>,
    ) -> rusqlite::Result<MasterCapabilityScore> {
        upsert_capability_score(
            &self.db(),
            scope,
            capability,
            confidence,
            benchmark_summary,
            last_verified_at,
        )
    }

    /// `listCapabilityScores` — `:361-363`.
    pub fn list_capability_scores(
        &self,
        scope: &WorkspaceScope,
    ) -> rusqlite::Result<Vec<MasterCapabilityScore>> {
        list_capability_scores(&self.db(), scope)
    }

    /// `createCapabilityProposal` — `:365-373`.
    pub fn create_capability_proposal(
        &self,
        scope: &WorkspaceScope,
        proposal: &MasterCapabilityProposalInput,
    ) -> rusqlite::Result<MasterCapabilityProposal> {
        create_capability_proposal(&self.db(), scope, proposal)
    }

    /// `listCapabilityProposals` — `:375-377`.
    pub fn list_capability_proposals(
        &self,
        scope: &WorkspaceScope,
    ) -> rusqlite::Result<Vec<MasterCapabilityProposal>> {
        list_capability_proposals(&self.db(), scope)
    }

    // ─── Toolforge artifacts ───────────────────────────────────────────────

    /// `createToolForgeArtifact` — `:379-387`.
    pub fn create_toolforge_artifact(
        &self,
        scope: &WorkspaceScope,
        artifact: &MasterToolForgeArtifactInput,
    ) -> rusqlite::Result<MasterToolForgeArtifact> {
        create_toolforge_artifact(&self.db(), scope, artifact)
    }

    /// `updateToolForgeArtifact` — `:389-395`.
    pub fn update_toolforge_artifact(
        &self,
        scope: &WorkspaceScope,
        artifact_id: &str,
        patch: &ToolForgePatch,
    ) -> rusqlite::Result<Option<MasterToolForgeArtifact>> {
        update_toolforge_artifact(&self.db(), scope, artifact_id, patch)
    }

    /// `listToolForgeArtifacts` — `:397-399`.
    pub fn list_toolforge_artifacts(
        &self,
        scope: &WorkspaceScope,
    ) -> rusqlite::Result<Vec<MasterToolForgeArtifact>> {
        list_toolforge_artifacts(&self.db(), scope)
    }

    /// `listGlobalToolForgeArtifacts` — `:401-403`.
    pub fn list_global_toolforge_artifacts(
        &self,
        limit: i64,
    ) -> rusqlite::Result<Vec<MasterToolForgeArtifact>> {
        list_global_toolforge_artifacts(&self.db(), limit)
    }

    // ─── Connector secrets ─────────────────────────────────────────────────

    /// `upsertConnectorSecret` — `:405-413`.
    pub fn upsert_connector_secret(
        &self,
        scope: &WorkspaceScope,
        secret: &MasterConnectorSecretInput,
    ) -> rusqlite::Result<MasterConnectorSecret> {
        upsert_connector_secret(&self.db(), scope, secret)
    }

    /// `getConnectorSecret` — `:415-421`.
    pub fn get_connector_secret(
        &self,
        scope: &WorkspaceScope,
        provider: &str,
        key_ref: &str,
    ) -> rusqlite::Result<Option<MasterConnectorSecret>> {
        get_connector_secret(&self.db(), scope, provider, key_ref)
    }

    // ─── Audit ─────────────────────────────────────────────────────────────

    /// `appendAuditEvent` — `:423-428`.
    pub fn append_audit_event(
        &self,
        scope: &WorkspaceScope,
        input: &MasterAuditEventInput,
    ) -> rusqlite::Result<MasterAuditEvent> {
        append_audit_event(&self.db(), scope, input)
    }

    /// `listAuditEvents` — `:430-432`.
    pub fn list_audit_events(
        &self,
        scope: &WorkspaceScope,
        limit: i64,
    ) -> rusqlite::Result<Vec<MasterAuditEvent>> {
        list_audit_events(&self.db(), scope, limit)
    }

    // ─── Scopes ────────────────────────────────────────────────────────────

    /// `listKnownScopes` — `:434-436`.
    pub fn list_known_scopes(&self, limit: i64) -> rusqlite::Result<Vec<WorkspaceScope>> {
        list_known_scopes(&self.db(), limit)
    }

    /// `migrateWorkspaceScope` — `:438-440`.
    pub fn migrate_workspace_scope(
        &self,
        user_id: &str,
        from_workspace_id: &str,
        to_workspace_id: &str,
    ) -> rusqlite::Result<()> {
        migrate_workspace_scope(
            &self.db(),
            &ScopeMigrationInput {
                user_id,
                from_workspace_id,
                to_workspace_id,
            },
        )
    }

    /// `migrateUserLegacyScopesToMasterPersona` — `:442-444`.
    pub fn migrate_user_legacy_scopes_to_master_persona(
        &self,
        user_id: &str,
        master_persona_id: &str,
    ) -> rusqlite::Result<usize> {
        migrate_user_legacy_scopes_to_master_persona(&self.db(), user_id, master_persona_id)
    }
}
/// `class SqliteMasterRepository implements MasterRepository`
/// (`sqliteMasterRepository.ts:95`).
///
/// Pure forwarding: every trait method calls the inherent method of the same
/// name, which in turn forwards to the matching `*.store.ts` function. Nothing
/// is re-implemented here, so the inherent and trait paths cannot drift.
impl MasterRepository for SqliteMasterRepository {
    fn create_run(&self, input: &MasterRunCreateInput) -> rusqlite::Result<MasterRun> {
        self.create_run(input)
    }

    fn get_run(&self, scope: &WorkspaceScope, run_id: &str) -> rusqlite::Result<Option<MasterRun>> {
        self.get_run(scope, run_id)
    }

    fn list_runs(&self, scope: &WorkspaceScope, limit: i64) -> rusqlite::Result<Vec<MasterRun>> {
        self.list_runs(scope, limit)
    }

    fn update_run(
        &self,
        scope: &WorkspaceScope,
        run_id: &str,
        patch: &RunPatch,
    ) -> rusqlite::Result<Option<MasterRun>> {
        self.update_run(scope, run_id, patch)
    }

    fn claim_run(
        &self,
        scope: &WorkspaceScope,
        run_id: &str,
        owner_id: &str,
        lease_expires_at: &str,
    ) -> rusqlite::Result<Option<MasterRun>> {
        self.claim_run(scope, run_id, owner_id, lease_expires_at)
    }

    fn renew_run_lease(
        &self,
        scope: &WorkspaceScope,
        run_id: &str,
        owner_id: &str,
        lease_expires_at: &str,
        heartbeat_at: &str,
    ) -> rusqlite::Result<Option<MasterRun>> {
        self.renew_run_lease(scope, run_id, owner_id, lease_expires_at, heartbeat_at)
    }

    fn release_run_lease(
        &self,
        scope: &WorkspaceScope,
        run_id: &str,
        owner_id: &str,
    ) -> rusqlite::Result<Option<MasterRun>> {
        self.release_run_lease(scope, run_id, owner_id)
    }

    fn append_step(
        &self,
        scope: &WorkspaceScope,
        run_id: &str,
        step: &MasterStepInput,
    ) -> rusqlite::Result<MasterStep> {
        self.append_step(scope, run_id, step)
    }

    fn list_steps(
        &self,
        scope: &WorkspaceScope,
        run_id: &str,
    ) -> rusqlite::Result<Vec<MasterStep>> {
        self.list_steps(scope, run_id)
    }

    fn add_feedback(
        &self,
        scope: &WorkspaceScope,
        feedback: &MasterFeedbackInput,
    ) -> rusqlite::Result<MasterFeedback> {
        self.add_feedback(scope, feedback)
    }

    fn create_note(
        &self,
        scope: &WorkspaceScope,
        input: &MasterNoteInput,
    ) -> rusqlite::Result<MasterNote> {
        self.create_note(scope, input)
    }

    fn list_notes(&self, scope: &WorkspaceScope, limit: i64) -> rusqlite::Result<Vec<MasterNote>> {
        self.list_notes(scope, limit)
    }

    fn update_note(
        &self,
        scope: &WorkspaceScope,
        note_id: &str,
        patch: &NotePatch,
    ) -> rusqlite::Result<Option<MasterNote>> {
        self.update_note(scope, note_id, patch)
    }

    fn delete_note(&self, scope: &WorkspaceScope, note_id: &str) -> rusqlite::Result<bool> {
        self.delete_note(scope, note_id)
    }

    fn create_reminder(
        &self,
        scope: &WorkspaceScope,
        input: &MasterReminderInput,
    ) -> rusqlite::Result<MasterReminder> {
        self.create_reminder(scope, input)
    }

    fn list_reminders(
        &self,
        scope: &WorkspaceScope,
        limit: i64,
    ) -> rusqlite::Result<Vec<MasterReminder>> {
        self.list_reminders(scope, limit)
    }

    fn update_reminder(
        &self,
        scope: &WorkspaceScope,
        reminder_id: &str,
        patch: &ReminderPatch,
    ) -> rusqlite::Result<Option<MasterReminder>> {
        self.update_reminder(scope, reminder_id, patch)
    }

    fn delete_reminder(&self, scope: &WorkspaceScope, reminder_id: &str) -> rusqlite::Result<bool> {
        self.delete_reminder(scope, reminder_id)
    }

    fn create_delegation_job(
        &self,
        scope: &WorkspaceScope,
        job: &MasterDelegationJobInput,
    ) -> rusqlite::Result<MasterDelegationJob> {
        self.create_delegation_job(scope, job)
    }

    fn update_delegation_job(
        &self,
        scope: &WorkspaceScope,
        job_id: &str,
        patch: &DelegationPatch,
    ) -> rusqlite::Result<Option<MasterDelegationJob>> {
        self.update_delegation_job(scope, job_id, patch)
    }

    fn list_delegation_jobs(
        &self,
        scope: &WorkspaceScope,
        run_id: &str,
    ) -> rusqlite::Result<Vec<MasterDelegationJob>> {
        self.list_delegation_jobs(scope, run_id)
    }

    fn append_delegation_event(
        &self,
        scope: &WorkspaceScope,
        event: &MasterDelegationEventInput,
    ) -> rusqlite::Result<MasterDelegationEvent> {
        self.append_delegation_event(scope, event)
    }

    fn list_delegation_events(
        &self,
        scope: &WorkspaceScope,
        run_id: &str,
    ) -> rusqlite::Result<Vec<MasterDelegationEvent>> {
        self.list_delegation_events(scope, run_id)
    }

    fn upsert_action_ledger(
        &self,
        scope: &WorkspaceScope,
        entry: &MasterActionLedgerInput,
    ) -> rusqlite::Result<MasterActionLedgerEntry> {
        self.upsert_action_ledger(scope, entry)
    }

    fn get_action_ledger_by_key(
        &self,
        scope: &WorkspaceScope,
        idempotency_key: &str,
    ) -> rusqlite::Result<Option<MasterActionLedgerEntry>> {
        self.get_action_ledger_by_key(scope, idempotency_key)
    }

    fn upsert_approval_rule(
        &self,
        scope: &WorkspaceScope,
        action_type: &str,
        fingerprint: &str,
        decision: &str,
    ) -> rusqlite::Result<()> {
        self.upsert_approval_rule(scope, action_type, fingerprint, decision)
    }

    fn get_approval_rule(
        &self,
        scope: &WorkspaceScope,
        action_type: &str,
        fingerprint: &str,
    ) -> rusqlite::Result<Option<String>> {
        self.get_approval_rule(scope, action_type, fingerprint)
    }

    fn create_approval_request(
        &self,
        scope: &WorkspaceScope,
        request: &MasterApprovalRequestInput,
    ) -> rusqlite::Result<MasterApprovalRequest> {
        self.create_approval_request(scope, request)
    }

    fn update_approval_request(
        &self,
        scope: &WorkspaceScope,
        request_id: &str,
        patch: &ApprovalPatch,
    ) -> rusqlite::Result<Option<MasterApprovalRequest>> {
        self.update_approval_request(scope, request_id, patch)
    }

    fn get_approval_request(
        &self,
        scope: &WorkspaceScope,
        request_id: &str,
    ) -> rusqlite::Result<Option<MasterApprovalRequest>> {
        self.get_approval_request(scope, request_id)
    }

    fn list_approval_requests(
        &self,
        scope: &WorkspaceScope,
        run_id: Option<&str>,
        limit: i64,
    ) -> rusqlite::Result<Vec<MasterApprovalRequest>> {
        self.list_approval_requests(scope, run_id, limit)
    }

    fn upsert_tool_policy(
        &self,
        scope: &WorkspaceScope,
        policy: &MasterToolPolicyInput,
    ) -> rusqlite::Result<MasterToolPolicy> {
        self.upsert_tool_policy(scope, policy)
    }

    fn get_tool_policy(
        &self,
        scope: &WorkspaceScope,
    ) -> rusqlite::Result<Option<MasterToolPolicy>> {
        self.get_tool_policy(scope)
    }

    fn create_subagent_session(
        &self,
        scope: &WorkspaceScope,
        session: &MasterSubagentSessionInput,
    ) -> rusqlite::Result<MasterSubagentSession> {
        self.create_subagent_session(scope, session)
    }

    fn update_subagent_session(
        &self,
        scope: &WorkspaceScope,
        session_id: &str,
        patch: &SubagentSessionPatch,
    ) -> rusqlite::Result<Option<MasterSubagentSession>> {
        self.update_subagent_session(scope, session_id, patch)
    }

    fn get_subagent_session(
        &self,
        scope: &WorkspaceScope,
        session_id: &str,
    ) -> rusqlite::Result<Option<MasterSubagentSession>> {
        self.get_subagent_session(scope, session_id)
    }

    fn list_subagent_sessions(
        &self,
        scope: &WorkspaceScope,
        run_id: Option<&str>,
        limit: i64,
    ) -> rusqlite::Result<Vec<MasterSubagentSession>> {
        self.list_subagent_sessions(scope, run_id, limit)
    }

    fn upsert_capability_score(
        &self,
        scope: &WorkspaceScope,
        capability: &str,
        confidence: f64,
        benchmark_summary: &str,
        last_verified_at: Option<&str>,
    ) -> rusqlite::Result<MasterCapabilityScore> {
        self.upsert_capability_score(
            scope,
            capability,
            confidence,
            benchmark_summary,
            last_verified_at,
        )
    }

    fn list_capability_scores(
        &self,
        scope: &WorkspaceScope,
    ) -> rusqlite::Result<Vec<MasterCapabilityScore>> {
        self.list_capability_scores(scope)
    }

    fn create_capability_proposal(
        &self,
        scope: &WorkspaceScope,
        proposal: &MasterCapabilityProposalInput,
    ) -> rusqlite::Result<MasterCapabilityProposal> {
        self.create_capability_proposal(scope, proposal)
    }

    fn list_capability_proposals(
        &self,
        scope: &WorkspaceScope,
    ) -> rusqlite::Result<Vec<MasterCapabilityProposal>> {
        self.list_capability_proposals(scope)
    }

    fn create_toolforge_artifact(
        &self,
        scope: &WorkspaceScope,
        artifact: &MasterToolForgeArtifactInput,
    ) -> rusqlite::Result<MasterToolForgeArtifact> {
        self.create_toolforge_artifact(scope, artifact)
    }

    fn update_toolforge_artifact(
        &self,
        scope: &WorkspaceScope,
        artifact_id: &str,
        patch: &ToolForgePatch,
    ) -> rusqlite::Result<Option<MasterToolForgeArtifact>> {
        self.update_toolforge_artifact(scope, artifact_id, patch)
    }

    fn list_toolforge_artifacts(
        &self,
        scope: &WorkspaceScope,
    ) -> rusqlite::Result<Vec<MasterToolForgeArtifact>> {
        self.list_toolforge_artifacts(scope)
    }

    fn list_global_toolforge_artifacts(
        &self,
        limit: i64,
    ) -> rusqlite::Result<Vec<MasterToolForgeArtifact>> {
        self.list_global_toolforge_artifacts(limit)
    }

    fn upsert_connector_secret(
        &self,
        scope: &WorkspaceScope,
        secret: &MasterConnectorSecretInput,
    ) -> rusqlite::Result<MasterConnectorSecret> {
        self.upsert_connector_secret(scope, secret)
    }

    fn get_connector_secret(
        &self,
        scope: &WorkspaceScope,
        provider: &str,
        key_ref: &str,
    ) -> rusqlite::Result<Option<MasterConnectorSecret>> {
        self.get_connector_secret(scope, provider, key_ref)
    }

    fn append_audit_event(
        &self,
        scope: &WorkspaceScope,
        input: &MasterAuditEventInput,
    ) -> rusqlite::Result<MasterAuditEvent> {
        self.append_audit_event(scope, input)
    }

    fn list_audit_events(
        &self,
        scope: &WorkspaceScope,
        limit: i64,
    ) -> rusqlite::Result<Vec<MasterAuditEvent>> {
        self.list_audit_events(scope, limit)
    }

    fn list_known_scopes(&self, limit: i64) -> rusqlite::Result<Vec<WorkspaceScope>> {
        self.list_known_scopes(limit)
    }

    fn close(self) {
        SqliteMasterRepository::close(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope() -> WorkspaceScope {
        WorkspaceScope {
            user_id: "u1".to_string(),
            workspace_id: "w1".to_string(),
        }
    }

    /// Reads one run through the trait, once as a generic parameter and once
    /// behind `&dyn`, to pin that `implements MasterRepository` really holds for
    /// the facade (a missing or mis-typed member would not compile).
    #[test]
    fn facade_implements_master_repository() {
        fn generic_read<R: MasterRepository>(repo: &R, scope: &WorkspaceScope, id: &str) -> String {
            repo.get_run(scope, id).unwrap().unwrap().status
        }

        let repository = SqliteMasterRepository::open(":memory:").unwrap();
        let run = repository
            .create_run(&MasterRunCreateInput {
                user_id: "u1".to_string(),
                workspace_id: "w1".to_string(),
                title: "T".to_string(),
                contract: "C".to_string(),
            })
            .unwrap();
        let scope = scope();

        assert_eq!(generic_read(&repository, &scope, &run.id), "ANALYZING");

        let dynamic: &dyn MasterRepository = &repository;
        assert_eq!(
            dynamic.get_run(&scope, &run.id).unwrap().unwrap().status,
            "ANALYZING"
        );
        assert_eq!(dynamic.list_runs(&scope, 50).unwrap().len(), 1);
        assert_eq!(dynamic.list_known_scopes(200).unwrap().len(), 1);
        assert!(dynamic.get_run(&scope, "missing").unwrap().is_none());
    }

    #[test]
    fn facade_runs_create_get_note_and_audit() {
        let repository = SqliteMasterRepository::open(":memory:").unwrap();
        let run = repository
            .create_run(&MasterRunCreateInput {
                user_id: "u1".to_string(),
                workspace_id: "w1".to_string(),
                title: "T".to_string(),
                contract: "C".to_string(),
            })
            .unwrap();
        assert!(repository.get_run(&scope(), &run.id).unwrap().is_some());

        let note = repository
            .create_note(
                &scope(),
                &MasterNoteInput {
                    title: "n".to_string(),
                    content: "b".to_string(),
                    tags: Vec::new(),
                },
            )
            .unwrap();
        assert_eq!(repository.list_notes(&scope(), 100).unwrap().len(), 1);
        assert!(repository.delete_note(&scope(), &note.id).unwrap());

        repository
            .append_audit_event(
                &scope(),
                &MasterAuditEventInput {
                    category: "run".to_string(),
                    action: "created".to_string(),
                    metadata: "{}".to_string(),
                },
            )
            .unwrap();
        assert_eq!(
            repository.list_audit_events(&scope(), 200).unwrap().len(),
            1
        );
        repository.close();
    }

    #[test]
    fn facade_guards_the_lease_and_migrates_a_scope() {
        let repository = SqliteMasterRepository::open(":memory:").unwrap();
        let run = repository
            .create_run(&MasterRunCreateInput {
                user_id: "u1".to_string(),
                workspace_id: "w1".to_string(),
                title: "T".to_string(),
                contract: "C".to_string(),
            })
            .unwrap();
        let claimed = repository
            .claim_run(&scope(), &run.id, "o1", "2999-01-01T00:00:00.000Z")
            .unwrap()
            .unwrap();
        assert_eq!(claimed.owner_id.as_deref(), Some("o1"));
        assert!(repository
            .claim_run(&scope(), &run.id, "o2", "2999-01-01T00:00:00.000Z")
            .unwrap()
            .is_none());

        let scopes = repository.list_known_scopes(500).unwrap();
        assert!(scopes.contains(&scope()));

        repository
            .migrate_workspace_scope("u1", "w1", "w2")
            .unwrap();
        let moved = WorkspaceScope {
            user_id: "u1".to_string(),
            workspace_id: "w2".to_string(),
        };
        assert!(repository.get_run(&moved, &run.id).unwrap().is_some());
        assert!(repository.get_run(&scope(), &run.id).unwrap().is_none());
        repository.close();
    }
}
