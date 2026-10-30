//! Port of `src/server/channels/messages/service/core/toolPolicy.ts`.

use crate::personas::types::{MemoryPersonaType, PersonaProfile};

/// `ROLEPLAY_TOOLS_DISABLED_MESSAGE` (`toolPolicy.ts:1-2`).
pub const ROLEPLAY_TOOLS_DISABLED_MESSAGE: &str =
    "Tools sind fuer diese Roleplay-Persona deaktiviert.";

/// `areToolsDisabledForPersona(persona)` (`toolPolicy.ts:4-12`). Only the roleplay
/// persona type disables tools; a missing persona leaves them enabled.
pub fn are_tools_disabled_for_persona(persona: Option<&PersonaProfile>) -> bool {
    matches!(
        persona,
        Some(p) if matches!(p.memory_persona_type, MemoryPersonaType::Roleplay)
    )
}
