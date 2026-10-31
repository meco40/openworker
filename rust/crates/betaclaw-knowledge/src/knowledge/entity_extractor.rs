//! Port of `src/server/knowledge/entityExtractor.ts` (1-188).
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `ExtractedEntity` (`:10-21`) | [`ExtractedEntity`] |
//! | `ExtractedEntity['relations']` (`:15-19`) | [`ExtractedRelation`], [`RelationDirection`] |
//! | `RELATION_WORDS` (`:24-43`) | [`RELATION_WORDS`] |
//! | `isRelationWord` (`:46-50`) | [`is_relation_word`] |
//! | `MergeVerdict` (`:52-58`) | [`MergeVerdict`], [`MergeAction`] |
//! | `EntityExtractor.normalizeEntities` (`:63-146`) | [`EntityExtractor::normalize_entities`] |
//! | `EntityExtractor.validateOwner` (`:152-171`) | [`EntityExtractor::validate_owner`] |
//! | `EntityExtractor.mergeWithExisting` (`:177-209`) | [`EntityExtractor::merge_with_existing`] |
//!
//! # Deviations
//!
//! * `sourceSeq` entries that are not whole numbers are truncated to `i64`.
//!   JavaScript keeps `2.5`, but a fractional message sequence cannot match any
//!   stored message anyway.
//! * `properties` is a `serde_json::Map` whose values are strings, like the
//!   `Record<string, string>` of the TypeScript. Insertion order is kept
//!   (the crate enables `preserve_order`).

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::knowledge::entity_graph::{
    EntityAlias, EntityCategory, EntityOwner, KnowledgeEntity, Properties,
};
use crate::knowledge::js_compat::{js_number, js_string, js_string_or_empty, js_truthy};
use crate::messages_store::StoredMessage;

/// `direction` of an extracted relation (`entityExtractor.ts:18`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RelationDirection {
    Outgoing,
    Incoming,
}

impl RelationDirection {
    /// The TypeScript union member, verbatim.
    pub fn as_str(self) -> &'static str {
        match self {
            RelationDirection::Outgoing => "outgoing",
            RelationDirection::Incoming => "incoming",
        }
    }
}

/// One entry of `ExtractedEntity.relations` (`entityExtractor.ts:15-19`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedRelation {
    pub target_name: String,
    /// Trimmed and lowercased.
    pub relation_type: String,
    pub direction: RelationDirection,
}

/// `ExtractedEntity` (`entityExtractor.ts:10-21`).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedEntity {
    pub name: String,
    pub category: EntityCategory,
    pub owner: EntityOwner,
    pub aliases: Vec<String>,
    pub relations: Vec<ExtractedRelation>,
    /// Values are JSON strings (`String(v)` of the model output).
    pub properties: Properties,
    pub source_seq: Vec<i64>,
}

/// `RELATION_WORDS` (`entityExtractor.ts:24-43`), German relation nouns.
pub const RELATION_WORDS: &[&str] = &[
    "bruder",
    "schwester",
    "mutter",
    "vater",
    "freund",
    "freundin",
    "tante",
    "onkel",
    "oma",
    "opa",
    "partner",
    "partnerin",
    "chef",
    "kollege",
    "kollegin",
    "nachbar",
    "nachbarin",
];

static POSSESSIVE_PREFIX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(mein|meine|dein|deine|sein|seine|ihr|ihre)\s+").expect("possessive prefix")
});

/// `isRelationWord` (`entityExtractor.ts:46-50`): `"mein Bruder"` and `"Bruder"`.
pub fn is_relation_word(alias: &str) -> bool {
    let lowered = alias.to_lowercase();
    let normalized = POSSESSIVE_PREFIX.replace(&lowered, "");
    RELATION_WORDS
        .iter()
        .any(|word| *word == normalized.as_ref())
}

/// `MergeVerdict.action` (`entityExtractor.ts:53`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeAction {
    Create,
    Merge,
}

/// `MergeVerdict` (`entityExtractor.ts:52-58`). `updates.properties` is
/// [`MergeVerdict::property_updates`], and the optional fields are `None`
/// where the TypeScript leaves them `undefined`.
#[derive(Debug, Clone, PartialEq)]
pub struct MergeVerdict {
    pub action: MergeAction,
    pub property_updates: Option<Properties>,
    pub new_aliases: Option<Vec<String>>,
    pub relations: Option<Vec<ExtractedRelation>>,
}

/// `EntityExtractor` (`entityExtractor.ts:61-209`). Stateless.
#[derive(Debug, Clone, Copy, Default)]
pub struct EntityExtractor;

/// The category names the TypeScript accepts (`entityExtractor.ts:82-89`).
fn parse_category(text: &str) -> Option<EntityCategory> {
    match text {
        "person" => Some(EntityCategory::Person),
        "project" => Some(EntityCategory::Project),
        "place" => Some(EntityCategory::Place),
        "organization" => Some(EntityCategory::Organization),
        "concept" => Some(EntityCategory::Concept),
        "object" => Some(EntityCategory::Object),
        _ => None,
    }
}

/// The owner names the TypeScript accepts (`entityExtractor.ts:95-97`).
fn parse_owner(text: &str) -> Option<EntityOwner> {
    match text {
        "persona" => Some(EntityOwner::Persona),
        "user" => Some(EntityOwner::User),
        "shared" => Some(EntityOwner::Shared),
        _ => None,
    }
}

/// `String(obj[key] || fallback)` for a model field.
fn text_or(object: &serde_json::Map<String, Value>, key: &str, fallback: &str) -> String {
    let value = object.get(key);
    if js_truthy(value) {
        js_string(value)
    } else {
        fallback.to_string()
    }
}

impl EntityExtractor {
    /// `normalizeEntities` (`entityExtractor.ts:63-146`). Accepts the raw
    /// `entities` value of the model output; anything that is not an array gives
    /// an empty list. Invalid entries (no name, unknown category or owner) are
    /// dropped.
    pub fn normalize_entities(
        &self,
        raw: &Value,
        messages: &[StoredMessage],
    ) -> Vec<ExtractedEntity> {
        let Some(items) = raw.as_array() else {
            return Vec::new();
        };

        let mut results = Vec::new();
        for item in items {
            let Some(object) = item.as_object() else {
                continue;
            };

            let name = js_string_or_empty(object.get("name")).trim().to_string();
            if name.is_empty() {
                continue;
            }

            let Some(category) = parse_category(&text_or(object, "category", "person")) else {
                continue;
            };
            let Some(owner) = parse_owner(&text_or(object, "owner", "shared")) else {
                continue;
            };

            let aliases: Vec<String> = object
                .get("aliases")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .map(|alias| js_string(Some(alias)).trim().to_string())
                        .filter(|alias| !alias.is_empty())
                        .collect()
                })
                .unwrap_or_default();

            let relations: Vec<ExtractedRelation> = object
                .get("relations")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_object)
                        .map(|relation| ExtractedRelation {
                            target_name: js_string_or_empty(relation.get("targetName"))
                                .trim()
                                .to_string(),
                            relation_type: js_string_or_empty(relation.get("relationType"))
                                .trim()
                                .to_lowercase(),
                            direction: if js_string(relation.get("direction")) == "incoming" {
                                RelationDirection::Incoming
                            } else {
                                RelationDirection::Outgoing
                            },
                        })
                        .filter(|relation| {
                            !relation.target_name.is_empty() && !relation.relation_type.is_empty()
                        })
                        .collect()
                })
                .unwrap_or_default();

            let properties: Properties = match object.get("properties") {
                Some(Value::Object(map)) => map
                    .iter()
                    .map(|(key, value)| (key.clone(), Value::String(js_string(Some(value)))))
                    .collect(),
                _ => Properties::new(),
            };

            let source_seq: Vec<i64> = object
                .get("sourceSeq")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .map(|seq| js_number(Some(seq)))
                        .filter(|seq| seq.is_finite() && *seq > 0.0)
                        .map(|seq| seq as i64)
                        .collect()
                })
                .unwrap_or_default();

            let entity = ExtractedEntity {
                name,
                category,
                owner,
                aliases,
                relations,
                properties,
                source_seq,
            };
            results.push(self.validate_owner(entity, messages));
        }
        results
    }

    /// `validateOwner` (`entityExtractor.ts:152-171`). When every source message
    /// has the same role, that role decides the owner, unless the owner is
    /// `shared`.
    pub fn validate_owner(
        &self,
        entity: ExtractedEntity,
        messages: &[StoredMessage],
    ) -> ExtractedEntity {
        if entity.source_seq.is_empty() {
            return entity;
        }

        let seq_to_role: HashMap<i64, &str> = messages
            .iter()
            .filter_map(|message| message.seq.map(|seq| (seq, message.role.as_str())))
            .collect();

        let roles: HashSet<&str> = entity
            .source_seq
            .iter()
            .filter_map(|seq| seq_to_role.get(seq).copied())
            .filter(|role| !role.is_empty())
            .collect();

        if roles.len() == 1 {
            let role = roles.into_iter().next().unwrap_or_default();
            let owner_from_role = if role == "user" {
                EntityOwner::User
            } else {
                EntityOwner::Persona
            };
            if entity.owner != EntityOwner::Shared {
                return ExtractedEntity {
                    owner: owner_from_role,
                    ..entity
                };
            }
        }
        entity
    }

    /// `mergeWithExisting` (`entityExtractor.ts:177-209`).
    pub fn merge_with_existing(
        &self,
        extracted: &ExtractedEntity,
        existing: Option<&KnowledgeEntity>,
        existing_aliases: &[EntityAlias],
    ) -> MergeVerdict {
        let relations = (!extracted.relations.is_empty()).then(|| extracted.relations.clone());

        let Some(existing) = existing else {
            return MergeVerdict {
                action: MergeAction::Create,
                property_updates: None,
                new_aliases: None,
                relations,
            };
        };

        let existing_alias_set: HashSet<String> = existing_aliases
            .iter()
            .map(|alias| alias.alias.to_lowercase())
            .collect();
        let new_aliases: Vec<String> = extracted
            .aliases
            .iter()
            .filter(|alias| !existing_alias_set.contains(&alias.to_lowercase()))
            .cloned()
            .collect();

        let mut new_properties = Properties::new();
        for (key, value) in &extracted.properties {
            let text = js_string(Some(value));
            // `existing.properties[key] !== value`: a missing key or a different
            // value (including a non-string one) counts as new.
            let unchanged = matches!(
                existing.properties.get(key),
                Some(Value::String(current)) if *current == text
            );
            if !unchanged {
                new_properties.insert(key.clone(), Value::String(text));
            }
        }

        MergeVerdict {
            action: MergeAction::Merge,
            property_updates: (!new_properties.is_empty()).then_some(new_properties),
            new_aliases: (!new_aliases.is_empty()).then_some(new_aliases),
            relations,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge::entity_graph::AliasType;
    use serde_json::json;

    fn message(seq: i64, role: &str) -> StoredMessage {
        StoredMessage {
            id: format!("m{seq}"),
            conversation_id: "c".into(),
            seq: Some(seq),
            role: role.into(),
            content: "x".into(),
            platform: "web".into(),
            external_msg_id: None,
            sender_name: None,
            metadata: None,
            created_at: String::new(),
        }
    }

    #[test]
    fn a_valid_entity_is_normalized() {
        let raw = json!([{
            "name": "  Max ",
            "category": "person",
            "owner": "shared",
            "aliases": [" Bruder ", ""],
            "relations": [{"targetName": "Nata", "relationType": " Bruder VON ", "direction": "incoming"}],
            "properties": {"nett": true},
            "sourceSeq": [1, 0, -2, "3"]
        }]);
        let entities = EntityExtractor.normalize_entities(&raw, &[]);
        assert_eq!(entities.len(), 1);
        let max = &entities[0];
        assert_eq!(max.name, "Max");
        assert_eq!(max.aliases, vec!["Bruder".to_string()]);
        assert_eq!(max.relations[0].relation_type, "bruder von");
        assert_eq!(max.relations[0].direction, RelationDirection::Incoming);
        assert_eq!(max.properties.get("nett"), Some(&json!("true")));
        assert_eq!(max.source_seq, vec![1, 3]);
    }

    #[test]
    fn entries_without_a_name_or_a_known_category_are_dropped() {
        let raw = json!([
            {"name": "  ", "category": "person"},
            {"name": "Berlin", "category": "city"},
            {"name": "Berlin", "category": "place", "owner": "robot"},
            {"name": "Berlin", "category": "place"}
        ]);
        let entities = EntityExtractor.normalize_entities(&raw, &[]);
        assert_eq!(entities.len(), 1);
        assert_eq!(entities[0].category, EntityCategory::Place);
        assert_eq!(entities[0].owner, EntityOwner::Shared);
    }

    #[test]
    fn a_non_array_gives_no_entities() {
        assert!(EntityExtractor
            .normalize_entities(&json!({"name": "x"}), &[])
            .is_empty());
    }

    #[test]
    fn a_single_source_role_decides_a_non_shared_owner() {
        let messages = vec![message(4, "user")];
        let raw = json!([
            {"name": "Max", "category": "person", "owner": "persona", "sourceSeq": [4]},
            {"name": "Anna", "category": "person", "owner": "shared", "sourceSeq": [4]}
        ]);
        let entities = EntityExtractor.normalize_entities(&raw, &messages);
        assert_eq!(entities[0].owner, EntityOwner::User);
        assert_eq!(entities[1].owner, EntityOwner::Shared);
    }

    #[test]
    fn relation_words_ignore_a_possessive_prefix() {
        assert!(is_relation_word("mein Bruder"));
        assert!(is_relation_word("Ihre Freundin"));
        assert!(!is_relation_word("Max"));
    }

    #[test]
    fn merge_reports_only_new_aliases_and_changed_properties() {
        let existing = KnowledgeEntity {
            id: "e-1".into(),
            user_id: "u".into(),
            persona_id: "p".into(),
            canonical_name: "Max".into(),
            category: EntityCategory::Person,
            owner: EntityOwner::Shared,
            properties: serde_json::from_value(json!({"nett": "ja"})).expect("map"),
            created_at: String::new(),
            updated_at: String::new(),
        };
        let aliases = vec![EntityAlias {
            id: "a-1".into(),
            entity_id: "e-1".into(),
            alias: "max".into(),
            alias_type: AliasType::Name,
            owner: EntityOwner::Shared,
            confidence: 1.0,
            created_at: String::new(),
        }];
        let extracted = ExtractedEntity {
            name: "Max".into(),
            category: EntityCategory::Person,
            owner: EntityOwner::Shared,
            aliases: vec!["Maxi".into(), "MAX".into()],
            relations: vec![],
            properties: serde_json::from_value(json!({"nett": "ja", "groesse": "groß"}))
                .expect("map"),
            source_seq: vec![],
        };
        let verdict = EntityExtractor.merge_with_existing(&extracted, Some(&existing), &aliases);
        assert_eq!(verdict.action, MergeAction::Merge);
        assert_eq!(verdict.new_aliases, Some(vec!["Maxi".to_string()]));
        let updates = verdict.property_updates.expect("groesse is new");
        assert_eq!(updates.len(), 1);
        assert_eq!(updates.get("groesse"), Some(&json!("groß")));
        assert_eq!(verdict.relations, None);
    }

    #[test]
    fn a_missing_entity_is_created_with_its_relations() {
        let extracted = ExtractedEntity {
            name: "Max".into(),
            category: EntityCategory::Person,
            owner: EntityOwner::User,
            aliases: vec![],
            relations: vec![ExtractedRelation {
                target_name: "Nata".into(),
                relation_type: "bruder von".into(),
                direction: RelationDirection::Outgoing,
            }],
            properties: Properties::new(),
            source_seq: vec![],
        };
        let verdict = EntityExtractor.merge_with_existing(&extracted, None, &[]);
        assert_eq!(verdict.action, MergeAction::Create);
        assert_eq!(verdict.relations.map(|r| r.len()), Some(1));
    }
}
