//! Port of `src/server/knowledge/ingestion/entityExtractor.ts` (1-216).
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `EntityProcessingContext` / `EntityProcessingResult` (`:11-22`) | [`EntityProcessingContext`], [`EntityProcessingResult`] |
//! | `PendingRelation` (`:24-31`, private) | the pairs in [`store_entities`] |
//! | `normalizeSelfReferences` (`:36-56`) | [`normalize_self_references`] |
//! | `validateEventSpeakerRoles` (`:62-89`) | [`validate_event_speaker_roles`] |
//! | `storeEntities` (`:101-216`) | [`store_entities`] |
//! | `KnowledgeRepositoryLike` entity methods (`types.ts:28-35`) | [`EntityWriteStore`] |
//!
//! # Deviations
//!
//! * `storeEntities` is synchronous in the TypeScript too; the port keeps that.
//! * The TypeScript returns early when a repository method is missing. The port's
//!   trait always has them, so that guard is not needed.
//! * `validateEventSpeakerRoles` takes `&mut [ExtractedEvent]`. The TypeScript
//!   accepts `undefined`; the caller passes an empty slice for that.

use std::collections::HashSet;

use serde_json::Value;

use crate::knowledge::create_id;
use crate::knowledge::entity_extractor::{
    is_relation_word, EntityExtractor, ExtractedEntity, ExtractedRelation, MergeAction,
    RelationDirection,
};
use crate::knowledge::entity_graph::{
    AliasType, EntityAlias, EntityCategory, EntityGraphFilter, EntityLookupResult, EntityOwner,
    KnowledgeEntity, Properties,
};
use crate::knowledge::event_extractor::ExtractedEvent;
use crate::knowledge::ingestion::constants::DEFAULT_RELATION_CONFIDENCE;
use crate::knowledge::ingestion_cursor::IngestionWindow;
use crate::knowledge::multilingual_aliases::expand_multilingual_aliases;
use crate::knowledge::project_tracker::detect_project_status_signal;
use crate::knowledge::repository::{
    AddEntityAliasInput, AddEntityRelationInput, KnowledgeError, KnowledgeRepository,
    UpsertKnowledgeEntityInput,
};
use crate::messages_store::StoredMessage;

/// `EntityProcessingContext` (`entityExtractor.ts:11-14`).
#[derive(Debug, Clone)]
pub struct EntityProcessingContext<'a> {
    pub window: &'a IngestionWindow,
    pub entities: Vec<ExtractedEntity>,
}

/// `EntityProcessingResult` (`entityExtractor.ts:16-20`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct EntityProcessingResult {
    pub created: usize,
    pub merged: usize,
    pub relations_added: usize,
}

/// The entity methods of `KnowledgeRepositoryLike` (`types.ts:28-35`). A blanket
/// implementation covers every [`KnowledgeRepository`].
pub trait EntityWriteStore {
    fn resolve_entity(
        &self,
        text: &str,
        filter: &EntityGraphFilter,
    ) -> Result<Option<EntityLookupResult>, KnowledgeError>;
    /// `getEntityWithRelations(entityId).aliases`.
    fn entity_aliases(&self, entity_id: &str) -> Result<Vec<EntityAlias>, KnowledgeError>;
    fn upsert_entity(
        &self,
        input: &UpsertKnowledgeEntityInput,
    ) -> Result<KnowledgeEntity, KnowledgeError>;
    fn add_alias(&self, alias: &AddEntityAliasInput) -> Result<(), KnowledgeError>;
    fn update_entity_properties(
        &self,
        entity_id: &str,
        properties: &Properties,
    ) -> Result<(), KnowledgeError>;
    fn add_relation(&self, relation: &AddEntityRelationInput) -> Result<(), KnowledgeError>;
}

impl<R: KnowledgeRepository + ?Sized> EntityWriteStore for R {
    fn resolve_entity(
        &self,
        text: &str,
        filter: &EntityGraphFilter,
    ) -> Result<Option<EntityLookupResult>, KnowledgeError> {
        KnowledgeRepository::resolve_entity(self, text, filter)
    }

    fn entity_aliases(&self, entity_id: &str) -> Result<Vec<EntityAlias>, KnowledgeError> {
        KnowledgeRepository::get_entity_with_relations(self, entity_id).map(|found| found.aliases)
    }

    fn upsert_entity(
        &self,
        input: &UpsertKnowledgeEntityInput,
    ) -> Result<KnowledgeEntity, KnowledgeError> {
        KnowledgeRepository::upsert_entity(self, input)
    }

    fn add_alias(&self, alias: &AddEntityAliasInput) -> Result<(), KnowledgeError> {
        KnowledgeRepository::add_alias(self, alias)
    }

    fn update_entity_properties(
        &self,
        entity_id: &str,
        properties: &Properties,
    ) -> Result<(), KnowledgeError> {
        KnowledgeRepository::update_entity_properties(self, entity_id, properties)
    }

    fn add_relation(&self, relation: &AddEntityRelationInput) -> Result<(), KnowledgeError> {
        KnowledgeRepository::add_relation(self, relation)
    }
}

/// The self-reference names of `normalizeSelfReferences` and
/// `normalizeExtractionSelfReferences`: `ich`, `me`, `myself` and the persona id.
pub(crate) fn self_reference_set(persona_id: &str) -> HashSet<String> {
    ["ich", "me", "myself"]
        .iter()
        .map(|word| word.to_string())
        .chain(std::iter::once(persona_id.to_lowercase()))
        .collect()
}

/// `normalizeSelfReferences(entities, personaName, personaId)` (`entityExtractor.ts:36-56`).
/// Entity names and relation targets that are self-references become the persona name.
pub fn normalize_self_references(
    entities: &mut [ExtractedEntity],
    persona_name: &str,
    persona_id: &str,
) {
    if persona_name == persona_id {
        return;
    }
    let self_refs = self_reference_set(persona_id);
    for entity in entities {
        if self_refs.contains(&entity.name.to_lowercase()) {
            entity.name = persona_name.to_string();
        }
        for relation in &mut entity.relations {
            if self_refs.contains(&relation.target_name.to_lowercase()) {
                relation.target_name = persona_name.to_string();
            }
        }
    }
}

/// `validateEventSpeakerRoles(events, entities, personaName)` (`entityExtractor.ts:62-89`).
/// The subject decides the speaker: the persona name means assistant, a known
/// user person means user.
pub fn validate_event_speaker_roles(
    events: &mut [ExtractedEvent],
    entities: &[ExtractedEntity],
    persona_name: &str,
) {
    use crate::knowledge::event_types::SpeakerRole;

    if persona_name.is_empty() {
        return;
    }
    let mut user_entity_names: HashSet<String> = HashSet::new();
    user_entity_names.insert("user".to_string());
    for entity in entities {
        if entity.owner == EntityOwner::User && entity.category == EntityCategory::Person {
            user_entity_names.insert(entity.name.to_lowercase());
        }
    }

    let persona_lower = persona_name.to_lowercase();
    for event in events {
        let subject_lower = event.subject.to_lowercase();
        if subject_lower == persona_lower && event.speaker_role != SpeakerRole::Assistant {
            event.speaker_role = SpeakerRole::Assistant;
        } else if user_entity_names.contains(&subject_lower)
            && event.speaker_role != SpeakerRole::User
        {
            event.speaker_role = SpeakerRole::User;
        }
    }
}

/// Order-preserving de-duplication, like a JavaScript `Set`.
fn ordered_unique(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.clone()))
        .collect()
}

/// The alias type of an alias: a relation word, or a name.
fn alias_type_for(alias: &str) -> AliasType {
    if is_relation_word(alias) {
        AliasType::Relation
    } else {
        AliasType::Name
    }
}

/// The aliases of `expandedNewAliases` / `allAliases`: the given aliases plus
/// their multilingual expansions, in first-seen order.
fn with_expansions(aliases: &[String]) -> Vec<String> {
    ordered_unique(
        aliases.iter().cloned().chain(
            aliases
                .iter()
                .flat_map(|alias| expand_multilingual_aliases(alias)),
        ),
    )
}

/// `storeEntities(repo, context)` (`entityExtractor.ts:101-216`). Pass 1 creates
/// or merges every entity and its aliases. Pass 2 adds the relations, once all
/// entities exist.
pub fn store_entities<R: EntityWriteStore + ?Sized>(
    repo: &R,
    context: &EntityProcessingContext<'_>,
) -> Result<EntityProcessingResult, KnowledgeError> {
    let window = context.window;
    let mut result = EntityProcessingResult::default();
    if context.entities.is_empty() {
        return Ok(result);
    }

    let extractor = EntityExtractor;
    let graph_filter = EntityGraphFilter {
        user_id: window.user_id.clone(),
        persona_id: window.persona_id.clone(),
        category: None,
        owner: None,
    };

    // PASS 1: create or merge entities and aliases; no relations yet.
    let mut pending_relations: Vec<(String, Vec<ExtractedRelation>)> = Vec::new();
    for raw in &context.entities {
        let validated = extractor.validate_owner(raw.clone(), &window.messages);
        if validated.name.is_empty() {
            continue;
        }

        let existing = repo.resolve_entity(&validated.name, &graph_filter)?;
        let existing_aliases = match existing.as_ref() {
            Some(found) => repo.entity_aliases(&found.entity.id)?,
            None => Vec::new(),
        };
        let verdict = extractor.merge_with_existing(
            &validated,
            existing.as_ref().map(|found| &found.entity),
            &existing_aliases,
        );

        let entity_id = match (verdict.action, existing.as_ref()) {
            (MergeAction::Create, _) | (_, None) => {
                let created = repo.upsert_entity(&UpsertKnowledgeEntityInput {
                    id: create_id("ent"),
                    user_id: window.user_id.clone(),
                    persona_id: window.persona_id.clone(),
                    canonical_name: validated.name.clone(),
                    category: validated.category,
                    owner: validated.owner,
                    properties: validated.properties.clone(),
                })?;
                result.created += 1;

                for alias in with_expansions(&validated.aliases) {
                    repo.add_alias(&AddEntityAliasInput {
                        entity_id: created.id.clone(),
                        alias_type: alias_type_for(&alias),
                        alias,
                        owner: validated.owner,
                        confidence: DEFAULT_RELATION_CONFIDENCE,
                    })?;
                }

                if validated.category == EntityCategory::Project {
                    let message_text = window
                        .messages
                        .iter()
                        .map(|message: &StoredMessage| message.content.as_str())
                        .collect::<Vec<_>>()
                        .join(" ");
                    if let Some(status) = detect_project_status_signal(&message_text) {
                        let mut properties = validated.properties.clone();
                        properties.insert(
                            "projectStatus".to_string(),
                            Value::String(status.as_str().to_string()),
                        );
                        repo.update_entity_properties(&created.id, &properties)?;
                    }
                }
                created.id
            }
            (MergeAction::Merge, Some(found)) => {
                let entity_id = found.entity.id.clone();
                result.merged += 1;

                if let Some(new_aliases) = verdict
                    .new_aliases
                    .as_ref()
                    .filter(|aliases| !aliases.is_empty())
                {
                    for alias in with_expansions(new_aliases) {
                        repo.add_alias(&AddEntityAliasInput {
                            entity_id: entity_id.clone(),
                            alias_type: alias_type_for(&alias),
                            alias,
                            owner: validated.owner,
                            confidence: DEFAULT_RELATION_CONFIDENCE,
                        })?;
                    }
                }
                if let Some(properties) = &verdict.property_updates {
                    repo.update_entity_properties(&entity_id, properties)?;
                }
                entity_id
            }
        };

        if let Some(relations) = verdict.relations.filter(|relations| !relations.is_empty()) {
            pending_relations.push((entity_id, relations));
        }
    }

    // PASS 2: relations, once every entity of the window exists.
    for (entity_id, relations) in pending_relations {
        for relation in relations {
            let Some(target) = repo.resolve_entity(&relation.target_name, &graph_filter)? else {
                continue;
            };
            let outgoing = relation.direction == RelationDirection::Outgoing;
            repo.add_relation(&AddEntityRelationInput {
                source_entity_id: if outgoing {
                    entity_id.clone()
                } else {
                    target.entity.id.clone()
                },
                target_entity_id: if outgoing {
                    target.entity.id.clone()
                } else {
                    entity_id.clone()
                },
                relation_type: relation.relation_type,
                properties: Properties::new(),
                confidence: DEFAULT_RELATION_CONFIDENCE,
            })?;
            result.relations_added += 1;
        }
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge::entity_extractor::{ExtractedRelation, RelationDirection};
    use crate::knowledge::event_types::SpeakerRole;

    fn entity(name: &str, owner: EntityOwner, category: EntityCategory) -> ExtractedEntity {
        ExtractedEntity {
            name: name.to_string(),
            category,
            owner,
            aliases: vec![],
            relations: vec![],
            properties: Properties::new(),
            source_seq: vec![],
        }
    }

    #[test]
    fn self_references_become_the_persona_name() {
        let mut entities = vec![
            entity("Ich", EntityOwner::Persona, EntityCategory::Person),
            entity("Max", EntityOwner::Shared, EntityCategory::Person),
        ];
        entities[1].relations.push(ExtractedRelation {
            target_name: "myself".to_string(),
            relation_type: "freund von".to_string(),
            direction: RelationDirection::Outgoing,
        });
        normalize_self_references(&mut entities, "Nata", "p-1");
        assert_eq!(entities[0].name, "Nata");
        assert_eq!(entities[1].relations[0].target_name, "Nata");
        assert_eq!(entities[1].name, "Max");
    }

    #[test]
    fn the_persona_id_as_a_name_is_a_self_reference() {
        let mut entities = vec![entity("Lea", EntityOwner::Persona, EntityCategory::Person)];
        normalize_self_references(&mut entities, "Nata", "lea");
        assert_eq!(entities[0].name, "Nata");
    }

    #[test]
    fn the_subject_decides_the_speaker_role() {
        let mut events = vec![ExtractedEvent {
            event_type: "visit".into(),
            speaker_role: SpeakerRole::User,
            subject: "Nata".into(),
            counterpart: "Max".into(),
            relation_label: None,
            time_expression: String::new(),
            start_date: String::new(),
            end_date: String::new(),
            day_count: 1,
            is_confirmation: false,
            confirmation_signals: vec![],
            source_seq: vec![],
        }];
        validate_event_speaker_roles(&mut events, &[], "Nata");
        assert_eq!(events[0].speaker_role, SpeakerRole::Assistant);
    }

    #[test]
    fn the_alias_type_follows_the_relation_words() {
        assert_eq!(alias_type_for("mein Bruder"), AliasType::Relation);
        assert_eq!(alias_type_for("Max"), AliasType::Name);
    }

    #[test]
    fn expansions_keep_the_first_seen_order_without_duplicates() {
        let aliases = with_expansions(&["Max".to_string(), "Max".to_string()]);
        assert_eq!(aliases.first().map(String::as_str), Some("Max"));
        assert_eq!(
            aliases
                .iter()
                .filter(|alias| alias.as_str() == "Max")
                .count(),
            1
        );
    }
}
