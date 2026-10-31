//! Port of `src/server/knowledge/personaStrategies.ts` (1-133).
//!
//! | TypeScript                                        | Rust |
//! | ------------------------------------------------- | ---- |
//! | `personaStrategies.ts:11-12` (`PersonaType`)       | [`crate::personas::types::MemoryPersonaType`] |
//! | `personaStrategies.ts:14-26` (`PersonaMemoryStrategy`) | [`PersonaMemoryStrategy`] |
//! | `personaStrategies.ts:28-99` (`PERSONA_STRATEGIES`) | [`persona_strategy`] |
//! | `personaStrategies.ts:101-104` (`NodeMetadata`)    | [`NodeMetadata`] |
//! | `personaStrategies.ts:109-133` (`adjustScoreByStrategy`) | [`adjust_score_by_strategy`] |
//!
//! Dependency of `retrieval/ranking/episodeRanker.ts:3`; it lives at the
//! knowledge root because that is where its TypeScript original lives.
//!
//! # Deviations
//!
//! 1. `NodeMetadata.type` is a JavaScript property name; the port spells the
//!    field `node_type`.
//! 2. `PERSONA_STRATEGIES` is a `Record<PersonaType, PersonaMemoryStrategy>`
//!    and `adjustScoreByStrategy` guards it with `?? PERSONA_STRATEGIES.general`
//!    (`:114`). The port exposes a lookup function over the closed
//!    [`MemoryPersonaType`], so the fallback cannot be selected.
//! 3. The `extractionPromptAddition` template literals are copied verbatim,
//!    including the leading newline of each block. They are prompt text that
//!    the ingestion package reads, not retrieval.

use crate::personas::types::MemoryPersonaType;

/// `PersonaMemoryStrategy.recallWeights` from `personaStrategies.ts:17-22`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PersonaRecallWeights {
    pub emotional_relevance: f64,
    pub recency: f64,
    pub task_relevance: f64,
    pub project_relevance: f64,
}

/// `PersonaMemoryStrategy.summaryStyle` from `personaStrategies.ts:24`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SummaryStyle {
    Narrative,
    StatusReport,
    TaskList,
    Balanced,
}

/// `PersonaMemoryStrategy.consolidationAggressiveness`
/// (`personaStrategies.ts:25`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConsolidationAggressiveness {
    Conservative,
    Moderate,
    Aggressive,
}

/// `PersonaMemoryStrategy` from `personaStrategies.ts:14-26`.
#[derive(Debug, Clone, PartialEq)]
pub struct PersonaMemoryStrategy {
    pub persona_type: MemoryPersonaType,
    pub extraction_prompt_addition: &'static str,
    pub recall_weights: PersonaRecallWeights,
    pub preferred_memory_types: &'static [&'static str],
    pub summary_style: SummaryStyle,
    pub consolidation_aggressiveness: ConsolidationAggressiveness,
}

/// `NodeMetadata` from `personaStrategies.ts:101-104`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NodeMetadata {
    pub emotional_tone: Option<String>,
    pub node_type: Option<String>,
}

/// `PERSONA_STRATEGIES[personaType]` (`personaStrategies.ts:28-99`).
pub fn persona_strategy(persona_type: MemoryPersonaType) -> &'static PersonaMemoryStrategy {
    static ROLEPLAY: PersonaMemoryStrategy = PersonaMemoryStrategy {
        persona_type: MemoryPersonaType::Roleplay,
        extraction_prompt_addition: r"
ROLEPLAY-MODUS:
- Emotionale Zustaende explizit extrahieren
- Beziehungs-Updates priorisieren
- Narrative Kontinuitaet beachten
- Traum-Sequenzen als solche markieren",
        recall_weights: PersonaRecallWeights {
            emotional_relevance: 0.9,
            recency: 0.6,
            task_relevance: 0.1,
            project_relevance: 0.1,
        },
        preferred_memory_types: &[
            "emotional_event",
            "relationship_update",
            "shared_experience",
            "fact",
        ],
        summary_style: SummaryStyle::Narrative,
        consolidation_aggressiveness: ConsolidationAggressiveness::Conservative,
    };

    static BUILDER: PersonaMemoryStrategy = PersonaMemoryStrategy {
        persona_type: MemoryPersonaType::Builder,
        extraction_prompt_addition: r"
BUILDER-MODUS:
- Projekt-Milestones extrahieren
- Tech-Entscheidungen festhalten
- Bug-Reports und Loesungen als Paar speichern
- Projekt-Status tracken",
        recall_weights: PersonaRecallWeights {
            emotional_relevance: 0.1,
            recency: 0.8,
            task_relevance: 0.7,
            project_relevance: 0.9,
        },
        preferred_memory_types: &[
            "project_milestone",
            "tech_decision",
            "bug_report",
            "code_reference",
        ],
        summary_style: SummaryStyle::StatusReport,
        consolidation_aggressiveness: ConsolidationAggressiveness::Aggressive,
    };

    static ASSISTANT: PersonaMemoryStrategy = PersonaMemoryStrategy {
        persona_type: MemoryPersonaType::Assistant,
        extraction_prompt_addition: r"
ASSISTENT-MODUS:
- Termine und Deadlines als strukturierte Tasks extrahieren
- Erledigungs-Signale erkennen
- Bei Terminen: Datum, Uhrzeit, Ort
- Preferences langfristig merken",
        recall_weights: PersonaRecallWeights {
            emotional_relevance: 0.3,
            recency: 0.9,
            task_relevance: 0.9,
            project_relevance: 0.3,
        },
        preferred_memory_types: &[
            "task",
            "deadline",
            "preference",
            "recurring_pattern",
            "fact",
        ],
        summary_style: SummaryStyle::TaskList,
        consolidation_aggressiveness: ConsolidationAggressiveness::Moderate,
    };

    static GENERAL: PersonaMemoryStrategy = PersonaMemoryStrategy {
        persona_type: MemoryPersonaType::General,
        extraction_prompt_addition: "",
        recall_weights: PersonaRecallWeights {
            emotional_relevance: 0.5,
            recency: 0.7,
            task_relevance: 0.5,
            project_relevance: 0.5,
        },
        preferred_memory_types: &["fact", "event", "preference"],
        summary_style: SummaryStyle::Balanced,
        consolidation_aggressiveness: ConsolidationAggressiveness::Moderate,
    };

    match persona_type {
        MemoryPersonaType::Roleplay => &ROLEPLAY,
        MemoryPersonaType::Builder => &BUILDER,
        MemoryPersonaType::Assistant => &ASSISTANT,
        MemoryPersonaType::General => &GENERAL,
    }
}

/// `adjustScoreByStrategy` from `personaStrategies.ts:109-133`.
///
/// Three independent multiplicative boosts, in the source's order: emotional
/// tone, task/deadline, project milestone/tech decision. A score that matches
/// none stays untouched.
pub fn adjust_score_by_strategy(
    base_score: f64,
    persona_type: MemoryPersonaType,
    metadata: &NodeMetadata,
) -> f64 {
    let strategy = persona_strategy(persona_type);
    let mut adjusted = base_score;

    // Emotional relevance boost
    if metadata.emotional_tone.is_some() {
        adjusted *= 1.0 + strategy.recall_weights.emotional_relevance * 0.3;
    }

    // Task relevance boost
    match metadata.node_type.as_deref() {
        Some("task") | Some("deadline") => {
            adjusted *= 1.0 + strategy.recall_weights.task_relevance * 0.4;
        }
        _ => {}
    }

    // Project relevance boost
    match metadata.node_type.as_deref() {
        Some("project_milestone") | Some("tech_decision") => {
            adjusted *= 1.0 + strategy.recall_weights.project_relevance * 0.4;
        }
        _ => {}
    }

    adjusted
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_persona_type_has_its_own_strategy() {
        assert_eq!(
            persona_strategy(MemoryPersonaType::Roleplay).summary_style,
            SummaryStyle::Narrative
        );
        assert_eq!(
            persona_strategy(MemoryPersonaType::Builder).consolidation_aggressiveness,
            ConsolidationAggressiveness::Aggressive
        );
        assert_eq!(
            persona_strategy(MemoryPersonaType::Assistant).preferred_memory_types,
            [
                "task",
                "deadline",
                "preference",
                "recurring_pattern",
                "fact"
            ]
        );
        assert_eq!(
            persona_strategy(MemoryPersonaType::General).extraction_prompt_addition,
            ""
        );
        assert!(persona_strategy(MemoryPersonaType::Roleplay)
            .extraction_prompt_addition
            .starts_with("\nROLEPLAY-MODUS:\n- Emotionale Zustaende explizit extrahieren"));
        assert_eq!(
            persona_strategy(MemoryPersonaType::General).recall_weights,
            PersonaRecallWeights {
                emotional_relevance: 0.5,
                recency: 0.7,
                task_relevance: 0.5,
                project_relevance: 0.5,
            }
        );
    }

    #[test]
    fn only_the_emotional_tone_of_a_roleplay_fact_scales_a_score() {
        let metadata = NodeMetadata {
            emotional_tone: Some("traurig".to_string()),
            node_type: None,
        };
        // roleplay: 1.0 + 0.9 * 0.3 = 1.27
        assert_eq!(
            adjust_score_by_strategy(1.0, MemoryPersonaType::Roleplay, &metadata),
            1.27
        );
        // general: 1.0 + 0.5 * 0.3 = 1.15
        assert_eq!(
            adjust_score_by_strategy(1.0, MemoryPersonaType::General, &metadata),
            1.15
        );
    }

    #[test]
    fn the_task_and_project_boosts_match_the_source_type_names() {
        let task = NodeMetadata {
            emotional_tone: None,
            node_type: Some("deadline".to_string()),
        };
        // assistant: 1.0 + 0.9 * 0.4 = 1.36
        assert_eq!(
            adjust_score_by_strategy(1.0, MemoryPersonaType::Assistant, &task),
            1.36
        );

        let project = NodeMetadata {
            emotional_tone: None,
            node_type: Some("project_milestone".to_string()),
        };
        // builder: 1.0 + 0.9 * 0.4 = 1.36
        assert_eq!(
            adjust_score_by_strategy(1.0, MemoryPersonaType::Builder, &project),
            1.36
        );

        let unknown = NodeMetadata {
            emotional_tone: None,
            node_type: Some("sauna".to_string()),
        };
        assert_eq!(
            adjust_score_by_strategy(0.4, MemoryPersonaType::Builder, &unknown),
            0.4
        );
        assert_eq!(
            adjust_score_by_strategy(0.4, MemoryPersonaType::General, &NodeMetadata::default()),
            0.4
        );
    }

    #[test]
    fn both_boosts_can_apply_to_the_same_node() {
        let both = NodeMetadata {
            emotional_tone: Some("freude".to_string()),
            node_type: Some("task".to_string()),
        };
        // general: (1 + 0.5*0.3) * (1 + 0.5*0.4) = 1.15 * 1.2
        assert_eq!(
            adjust_score_by_strategy(1.0, MemoryPersonaType::General, &both),
            1.15 * 1.2
        );
    }
}
