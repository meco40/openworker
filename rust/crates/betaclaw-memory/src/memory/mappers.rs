//! Port of `src/server/memory/mappers/nodeMappers.ts`.
//!
//! Two mappers turn the provider contract objects into [`MemoryNode`]:
//! [`to_memory_node`] for a full record (list, get, update results) and
//! [`to_memory_node_from_hit`] for a search hit. Both stamp the same four
//! derived metadata keys, in the same insertion order, because
//! `serde_json` is built with `preserve_order` and the stored JSON must be
//! byte-comparable with what the TypeScript backend writes.
//!
//! The stamp order is `mem0Id`, `source`, `memoryProvider`, `lastVerified`, and
//! a key that already exists keeps its original position while taking the new
//! value — exactly what `{ ...metadata, key: value }` does in JavaScript.

use serde_json::Value;

use super::errors::pick_string;
use super::types::{
    MemoryHistoryRecord, MemoryMetadata, MemoryNode, MemoryProviderKind, MemoryType,
};
use super::utils::{format_timestamp, now_iso};
use super::validators::{as_confidence, as_importance, as_memory_type, as_version};

/// `toMemoryNode` from `nodeMappers.ts:7-38`.
pub fn to_memory_node(record: &super::types::Mem0MemoryRecord) -> MemoryNode {
    let metadata = &record.metadata;
    let memory_provider = match metadata.get("memoryProvider").and_then(Value::as_str) {
        Some("postgres") => MemoryProviderKind::Postgres,
        Some("sqlite") => MemoryProviderKind::Sqlite,
        Some("mem0") => MemoryProviderKind::Mem0,
        _ => MemoryProviderKind::Mem0,
    };

    let mut stamped: MemoryMetadata = metadata.clone();
    // `(typeof metadata.mem0Id === 'string' && metadata.mem0Id.trim()) || record.id`
    let mem0_id = metadata
        .get("mem0Id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| record.id.clone());
    stamped.insert("mem0Id".to_string(), Value::String(mem0_id));

    let source = match metadata.get("source").and_then(Value::as_str) {
        Some("postgres" | "sqlite" | "mem0") => metadata
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or(memory_provider.as_str())
            .to_string(),
        _ => memory_provider.as_str().to_string(),
    };
    stamped.insert("source".to_string(), Value::String(source));
    stamped.insert(
        "memoryProvider".to_string(),
        Value::String(memory_provider.as_str().to_string()),
    );

    // `(typeof metadata.lastVerified === 'string' && metadata.lastVerified) ||
    //  record.updatedAt || record.createdAt || new Date().toISOString()`
    // Note: not trimmed, so a whitespace-only value survives.
    let last_verified = metadata
        .get("lastVerified")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| record.updated_at.clone())
        .or_else(|| record.created_at.clone())
        .unwrap_or_else(now_iso);
    stamped.insert("lastVerified".to_string(), Value::String(last_verified));

    MemoryNode {
        id: record.id.clone(),
        node_type: as_memory_type(metadata.get("type")),
        content: record.content.clone(),
        embedding: Vec::new(),
        importance: as_importance(metadata.get("importance"), 3.0),
        confidence: as_confidence(metadata.get("confidence"), 0.5),
        timestamp: format_timestamp(
            record
                .updated_at
                .as_deref()
                .or(record.created_at.as_deref()),
        ),
        metadata: Some(stamped),
    }
}

/// `toMemoryNodeFromHit` from `nodeMappers.ts:40-47`.
pub fn to_memory_node_from_hit(hit: &super::types::Mem0SearchHit) -> MemoryNode {
    to_memory_node(&super::types::Mem0MemoryRecord {
        id: hit.id.clone(),
        content: hit.content.clone(),
        score: hit.score,
        metadata: hit.metadata.clone(),
        created_at: None,
        updated_at: None,
    })
}

/// `asOptionalMemoryType` from `nodeMappers.ts:49-60`.
///
/// Unlike [`as_memory_type`] this returns `None` for an unknown value, because
/// a history entry may legitimately carry no type.
fn as_optional_memory_type(value: Option<&Value>) -> Option<MemoryType> {
    pick_string(value).as_deref().and_then(MemoryType::parse)
}

/// `toHistoryRecord` from `nodeMappers.ts:62-75`.
///
/// `index` is the position in the provider's history array and doubles as the
/// version fallback, so a history entry without a `version` metadata key is
/// numbered `index + 1`. Only an absent key counts as "undefined": an explicit
/// `null` goes through `Number(null) === 0` and lands on the clamp, exactly
/// like the source.
pub fn to_history_record(
    entry: &super::types::Mem0HistoryEntry,
    index: i64,
) -> MemoryHistoryRecord {
    let metadata = &entry.metadata;
    MemoryHistoryRecord {
        index,
        action: {
            // `String(entry.action || 'unknown').toLowerCase()`
            let action = entry.action.trim();
            if action.is_empty() {
                "unknown".to_string()
            } else {
                action.to_lowercase()
            }
        },
        timestamp: entry
            .timestamp
            .clone()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(now_iso),
        content: entry.content.clone(),
        node_type: as_optional_memory_type(metadata.get("type")),
        // `nodeMappers.ts:70-71`: `metadata.importance === undefined ? undefined
        // : asImportance(metadata.importance, 3)`. Only an *absent* key stays
        // `undefined`; an explicit `null` goes through `Number(null) === 0` and
        // lands on the lower clamp.
        importance: metadata
            .get("importance")
            .map(|_| as_importance(metadata.get("importance"), 3.0)),
        // `nodeMappers.ts:72`: `metadata.version === undefined ? index + 1 :
        // asVersion(metadata.version, index + 1)` — the fallback is returned
        // *directly* for an absent key, so the field is never `undefined`.
        version: match metadata.get("version") {
            None => Some(index + 1),
            Some(_) => Some(as_version(metadata.get("version"), index + 1)),
        },
        metadata: metadata.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::types::{Mem0HistoryEntry, Mem0MemoryRecord};
    use serde_json::{json, Map};

    fn record() -> Mem0MemoryRecord {
        Mem0MemoryRecord {
            id: "rec-1".to_string(),
            content: "likes coffee".to_string(),
            score: None,
            metadata: Map::new(),
            created_at: Some("2026-01-01T00:00:00Z".to_string()),
            updated_at: Some("2026-01-02T00:00:00Z".to_string()),
        }
    }

    /// The four stamped keys are the contract between the mapper and the
    /// validators: a missing stamp would make `asMemoryType` fall back to
    /// `fact` and `asConfidence` to `0.5` on the next read.
    #[test]
    fn the_mapper_stamps_the_four_derived_keys() {
        let node = to_memory_node(&record());
        assert_eq!(node.id, "rec-1");
        assert_eq!(node.node_type, MemoryType::Fact);
        assert_eq!(node.importance, 3.0);
        assert_eq!(node.confidence, 0.5);
        let metadata = node.metadata.expect("metadata");
        assert_eq!(metadata["mem0Id"], "rec-1");
        assert_eq!(metadata["source"], "mem0");
        assert_eq!(metadata["memoryProvider"], "mem0");
        assert_eq!(metadata["lastVerified"], "2026-01-02T00:00:00Z");
    }

    /// `mem0Id` is the *trimmed* caller value when present, so a padded id
    /// stored by an older release resolves to the same key.
    #[test]
    fn a_padded_memory_id_is_trimmed_before_it_is_kept() {
        let mut record = record();
        record.metadata = Map::from_iter([("mem0Id".to_string(), json!("  rec-9  "))]);
        let node = to_memory_node(&record);
        assert_eq!(node.metadata.as_ref().expect("metadata")["mem0Id"], "rec-9");
        assert_eq!(node.id, "rec-1", "the node id is untouched");
    }

    /// `nodeMappers.ts:31-35` is
    /// `(typeof metadata.lastVerified === 'string' && metadata.lastVerified) ||
    /// record.updatedAt || …`. Only the *empty* string is falsy in JavaScript,
    /// so a whitespace-only value survives verbatim; trimming is not part of
    /// the mapper (the read sites do it, `service.ts:54` and
    /// `sqliteMemoryClient.ts:23`) and doing it here would change the stored
    /// JSON, so the port keeps the value as-is.
    #[test]
    fn a_whitespace_only_last_verified_is_kept_because_the_string_is_truthy() {
        let mut padded = record();
        padded.metadata = Map::from_iter([("lastVerified".to_string(), json!("   "))]);
        let node = to_memory_node(&padded);
        assert_eq!(
            node.metadata.as_ref().expect("metadata")["lastVerified"],
            "   "
        );

        // The genuinely falsy value does fall through to `updatedAt`.
        let mut empty = record();
        empty.metadata = Map::from_iter([("lastVerified".to_string(), json!(""))]);
        let node = to_memory_node(&empty);
        assert_eq!(
            node.metadata.as_ref().expect("metadata")["lastVerified"],
            "2026-01-02T00:00:00Z"
        );
    }

    /// Only the three known provider spellings are accepted for `source`;
    /// anything else inherits the normalised `memoryProvider`.
    #[test]
    fn an_unknown_source_falls_back_to_the_memory_provider() {
        let mut record = record();
        record.metadata = Map::from_iter([
            ("memoryProvider".to_string(), json!("sqlite")),
            ("source".to_string(), json!("somewhere-else")),
        ]);
        let node = to_memory_node(&record);
        let metadata = node.metadata.expect("metadata");
        assert_eq!(metadata["memoryProvider"], "sqlite");
        assert_eq!(metadata["source"], "sqlite");
    }

    #[test]
    fn a_search_hit_maps_through_the_same_path() {
        let hit = crate::memory::types::Mem0SearchHit {
            id: "h1".to_string(),
            content: "x".to_string(),
            score: Some(80.0),
            metadata: Map::from_iter([("type".to_string(), json!("lesson"))]),
        };
        let node = to_memory_node_from_hit(&hit);
        assert_eq!(node.node_type, MemoryType::Lesson);
        assert_eq!(node.id, "h1");
    }

    /// The history record numbers an entry without a `version` key as
    /// `index + 1`, which is what makes `restoreFromHistory` indices line up.
    #[test]
    fn history_entries_default_their_version_to_index_plus_one() {
        let entry = Mem0HistoryEntry {
            action: "ADD".to_string(),
            timestamp: Some("2026-01-01T00:00:00Z".to_string()),
            content: Some("c".to_string()),
            metadata: Map::new(),
            raw: Map::new(),
        };
        let mapped = to_history_record(&entry, 2);
        assert_eq!(mapped.index, 2);
        assert_eq!(mapped.action, "add", "the action is lowercased");
        assert_eq!(mapped.version, Some(3));
        assert_eq!(mapped.node_type, None);
        assert_eq!(mapped.importance, None);
    }

    #[test]
    fn history_metadata_wins_over_the_index_default() {
        let entry = Mem0HistoryEntry {
            action: String::new(),
            timestamp: None,
            content: None,
            metadata: Map::from_iter([
                ("type".to_string(), json!("preference")),
                ("importance".to_string(), json!(4.6)),
                ("version".to_string(), json!(7)),
            ]),
            raw: Map::new(),
        };
        let mapped = to_history_record(&entry, 0);
        assert_eq!(mapped.action, "unknown");
        assert_eq!(mapped.node_type, Some(MemoryType::Preference));
        assert_eq!(mapped.importance, Some(5.0), "importance is clamped");
        assert_eq!(mapped.version, Some(7));
        assert!(mapped.timestamp.starts_with("20"), "an absent stamp is now");
    }
}
