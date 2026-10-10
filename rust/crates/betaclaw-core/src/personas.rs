//! Persona types and SQLite repository.
//!
//! Mirrors `src/server/personas/` in the TypeScript backend:
//!
//! | TypeScript                          | Rust                     |
//! | ----------------------------------- | ------------------------ |
//! | `src/shared/personaTypes.ts`        | [`types`]                |
//! | `personaWorkspace.ts`               | [`workspace`]            |
//! | `personaRepository.ts`              | [`repository`]           |
//!
//! `personaProjectWorkspace.ts` and `personaWorkspaceMigration.ts` are not part
//! of this slice; see the migration notes for the reasons.

pub mod repository;
pub mod types;
pub mod workspace;

pub use repository::{PersonaRepository, PersonaUpdate};
pub use types::{
    CreatePersonaInput, MemoryPersonaType, PersonaFileName, PersonaProfile, PersonaSummary,
    PersonaWithFiles, SystemPersonaKey, MAX_PERSONA_INSTRUCTION_CHARS, MEMORY_PERSONA_TYPES,
    PERSONA_FILE_NAMES, PERSONA_INSTRUCTION_FILES,
};
pub use workspace::{slugify_persona_name, PersonaWorkspace};
