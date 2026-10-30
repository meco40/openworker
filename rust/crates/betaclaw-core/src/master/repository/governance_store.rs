//! Port of `src/server/master/repository/governance.store.ts:1-191`.
//!
//! The governance writes: the action ledger, approval rules, capability scores
//! and capability proposals. Every upsert uses the owning table's `UNIQUE`
//! constraint with `ON CONFLICT(...) DO UPDATE` and then reads back through the
//! matching getter/list (`governance.store.ts:44,133,176`).
//!
//! `getApprovalRule` returns `row?.decision || null`: an empty stored decision
//! is reported as `null`, and the port keeps that truthy filter.

use rusqlite::{params, Connection};

use crate::master::repository::helpers::now_iso;
use crate::master::repository::mappers::{
    to_action_ledger_entry, to_capability_proposal, to_capability_score,
};
use crate::master::repository::required;
use crate::master::types::{
    MasterActionLedgerEntry, MasterCapabilityProposal, MasterCapabilityScore, WorkspaceScope,
};

/// `Omit<MasterActionLedgerEntry, 'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt'>`
/// — `governance.store.ts:20`.
pub struct MasterActionLedgerInput {
    pub run_id: String,
    pub step_id: String,
    pub action_type: String,
    pub idempotency_key: String,
    pub state: String,
    pub result_payload: Option<String>,
}

/// `Omit<MasterCapabilityProposal, 'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt'>`
/// — `governance.store.ts:153-156`.
pub struct MasterCapabilityProposalInput {
    pub title: String,
    pub capability_key: String,
    pub status: String,
    pub proposal: String,
    pub fallback_plan: String,
}

/// `upsertActionLedger` from `governance.store.ts:17-45`.
pub fn upsert_action_ledger(
    connection: &Connection,
    scope: &WorkspaceScope,
    entry: &MasterActionLedgerInput,
) -> rusqlite::Result<MasterActionLedgerEntry> {
    let now = now_iso();
    connection.execute(
        "INSERT INTO master_action_ledger (
           id, run_id, user_id, workspace_id, step_id, action_type, idempotency_key, state, result_payload, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(idempotency_key) DO UPDATE SET
           state = excluded.state,
           result_payload = excluded.result_payload,
           updated_at = excluded.updated_at",
        params![
            uuid::Uuid::new_v4().to_string(),
            entry.run_id,
            scope.user_id,
            scope.workspace_id,
            entry.step_id,
            entry.action_type,
            entry.idempotency_key,
            entry.state,
            entry.result_payload,
            now,
            now,
        ],
    )?;
    required(get_action_ledger_by_key(
        connection,
        scope,
        &entry.idempotency_key,
    )?)
}

/// `getActionLedgerByKey` from `governance.store.ts:47-59`.
pub fn get_action_ledger_by_key(
    connection: &Connection,
    scope: &WorkspaceScope,
    idempotency_key: &str,
) -> rusqlite::Result<Option<MasterActionLedgerEntry>> {
    let row = connection.query_row(
        "SELECT * FROM master_action_ledger
         WHERE idempotency_key = ? AND user_id = ? AND workspace_id = ?",
        params![idempotency_key, scope.user_id, scope.workspace_id],
        to_action_ledger_entry,
    );
    match row {
        Ok(entry) => Ok(Some(entry)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error),
    }
}

/// `upsertApprovalRule` from `governance.store.ts:61-85`.
pub fn upsert_approval_rule(
    connection: &Connection,
    scope: &WorkspaceScope,
    action_type: &str,
    fingerprint: &str,
    decision: &str,
) -> rusqlite::Result<()> {
    let now = now_iso();
    connection.execute(
        "INSERT INTO master_approval_rules (
           id, user_id, workspace_id, action_type, fingerprint, decision, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, workspace_id, action_type, fingerprint)
         DO UPDATE SET decision = excluded.decision, updated_at = excluded.updated_at",
        params![
            uuid::Uuid::new_v4().to_string(),
            scope.user_id,
            scope.workspace_id,
            action_type,
            fingerprint,
            decision,
            now,
            now,
        ],
    )?;
    Ok(())
}

/// `getApprovalRule` from `governance.store.ts:87-102`.
///
/// `row?.decision || null` — an empty decision reads as `None`.
pub fn get_approval_rule(
    connection: &Connection,
    scope: &WorkspaceScope,
    action_type: &str,
    fingerprint: &str,
) -> rusqlite::Result<Option<String>> {
    let row = connection.query_row(
        "SELECT decision FROM master_approval_rules
         WHERE user_id = ? AND workspace_id = ? AND action_type = ? AND fingerprint = ?",
        params![scope.user_id, scope.workspace_id, action_type, fingerprint],
        |row| row.get::<_, Option<String>>(0),
    );
    match row {
        Ok(Some(decision)) if !decision.is_empty() => Ok(Some(decision)),
        Ok(_) => Ok(None),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error),
    }
}

/// `upsertCapabilityScore` from `governance.store.ts:104-134`.
pub fn upsert_capability_score(
    connection: &Connection,
    scope: &WorkspaceScope,
    capability: &str,
    confidence: f64,
    benchmark_summary: &str,
    last_verified_at: Option<&str>,
) -> rusqlite::Result<MasterCapabilityScore> {
    let now = now_iso();
    connection.execute(
        "INSERT INTO master_capability_scores (
           id, user_id, workspace_id, capability, confidence, last_verified_at, benchmark_summary, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, workspace_id, capability)
         DO UPDATE SET
           confidence = excluded.confidence,
           last_verified_at = excluded.last_verified_at,
           benchmark_summary = excluded.benchmark_summary,
           updated_at = excluded.updated_at",
        params![
            uuid::Uuid::new_v4().to_string(),
            scope.user_id,
            scope.workspace_id,
            capability,
            confidence,
            last_verified_at,
            benchmark_summary,
            now,
        ],
    )?;
    let found = list_capability_scores(connection, scope)?
        .into_iter()
        .find(|entry| entry.capability == capability);
    required(found)
}

/// `listCapabilityScores` from `governance.store.ts:136-148`.
pub fn list_capability_scores(
    connection: &Connection,
    scope: &WorkspaceScope,
) -> rusqlite::Result<Vec<MasterCapabilityScore>> {
    let mut statement = connection.prepare(
        "SELECT * FROM master_capability_scores
         WHERE user_id = ? AND workspace_id = ?
         ORDER BY updated_at DESC",
    )?;
    let rows = statement.query_map(
        params![scope.user_id, scope.workspace_id],
        to_capability_score,
    )?;
    rows.collect()
}

/// `createCapabilityProposal` from `governance.store.ts:150-177`.
pub fn create_capability_proposal(
    connection: &Connection,
    scope: &WorkspaceScope,
    proposal: &MasterCapabilityProposalInput,
) -> rusqlite::Result<MasterCapabilityProposal> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_iso();
    connection.execute(
        "INSERT INTO master_capability_proposals (
           id, user_id, workspace_id, title, capability_key, status, proposal, fallback_plan, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            id,
            scope.user_id,
            scope.workspace_id,
            proposal.title,
            proposal.capability_key,
            proposal.status,
            proposal.proposal,
            proposal.fallback_plan,
            now,
            now,
        ],
    )?;
    let found = list_capability_proposals(connection, scope)?
        .into_iter()
        .find(|entry| entry.id == id);
    required(found)
}

/// `listCapabilityProposals` from `governance.store.ts:179-191`.
pub fn list_capability_proposals(
    connection: &Connection,
    scope: &WorkspaceScope,
) -> rusqlite::Result<Vec<MasterCapabilityProposal>> {
    let mut statement = connection.prepare(
        "SELECT * FROM master_capability_proposals
         WHERE user_id = ? AND workspace_id = ?
         ORDER BY updated_at DESC",
    )?;
    let rows = statement.query_map(
        params![scope.user_id, scope.workspace_id],
        to_capability_proposal,
    )?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{open, OpenOptions};
    use crate::master::migrations::run_master_migrations;

    fn setup() -> (Connection, WorkspaceScope) {
        let connection = open(OpenOptions::new(":memory:")).unwrap();
        run_master_migrations(&connection).unwrap();
        let scope = WorkspaceScope {
            user_id: "u1".to_string(),
            workspace_id: "w1".to_string(),
        };
        (connection, scope)
    }

    #[test]
    fn action_ledger_upserts_on_the_idempotency_key() {
        let (connection, scope) = setup();
        let entry = MasterActionLedgerInput {
            run_id: "r1".to_string(),
            step_id: "s1".to_string(),
            action_type: "exec".to_string(),
            idempotency_key: "key-1".to_string(),
            state: "planned".to_string(),
            result_payload: None,
        };
        upsert_action_ledger(&connection, &scope, &entry).unwrap();
        let second = MasterActionLedgerInput {
            run_id: "r1".to_string(),
            step_id: "s1".to_string(),
            action_type: "exec".to_string(),
            idempotency_key: "key-1".to_string(),
            state: "committed".to_string(),
            result_payload: Some("{\"ok\":true}".to_string()),
        };
        let updated = upsert_action_ledger(&connection, &scope, &second).unwrap();
        assert_eq!(updated.state, "committed");
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM master_action_ledger", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn approval_rule_round_trips_and_empty_is_null() {
        let (connection, scope) = setup();
        upsert_approval_rule(&connection, &scope, "exec", "fp", "approve_always").unwrap();
        assert_eq!(
            get_approval_rule(&connection, &scope, "exec", "fp")
                .unwrap()
                .as_deref(),
            Some("approve_always")
        );
        upsert_approval_rule(&connection, &scope, "exec", "fp", "").unwrap();
        assert!(get_approval_rule(&connection, &scope, "exec", "fp")
            .unwrap()
            .is_none());
    }

    #[test]
    fn capability_score_and_proposal() {
        let (connection, scope) = setup();
        upsert_capability_score(&connection, &scope, "coding", 0.5, "{}", None).unwrap();
        let updated =
            upsert_capability_score(&connection, &scope, "coding", 0.9, "{\"n\":1}", Some("t"))
                .unwrap();
        assert_eq!(updated.confidence, 0.9);
        assert_eq!(
            list_capability_scores(&connection, &scope).unwrap().len(),
            1
        );

        let proposal = create_capability_proposal(
            &connection,
            &scope,
            &MasterCapabilityProposalInput {
                title: "T".to_string(),
                capability_key: "coding".to_string(),
                status: "draft".to_string(),
                proposal: "p".to_string(),
                fallback_plan: "f".to_string(),
            },
        )
        .unwrap();
        assert_eq!(proposal.status, "draft");
        assert_eq!(
            list_capability_proposals(&connection, &scope)
                .unwrap()
                .len(),
            1
        );
    }
}
