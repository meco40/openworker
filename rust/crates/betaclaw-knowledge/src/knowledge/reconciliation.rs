//! Port of `src/server/knowledge/reconciliation.ts` (1-53).
//!
//! | TypeScript                                          | Rust |
//! | --------------------------------------------------- | ---- |
//! | `reconciliation.ts:8-12` (`StoreEntry`)             | [`StoreEntry`] |
//! | `reconciliation.ts:14-19` (`ReconciliationReport`)  | [`ReconciliationReport`] |
//! | `reconciliation.ts:30-53` (`detectOrphans`)         | [`detect_orphans`] |
//!
//! # JavaScript semantics that are reproduced explicitly
//!
//! * `knowledgeEntries.filter((e) => e.externalRef)` (`:35-37`) keeps entries
//!   whose `externalRef` is *truthy*, so the empty string is dropped. The Rust
//!   side therefore treats `Some("")` like `None`.
//! * `new Set(...)` holds `string | undefined`; `Set.has` compares by value,
//!   which is what the two `HashSet`s do here.
//! * The report keeps the array order of the inputs (`:40`, `:43-45`): the
//!   `mem0Orphans` are *all* Mem0 entries that no knowledge entry references.

use std::collections::HashSet;

/// `StoreEntry` from `reconciliation.ts:8-12`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreEntry {
    pub id: String,
    pub content: String,
    pub external_ref: Option<String>,
}

impl StoreEntry {
    /// `e.externalRef` as a JavaScript truthiness test (`:35-36`, `:44`).
    fn referenced_id(&self) -> Option<&str> {
        match self.external_ref.as_deref() {
            None | Some("") => None,
            Some(reference) => Some(reference),
        }
    }
}

/// `ReconciliationReport` from `reconciliation.ts:14-19`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReconciliationReport {
    pub mem0_orphans_found: usize,
    pub knowledge_orphans_found: usize,
    pub mem0_orphans: Vec<StoreEntry>,
    pub knowledge_orphans: Vec<StoreEntry>,
}

/// `detectOrphans(mem0Entries, knowledgeEntries)` (`reconciliation.ts:30-53`).
pub fn detect_orphans(
    mem0_entries: &[StoreEntry],
    knowledge_entries: &[StoreEntry],
) -> ReconciliationReport {
    let mem0_ids: HashSet<&str> = mem0_entries.iter().map(|entry| entry.id.as_str()).collect();
    let referenced_mem0_ids: HashSet<&str> = knowledge_entries
        .iter()
        .filter_map(StoreEntry::referenced_id)
        .collect();

    let mem0_orphans: Vec<StoreEntry> = mem0_entries
        .iter()
        .filter(|entry| !referenced_mem0_ids.contains(entry.id.as_str()))
        .cloned()
        .collect();

    let knowledge_orphans: Vec<StoreEntry> = knowledge_entries
        .iter()
        .filter(|entry| {
            entry
                .referenced_id()
                .is_some_and(|id| !mem0_ids.contains(id))
        })
        .cloned()
        .collect();

    ReconciliationReport {
        mem0_orphans_found: mem0_orphans.len(),
        knowledge_orphans_found: knowledge_orphans.len(),
        mem0_orphans,
        knowledge_orphans,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, reference: Option<&str>) -> StoreEntry {
        StoreEntry {
            id: id.to_string(),
            content: format!("content of {id}"),
            external_ref: reference.map(str::to_string),
        }
    }

    #[test]
    fn unreferenced_mem0_ids_are_orphans() {
        let mem0 = vec![entry("m1", None), entry("m2", None), entry("m3", None)];
        let knowledge = vec![entry("k1", Some("m1")), entry("k2", Some("m2"))];

        let report = detect_orphans(&mem0, &knowledge);
        assert_eq!(report.mem0_orphans_found, 1);
        assert_eq!(report.knowledge_orphans_found, 0);
        assert_eq!(report.mem0_orphans, vec![entry("m3", None)]);
        assert!(report.knowledge_orphans.is_empty());
    }

    #[test]
    fn a_knowledge_reference_without_a_mem0_entry_is_an_orphan() {
        let mem0 = vec![entry("m1", None)];
        let knowledge = vec![entry("k1", Some("m1")), entry("k2", Some("m9"))];

        let report = detect_orphans(&mem0, &knowledge);
        assert_eq!(report.mem0_orphans_found, 0);
        assert_eq!(report.knowledge_orphans_found, 1);
        assert_eq!(report.knowledge_orphans, vec![entry("k2", Some("m9"))]);
    }

    /// `externalRef: ''` is falsy, so such an entry is neither recorded as
    /// referenced nor reported as a knowledge orphan (`:35-37`, `:43-45`).
    #[test]
    fn an_empty_reference_behaves_like_no_reference() {
        let mem0 = vec![entry("m1", None)];
        let knowledge = vec![entry("k1", Some("")), entry("k2", None)];

        let report = detect_orphans(&mem0, &knowledge);
        assert_eq!(report.mem0_orphans_found, 1);
        assert_eq!(report.mem0_orphans, vec![entry("m1", None)]);
        assert_eq!(report.knowledge_orphans_found, 0);
        assert!(report.knowledge_orphans.is_empty());
    }

    #[test]
    fn both_stores_empty_report_nothing() {
        let report = detect_orphans(&[], &[]);
        assert_eq!(
            report,
            ReconciliationReport {
                mem0_orphans_found: 0,
                knowledge_orphans_found: 0,
                mem0_orphans: Vec::new(),
                knowledge_orphans: Vec::new(),
            }
        );
    }

    /// Duplicate knowledge references collapse through the sets, while every
    /// knowledge orphan keeps its own row (`:43-45`).
    #[test]
    fn duplicates_are_collapsed_through_the_sets() {
        let mem0 = vec![entry("m1", None), entry("m2", None)];
        let knowledge = vec![
            entry("k1", Some("m1")),
            entry("k2", Some("m1")),
            entry("k3", Some("m9")),
            entry("k4", Some("m9")),
        ];

        let report = detect_orphans(&mem0, &knowledge);
        assert_eq!(report.mem0_orphans_found, 1);
        assert_eq!(report.mem0_orphans, vec![entry("m2", None)]);
        assert_eq!(report.knowledge_orphans_found, 2);
        assert_eq!(
            report.knowledge_orphans,
            vec![entry("k3", Some("m9")), entry("k4", Some("m9"))]
        );
    }
}
