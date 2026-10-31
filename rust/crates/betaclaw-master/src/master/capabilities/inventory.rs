//! Port of `src/server/master/capabilities/inventory.ts:1-26`.
//!
//! Bootstraps the capability score table: every capability of
//! [`DEFAULT_CAPABILITIES`] that has no row yet is written with a neutral
//! confidence of `0.5` and the literal summary `{"source":"bootstrap"}`, then the
//! full list is read back. Existing rows are left untouched, so repeated calls
//! are idempotent.

use crate::master::repository::MasterRepository;
use crate::master::types::{MasterCapabilityScore, WorkspaceScope};

/// `DEFAULT_CAPABILITIES` from `inventory.ts:4-13`.
pub const DEFAULT_CAPABILITIES: &[&str] = &[
    "web_search",
    "code_generation",
    "notes",
    "reminders",
    "cron",
    "system_ops",
    "gmail",
    "toolforge",
];

/// `buildCapabilityInventory` — `inventory.ts:15-26`.
pub fn build_capability_inventory(
    repo: &dyn MasterRepository,
    scope: &WorkspaceScope,
) -> rusqlite::Result<Vec<MasterCapabilityScore>> {
    let existing = repo.list_capability_scores(scope)?;
    let existing_keys: std::collections::HashSet<&str> = existing
        .iter()
        .map(|entry| entry.capability.as_str())
        .collect();
    for capability in DEFAULT_CAPABILITIES {
        if existing_keys.contains(capability) {
            continue;
        }
        repo.upsert_capability_score(scope, capability, 0.5, "{\"source\":\"bootstrap\"}", None)?;
    }
    repo.list_capability_scores(scope)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::master::repository::sqlite_master_repository::SqliteMasterRepository;

    fn scope() -> WorkspaceScope {
        WorkspaceScope {
            user_id: "u1".to_string(),
            workspace_id: "w1".to_string(),
        }
    }

    #[test]
    fn every_default_capability_is_bootstrapped_once() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let scope = scope();
        let first = build_capability_inventory(&repo, &scope).unwrap();
        assert_eq!(first.len(), DEFAULT_CAPABILITIES.len());
        let keys: Vec<&str> = first.iter().map(|e| e.capability.as_str()).collect();
        for capability in DEFAULT_CAPABILITIES {
            assert!(keys.contains(capability), "{capability}");
        }
        assert!(first.iter().all(|e| e.confidence == 0.5));
        assert!(first
            .iter()
            .all(|e| e.benchmark_summary == "{\"source\":\"bootstrap\"}"));
        assert!(first.iter().all(|e| e.last_verified_at.is_none()));
    }

    #[test]
    fn a_second_call_does_not_duplicate_rows() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let scope = scope();
        build_capability_inventory(&repo, &scope).unwrap();
        let second = build_capability_inventory(&repo, &scope).unwrap();
        assert_eq!(second.len(), DEFAULT_CAPABILITIES.len());
    }

    #[test]
    fn an_existing_row_is_not_overwritten() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let scope = scope();
        repo.upsert_capability_score(
            &scope,
            "notes",
            0.9,
            "custom",
            Some("2026-01-01T00:00:00.000Z"),
        )
        .unwrap();
        let inventory = build_capability_inventory(&repo, &scope).unwrap();
        let notes = inventory
            .iter()
            .find(|e| e.capability == "notes")
            .expect("notes");
        assert_eq!(notes.confidence, 0.9);
        assert_eq!(notes.benchmark_summary, "custom");
    }
}
