//! Mirrors `src/shared/domain/swarmPhases.ts`: canonical swarm phases, labels, round
//! counts and the prompt builders for a whole phase or a single agent turn.

use serde::{Deserialize, Serialize};

use super::types::SwarmUnit;

/// `SWARM_PHASES`, in execution order.
pub const SWARM_PHASES: [SwarmPhase; 6] = [
    SwarmPhase::Analysis,
    SwarmPhase::Research,
    SwarmPhase::Ideation,
    SwarmPhase::Critique,
    SwarmPhase::BestCase,
    SwarmPhase::Result,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SwarmPhase {
    Analysis,
    Research,
    Ideation,
    Critique,
    BestCase,
    Result,
}

/// `ResolvedSwarmUnit`: a swarm unit with its display name and emoji.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedSwarmUnit {
    pub persona_id: String,
    pub role: String,
    pub name: String,
    pub emoji: String,
}

impl SwarmPhase {
    /// Wire value, as the TypeScript side stores it.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Analysis => "analysis",
            Self::Research => "research",
            Self::Ideation => "ideation",
            Self::Critique => "critique",
            Self::BestCase => "best_case",
            Self::Result => "result",
        }
    }

    /// `isSwarmPhase`: `None` for an unknown phase name.
    pub fn parse(value: &str) -> Option<Self> {
        SWARM_PHASES
            .into_iter()
            .find(|phase| phase.as_str() == value)
    }

    /// `getSwarmPhaseLabel`
    pub fn label(self) -> &'static str {
        match self {
            Self::Analysis => "Analysis",
            Self::Research => "Research",
            Self::Ideation => "Ideation",
            Self::Critique => "Critique",
            Self::BestCase => "Best Case",
            Self::Result => "Result",
        }
    }

    /// `getPhaseRounds`
    pub fn rounds(self) -> u32 {
        match self {
            Self::Analysis | Self::Research | Self::BestCase | Self::Result => 1,
            Self::Ideation => 2,
            Self::Critique => 3,
        }
    }

    /// `getNextSwarmPhase`: `None` after the last phase.
    pub fn next(self) -> Option<Self> {
        let index = SWARM_PHASES.iter().position(|phase| *phase == self)?;
        SWARM_PHASES.get(index + 1).copied()
    }

    fn prompt_text(self) -> &'static str {
        match self {
            Self::Analysis => {
                "Analysiert die Aufgabe und benennt Kernannahmen, Risiken und Randbedingungen."
            }
            Self::Research => {
                "Recherchiert belastbare externe Quellen und sammelt faktenbasierte Evidenz."
            }
            Self::Ideation => "Erstellt mehrere Lösungswege mit klaren Trade-offs.",
            Self::Critique => "Prüft die Ideen kritisch, sucht Schwächen und Widersprüche.",
            Self::BestCase => "Einigt euch auf die bestmögliche Lösung mit klarer Begründung.",
            Self::Result => "Liefert ein finales, umsetzbares Ergebnis inkl. kurzer Begründung.",
        }
    }
}

/// `buildPhasePrompt`
pub fn build_phase_prompt(
    task: &str,
    phase: SwarmPhase,
    lead_persona_id: Option<&str>,
    units: &[SwarmUnit],
) -> String {
    let task = task.trim();
    let lead = lead_persona_id.unwrap_or("").trim();
    let unit_lines: Vec<String> = units
        .iter()
        .map(|unit| format!("{}: {}", unit.role.trim(), unit.persona_id.trim()))
        .filter(|entry| entry != ":")
        .collect();
    let scope = [
        if lead.is_empty() {
            String::new()
        } else {
            format!("LEAD PERSONA: {lead}")
        },
        if unit_lines.is_empty() {
            String::new()
        } else {
            format!("SWARM UNITS:\n- {}", unit_lines.join("\n- "))
        },
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join("\n\n");
    [
        format!("SWARM PHASE: {}", phase.label()),
        phase.prompt_text().to_string(),
        scope,
        format!("TASK: {task}"),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join("\n\n")
}

/// `buildAgentTurnPrompt`
pub fn build_agent_turn_prompt(
    task: &str,
    phase: SwarmPhase,
    unit: &ResolvedSwarmUnit,
    agent_index: usize,
    prior_responses: &[String],
    is_last_agent_in_phase: bool,
) -> String {
    let task = task.trim();
    let identity = format!(
        "Du bist {} **{}**, {}, in einem KI-Agenten-Swarm.",
        unit.emoji, unit.name, unit.role
    );
    let prior_context = if agent_index > 0 && !prior_responses.is_empty() {
        format!(
            "Die anderen Agenten haben bereits in dieser Phase geantwortet:\n\n{}",
            prior_responses.join("\n\n")
        )
    } else {
        String::new()
    };
    let diagram_instruction = if is_last_agent_in_phase && phase == SwarmPhase::Result {
        "\n- Füge am Ende deiner Antwort EINEN ```mermaid```-Codeblock ein, der die empfohlene Lösung als Diagramm darstellt (z.B. Flussdiagramm, Komponentendiagramm oder Sequenzdiagramm)."
    } else {
        ""
    };
    let instructions = [
        format!("Beginne deine Antwort GENAU mit: **[{}]:**", unit.name),
        format!(
            "Antworte NUR als {} ({}) – schreibe NICHT für andere Agenten.",
            unit.name, unit.role
        ),
        if agent_index > 0 {
            "Beziehe dich auf die bisherigen Antworten: stimme zu, widersprich oder ergänze sie konkret."
                .to_string()
        } else {
            String::new()
        },
        "Sei spezifisch, direkt und nutze deine Expertise.".to_string(),
        diagram_instruction.to_string(),
    ]
    .into_iter()
    .filter(|line| !line.is_empty())
    .collect::<Vec<_>>()
    .join("\n");
    [
        identity,
        format!("SWARM PHASE: {}", phase.label()),
        phase.prompt_text().to_string(),
        prior_context,
        format!("AUFGABE: {task}"),
        format!("ANWEISUNGEN:\n{instructions}"),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_follows_the_order_and_stops_after_result() {
        assert_eq!(SwarmPhase::Analysis.next(), Some(SwarmPhase::Research));
        assert_eq!(SwarmPhase::Result.next(), None);
    }

    #[test]
    fn parse_round_trips_the_wire_value() {
        assert_eq!(SwarmPhase::parse("best_case"), Some(SwarmPhase::BestCase));
        assert_eq!(SwarmPhase::parse("bogus"), None);
    }

    #[test]
    fn phase_prompt_carries_label_and_trimmed_task() {
        let prompt = build_phase_prompt("  Ship it ", SwarmPhase::Analysis, None, &[]);
        assert!(prompt.starts_with("SWARM PHASE: Analysis"));
        assert!(prompt.ends_with("TASK: Ship it"));
    }
}
