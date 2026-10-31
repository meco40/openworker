//! Port of `src/server/knowledge/conversationSummaryPrompts.ts` (1-48).
//!
//! | TypeScript                                            | Rust |
//! | ----------------------------------------------------- | ---- |
//! | `conversationSummaryPrompts.ts:11` (`PersonaType` import) | [`crate::personas::types::MemoryPersonaType`] |
//! | `conversationSummaryPrompts.ts:13-41` (`SUMMARY_PROMPTS`) | [`summary_prompt`] |
//! | `conversationSummaryPrompts.ts:46-48` (`getSummaryPrompt`) | [`summary_prompt`] |
//!
//! `PersonaType` is `MemoryPersonaType` in the shared contract
//! (`src/shared/personaTypes.ts:7`), which [`crate::personas`] already carries —
//! the same substitution [`super::persona_strategies`] made.
//!
//! # Deviations
//!
//! 1. `SUMMARY_PROMPTS` is a `Record<PersonaType, string>`; the port exposes a
//!    total function over the closed [`MemoryPersonaType`] enum instead of a
//!    map, so a missing entry cannot become `undefined`.
//! 2. The template literals are copied verbatim, including the quotation marks
//!    around the roleplay example. They are prompt text that the ingestion
//!    package reads, not retrieval.

use crate::personas::types::MemoryPersonaType;

/// `SUMMARY_PROMPTS[personaType]` (`conversationSummaryPrompts.ts:13-41`).
///
/// Each persona type gets a different summarization style: narrative for
/// roleplay, a status report for builder, a task list for assistant, and a
/// concise overview for general.
pub fn summary_prompt(persona_type: MemoryPersonaType) -> &'static str {
    match persona_type {
        MemoryPersonaType::Roleplay => {
            r#"Fasse das Gespraech als NARRATIVE zusammen.
Fokus auf: Emotionale Entwicklung, Beziehungs-Dynamik, wichtige geteilte Momente.
Schreibe in dritter Person. Beispiel:
"Nata und der User sprachen ueber ihre Kindheit. Nata war emotional bewegt und teilte
eine persoenliche Geschichte ueber ihren Bruder Max. Der Ton war vertraut und warmherzig."
Nenne: Emotionaler Verlauf, Gefuehle, Beziehungs-Updates, geteilte Erlebnisse."#
        }
        MemoryPersonaType::Builder => {
            r"Fasse das Gespraech als STATUS-REPORT zusammen.
Fokus auf: Was wurde gebaut/geaendert, welche Tech-Entscheidungen, offene Issues.
Format:
- Projekt: [Name]
- Erledigt: [Was wurde fertig]
- Offen: [Was noch fehlt]
- Tech-Stack: [Genutzte Technologien]
- Entscheidungen: [Warum wir X statt Y genommen haben]"
        }
        MemoryPersonaType::Assistant => {
            r"Fasse das Gespraech als AUFGABEN-STATUS zusammen.
Fokus auf: Neue Tasks, erledigte Tasks, verschobene Deadlines, geaenderte Preferences.
Format:
- Neue Aufgaben: [Task + Deadline falls vorhanden]
- Erledigt: [Was abgehakt wurde]
- Geaendert: [Umplanungen, neue Infos]
- Dauerhafte Preferences: [Neue Vorlieben/Abneigungen]"
        }
        MemoryPersonaType::General => {
            r"Fasse das Gespraech in 2-4 Saetzen zusammen.
Nenne die Hauptthemen und wichtigsten Ergebnisse.
Schreibe in dritter Person."
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_persona_type_has_its_own_summary_prompt() {
        assert!(summary_prompt(MemoryPersonaType::Roleplay)
            .starts_with("Fasse das Gespraech als NARRATIVE"));
        assert!(summary_prompt(MemoryPersonaType::Builder)
            .starts_with("Fasse das Gespraech als STATUS-REPORT"));
        assert!(summary_prompt(MemoryPersonaType::Assistant)
            .starts_with("Fasse das Gespraech als AUFGABEN-STATUS"));
        assert!(summary_prompt(MemoryPersonaType::General)
            .starts_with("Fasse das Gespraech in 2-4 Saetzen"));
    }

    #[test]
    fn the_prompts_are_verbatim_including_the_quoted_example() {
        let roleplay = summary_prompt(MemoryPersonaType::Roleplay);
        assert!(roleplay.contains("\"Nata und der User sprachen ueber ihre Kindheit."));
        // No trailing newline: the template literal ends right after the last
        // sentence.
        assert!(roleplay.ends_with("geteilte Erlebnisse."));

        let builder = summary_prompt(MemoryPersonaType::Builder);
        assert!(builder.contains("- Tech-Stack: [Genutzte Technologien]"));
    }
}
