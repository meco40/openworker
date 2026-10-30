//! Port of `src/server/clawhub/types.ts`.

use serde::Serialize;

use crate::stats::string_enum;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchItem {
    pub slug: String,
    pub version: String,
    pub title: String,
    pub score: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchParseResult {
    pub items: Vec<SearchItem>,
    pub parse_warnings: Vec<String>,
}

/// `ClawHubCliResult`. `exit_code` is always 0 on success, the only case that
/// returns a result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub command: String,
    pub argv: Vec<String>,
}

string_enum!(SkillStatus {
    Installed = "installed",
    Error = "error",
});

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRow {
    pub slug: String,
    pub version: String,
    pub title: String,
    pub status: SkillStatus,
    pub enabled: bool,
    pub local_path: String,
    pub installed_at: Option<String>,
    pub last_action_at: Option<String>,
    pub last_error: Option<String>,
    pub updated_at: String,
}

/// `UpsertClawHubSkillInput`. `enabled` is written only when present, so an
/// upsert without it keeps the stored flag.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpsertSkillInput {
    pub slug: String,
    pub version: String,
    pub title: String,
    pub status: SkillStatus,
    pub enabled: Option<bool>,
    pub local_path: String,
    pub installed_at: Option<String>,
    pub last_action_at: Option<String>,
    pub last_error: Option<String>,
}
