//! Port of `src/shared/personaTypes.ts`.
//!
//! The TypeScript file is the shared contract between server and UI; the Rust
//! port only needs the server half. Field names are re-serialised in camelCase
//! so a `PersonaSummary` serialises byte-identically to the object the Next.js
//! route returns.

use serde::{Deserialize, Serialize};

/// `MAX_PERSONA_INSTRUCTION_CHARS` from `personaTypes.ts:4`.
pub const MAX_PERSONA_INSTRUCTION_CHARS: usize = 4000;

/// `MEMORY_PERSONA_TYPES` from `personaTypes.ts:13-18`.
pub const MEMORY_PERSONA_TYPES: &[&str] = &["general", "roleplay", "builder", "assistant"];

/// `MemoryPersonaType` from `personaTypes.ts:7`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemoryPersonaType {
    Roleplay,
    Builder,
    Assistant,
    General,
}

impl MemoryPersonaType {
    pub fn as_str(self) -> &'static str {
        match self {
            MemoryPersonaType::Roleplay => "roleplay",
            MemoryPersonaType::Builder => "builder",
            MemoryPersonaType::Assistant => "assistant",
            MemoryPersonaType::General => "general",
        }
    }

    /// Mirrors `MEMORY_PERSONA_TYPES.includes(value)`, which
    /// `personaRepository.ts:292` uses to silently drop unknown values.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "roleplay" => Some(MemoryPersonaType::Roleplay),
            "builder" => Some(MemoryPersonaType::Builder),
            "assistant" => Some(MemoryPersonaType::Assistant),
            "general" => Some(MemoryPersonaType::General),
            _ => None,
        }
    }
}

/// `SystemPersonaKey` from `personaTypes.ts:11`. Only `master` exists today.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SystemPersonaKey {
    Master,
}

impl SystemPersonaKey {
    pub fn as_str(self) -> &'static str {
        match self {
            SystemPersonaKey::Master => "master",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "master" => Some(SystemPersonaKey::Master),
            _ => None,
        }
    }
}

/// `PersonaFileName` from `personaTypes.ts:28-34`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum PersonaFileName {
    Soul,
    Identity,
    Agents,
    User,
    Tools,
    Heartbeat,
}

/// `PERSONA_FILE_NAMES` from `personaTypes.ts:36-43`. The order drives the
/// iteration in `ensurePersonaFiles` and in `getPersonaSystemInstruction`.
pub const PERSONA_FILE_NAMES: &[PersonaFileName] = &[
    PersonaFileName::Soul,
    PersonaFileName::Identity,
    PersonaFileName::Agents,
    PersonaFileName::User,
    PersonaFileName::Tools,
    PersonaFileName::Heartbeat,
];

/// `PERSONA_INSTRUCTION_FILES` from `personaTypes.ts:59`.
pub const PERSONA_INSTRUCTION_FILES: &[PersonaFileName] = &[
    PersonaFileName::Soul,
    PersonaFileName::Agents,
    PersonaFileName::User,
];

impl PersonaFileName {
    pub fn as_str(self) -> &'static str {
        match self {
            PersonaFileName::Soul => "SOUL.md",
            PersonaFileName::Identity => "IDENTITY.md",
            PersonaFileName::Agents => "AGENTS.md",
            PersonaFileName::User => "USER.md",
            PersonaFileName::Tools => "TOOLS.md",
            PersonaFileName::Heartbeat => "HEARTBEAT.md",
        }
    }

    /// Mirrors `PERSONA_FILE_NAMES.includes(filename)`.
    pub fn parse(value: &str) -> Option<Self> {
        PERSONA_FILE_NAMES
            .iter()
            .copied()
            .find(|name| name.as_str() == value)
    }
}

impl std::fmt::Display for PersonaFileName {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// `PersonaProfile` from `personaTypes.ts:61-77`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonaProfile {
    pub id: String,
    pub name: String,
    pub slug: String,
    pub emoji: String,
    pub vibe: String,
    pub system_persona_key: Option<SystemPersonaKey>,
    pub preferred_model_id: Option<String>,
    pub model_hub_profile_id: Option<String>,
    pub memory_persona_type: MemoryPersonaType,
    pub is_autonomous: bool,
    pub max_tool_calls: i64,
    pub allowed_tool_function_names: Vec<String>,
    pub user_id: String,
    pub created_at: String,
    pub updated_at: String,
}

/// `PersonaWithFiles` from `personaTypes.ts:79-81`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonaWithFiles {
    #[serde(flatten)]
    pub persona: PersonaProfile,
    /// Keys are [`PERSONA_FILE_NAMES`]; every entry is present and may be empty,
    /// because `getPersonaWithFiles` fills all of them (`personaRepository.ts:193-198`).
    pub files: Vec<(String, String)>,
}

/// `PersonaSummary` from `personaTypes.ts:83-97`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonaSummary {
    pub id: String,
    pub name: String,
    pub slug: String,
    pub emoji: String,
    pub vibe: String,
    pub system_persona_key: Option<SystemPersonaKey>,
    pub preferred_model_id: Option<String>,
    pub model_hub_profile_id: Option<String>,
    pub memory_persona_type: MemoryPersonaType,
    pub is_autonomous: bool,
    pub max_tool_calls: i64,
    pub allowed_tool_function_names: Vec<String>,
    pub updated_at: String,
}

/// `CreatePersonaInput` from `personaTypes.ts:99-112`.
///
/// `Option` fields mirror the `?` modifier; the route in `app/api/personas/route.ts`
/// is what applies defaults such as the `🤖` emoji.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CreatePersonaInput {
    pub name: String,
    pub emoji: String,
    pub vibe: String,
    pub user_id: String,
    pub system_persona_key: Option<SystemPersonaKey>,
    pub preferred_model_id: Option<String>,
    pub model_hub_profile_id: Option<String>,
    pub memory_persona_type: Option<MemoryPersonaType>,
    pub is_autonomous: Option<bool>,
    pub max_tool_calls: Option<i64>,
    pub allowed_tool_function_names: Option<Vec<String>>,
    pub files: Option<Vec<(String, String)>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_keep_the_typescript_order() {
        let names: Vec<&str> = PERSONA_FILE_NAMES.iter().map(|n| n.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "SOUL.md",
                "IDENTITY.md",
                "AGENTS.md",
                "USER.md",
                "TOOLS.md",
                "HEARTBEAT.md"
            ]
        );
    }

    #[test]
    fn instruction_files_are_soul_agents_user() {
        let names: Vec<&str> = PERSONA_INSTRUCTION_FILES
            .iter()
            .map(|n| n.as_str())
            .collect();
        assert_eq!(names, vec!["SOUL.md", "AGENTS.md", "USER.md"]);
        assert_eq!(MAX_PERSONA_INSTRUCTION_CHARS, 4000);
    }

    #[test]
    fn file_name_round_trips() {
        for name in PERSONA_FILE_NAMES {
            assert_eq!(PersonaFileName::parse(name.as_str()), Some(*name));
        }
        assert_eq!(PersonaFileName::parse("README.md"), None);
        assert_eq!(PersonaFileName::Soul.to_string(), "SOUL.md");
    }

    #[test]
    fn memory_persona_types_match_the_shared_list() {
        for value in MEMORY_PERSONA_TYPES {
            let parsed = MemoryPersonaType::parse(value).expect("listed type must parse");
            assert_eq!(parsed.as_str(), *value);
        }
        assert_eq!(MemoryPersonaType::parse("wizard"), None);
        assert_eq!(
            serde_json::to_value(MemoryPersonaType::Roleplay).expect("serialize"),
            serde_json::Value::String("roleplay".into())
        );
    }

    #[test]
    fn system_persona_key_only_knows_master() {
        assert_eq!(
            SystemPersonaKey::parse("master"),
            Some(SystemPersonaKey::Master)
        );
        assert_eq!(SystemPersonaKey::parse("admin"), None);
        assert_eq!(
            serde_json::to_value(SystemPersonaKey::Master).expect("serialize"),
            serde_json::Value::String("master".into())
        );
    }

    #[test]
    fn persona_profile_serialises_in_camel_case() {
        let profile = PersonaProfile {
            id: "id".into(),
            name: "Ada".into(),
            slug: "ada".into(),
            emoji: "🤖".into(),
            vibe: "curious".into(),
            system_persona_key: Some(SystemPersonaKey::Master),
            preferred_model_id: None,
            model_hub_profile_id: None,
            memory_persona_type: MemoryPersonaType::General,
            is_autonomous: false,
            max_tool_calls: 120,
            allowed_tool_function_names: vec!["shell".into()],
            user_id: "user-1".into(),
            created_at: "2026-01-01T00:00:00.000Z".into(),
            updated_at: "2026-01-01T00:00:00.000Z".into(),
        };
        let value = serde_json::to_value(&profile).expect("serialize");
        for key in [
            "systemPersonaKey",
            "preferredModelId",
            "modelHubProfileId",
            "memoryPersonaType",
            "isAutonomous",
            "maxToolCalls",
            "allowedToolFunctionNames",
            "userId",
            "createdAt",
            "updatedAt",
        ] {
            assert!(value.get(key).is_some(), "missing camelCase key {key}");
        }
    }
}
