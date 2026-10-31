//! Port of `src/server/world-model/projector/normalizeExtraction.ts:1-87`.

use crate::world_model::types::{EventStatus, Modality};

use super::types::{
    ConfidenceSummary, ProjectedAssertion, ProjectedEntity, ProjectedEvent, ProjectedOpenLoop,
    ProjectedOpenLoopType, ProjectedRelation, ProjectedTask, WorldModelProjection,
};

#[derive(Debug, Clone, PartialEq)]
pub struct ExtractionEvent {
    pub event_type: String,
    pub subject: String,
    pub start_date: String,
    pub end_date: String,
    pub source_seq: Vec<i64>,
    pub confirmation_signals: Vec<String>,
    pub is_confirmation: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExtractionRelation {
    pub target_name: String,
    pub relation_type: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExtractionEntity {
    pub name: String,
    pub category: String,
    pub owner: String,
    pub aliases: Option<Vec<String>>,
    pub relations: Vec<ExtractionRelation>,
    pub source_seq: Vec<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct KnowledgeExtraction {
    pub facts: Vec<String>,
    pub events: Vec<ExtractionEvent>,
    pub entities: Vec<ExtractionEntity>,
    pub action_items: Vec<String>,
    pub open_points: Vec<String>,
    pub confidence: f64,
    pub episode: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NormalizeExtractionInput {
    pub result: KnowledgeExtraction,
    pub workspace_id: String,
    pub user_id: String,
    pub persona_id: String,
}

/// `normalizeExtraction(input)` — `normalizeExtraction.ts:25-95`.
pub fn normalize_extraction(input: &NormalizeExtractionInput) -> WorldModelProjection {
    let result = &input.result;
    let base_seq = result
        .events
        .first()
        .and_then(|event| event.source_seq.first())
        .copied()
        .unwrap_or(0);
    let confidence = if result.confidence == 0.0 || result.confidence.is_nan() {
        0.7
    } else {
        result.confidence
    };
    let assertions = result
        .facts
        .iter()
        .enumerate()
        .map(|(index, fact)| ProjectedAssertion {
            subject: input.persona_id.clone(),
            predicate: "fact".into(),
            object_value: Some(fact.clone()),
            modality: Modality::Reported,
            confidence,
            source_message_seq: base_seq + index as i64,
        })
        .collect();
    let events = result
        .events
        .iter()
        .map(|event| ProjectedEvent {
            title: if event.subject.is_empty() {
                event.event_type.clone()
            } else {
                event.subject.clone()
            },
            event_type: event.event_type.clone(),
            scheduled_for: (!event.start_date.is_empty()).then(|| event.start_date.clone()),
            ends_at: (!event.end_date.is_empty()).then(|| event.end_date.clone()),
            status: EventStatus::Planned,
            replaces_event_id: None,
            source_message_seq: event.source_seq.first().copied().unwrap_or(0),
        })
        .collect::<Vec<_>>();
    let entities = result
        .entities
        .iter()
        .map(|entity| ProjectedEntity {
            canonical_name: entity.name.clone(),
            category: entity.category.clone(),
            owner: entity.owner.clone(),
            aliases: entity.aliases.clone().unwrap_or_default(),
            source_message_seq: entity.source_seq.first().copied().unwrap_or(0),
        })
        .collect();
    let relations = result
        .entities
        .iter()
        .flat_map(|entity| {
            entity.relations.iter().map(|relation| ProjectedRelation {
                source_entity: entity.name.clone(),
                target_entity: relation.target_name.clone(),
                relation_type: relation.relation_type.clone(),
                confidence: if entity.source_seq.first().copied().unwrap_or(0) != 0 {
                    0.8
                } else {
                    0.7
                },
                source_message_seq: entity.source_seq.first().copied().unwrap_or(0),
            })
        })
        .collect();
    let tasks = result
        .action_items
        .iter()
        .enumerate()
        .map(|(index, title)| ProjectedTask {
            title: title.clone(),
            requester: input.user_id.clone(),
            assignee: input.persona_id.clone(),
            source_message_seq: base_seq + index as i64,
        })
        .collect();
    let open_loops = result
        .open_points
        .iter()
        .enumerate()
        .map(|(index, question)| ProjectedOpenLoop {
            loop_type: ProjectedOpenLoopType::MissingContext,
            question: Some(question.clone()),
            deduplication_key: question.clone(),
            source_message_seq: base_seq + index as i64,
        })
        .collect();
    let total = result.facts.len()
        + result.events.len()
        + result.entities.len()
        + relations_len(&result.entities)
        + result.action_items.len();
    WorldModelProjection {
        assertions,
        events: events.clone(),
        entities,
        relations,
        open_loops,
        tasks,
        confidence_summary: ConfidenceSummary {
            total,
            confident: events.len(),
        },
    }
}

fn relations_len(entities: &[ExtractionEntity]) -> usize {
    entities.iter().map(|entity| entity.relations.len()).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extraction_uses_conservative_facts_and_keeps_only_event_confidence() {
        let input = NormalizeExtractionInput {
            workspace_id: "w1".into(),
            user_id: "u1".into(),
            persona_id: "p1".into(),
            result: KnowledgeExtraction {
                facts: vec!["A".into(), "B".into()],
                events: vec![ExtractionEvent {
                    event_type: "meeting".into(),
                    subject: String::new(),
                    start_date: String::new(),
                    end_date: "2026-10-12".into(),
                    source_seq: vec![4],
                    confirmation_signals: vec![],
                    is_confirmation: false,
                }],
                entities: vec![ExtractionEntity {
                    name: "Kai".into(),
                    category: "person".into(),
                    owner: "shared".into(),
                    aliases: None,
                    relations: vec![ExtractionRelation {
                        target_name: "Mia".into(),
                        relation_type: "knows".into(),
                    }],
                    source_seq: vec![0],
                }],
                action_items: vec!["Call".into()],
                open_points: vec!["When?".into()],
                confidence: 0.0,
                episode: None,
            },
        };
        let projected = normalize_extraction(&input);
        assert_eq!(projected.assertions[0].modality, Modality::Reported);
        assert_eq!(projected.assertions[0].confidence, 0.7);
        assert_eq!(projected.events[0].title, "meeting");
        assert_eq!(projected.events[0].scheduled_for, None);
        assert_eq!(projected.events[0].ends_at.as_deref(), Some("2026-10-12"));
        assert_eq!(
            projected.relations[0].confidence, 0.7,
            "sequence zero is JS-falsy"
        );
        assert_eq!(projected.tasks[0].source_message_seq, 4);
        assert_eq!(projected.open_loops[0].source_message_seq, 4);
        assert_eq!(
            projected.confidence_summary,
            ConfidenceSummary {
                total: 6,
                confident: 1
            }
        );
    }
}
