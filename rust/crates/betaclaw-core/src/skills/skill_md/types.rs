//! Port of `src/server/skills/skillMd/types.ts`.
//!
//! Two tiers. Tier-1 (built-in) SKILL.md files are additive: emoji, os, requires and body.
//! Tier-2 (user and workspace) files carry a full `tool:` block. The frontmatter is kept as a
//! JSON object, because the TypeScript code reads its fields one by one and never narrows
//! it further.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// `SkillSource`. Serialized with the TypeScript spelling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SkillSource {
    #[serde(rename = "bundled")]
    Bundled,
    #[serde(rename = "user")]
    User,
    #[serde(rename = "workspace")]
    Workspace,
    #[serde(rename = "env-override")]
    EnvOverride,
}

/// `ParsedSkillMd.tier`: `built-in` when the frontmatter has no `tool:`, `user` otherwise.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SkillTier {
    #[serde(rename = "built-in")]
    BuiltIn,
    #[serde(rename = "user")]
    User,
}

/// `ParsedSkillMd`: one SKILL.md file after parsing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedSkillMd {
    pub tier: SkillTier,
    pub frontmatter: Map<String, Value>,
    /// Markdown after the closing `---`, trimmed.
    pub body: String,
    pub file_path: String,
    pub source: SkillSource,
}

impl ParsedSkillMd {
    /// The frontmatter string field `key`, when it is one.
    pub fn str_field(&self, key: &str) -> Option<&str> {
        self.frontmatter.get(key).and_then(Value::as_str)
    }

    /// The frontmatter list of strings `key`. Entries that are not strings are skipped.
    pub fn string_list(&self, key: &str) -> Option<Vec<String>> {
        match self.frontmatter.get(key) {
            Some(Value::Array(items)) => Some(
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(str::to_string))
                    .collect(),
            ),
            _ => None,
        }
    }
}

/// `EnrichedSkill` (`skillMd/enricher.ts`): a skill with its tool definition and guidance.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrichedSkill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub category: String,
    pub function_name: String,
    pub tool: Value,
    pub emoji: Option<String>,
    pub body: String,
    pub file_path: String,
    pub source: SkillSource,
}
