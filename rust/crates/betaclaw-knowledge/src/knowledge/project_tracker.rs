//! Port of `src/server/knowledge/projectTracker.ts` (1-121).
//!
//! | TypeScript                                    | Rust |
//! | --------------------------------------------- | ---- |
//! | `projectTracker.ts:8-15` (`ProjectStatus`)     | [`ProjectStatus`] |
//! | `projectTracker.ts:17-22` (`ProjectState`)     | [`ProjectState`] |
//! | `projectTracker.ts:24-28` (`DisambiguationResult`) | [`DisambiguationResult`] |
//! | `projectTracker.ts:30-47` (`STATUS_PATTERNS`)  | [`status_patterns`] |
//! | `projectTracker.ts:50-54` (`VERSION_SUFFIX`, `V_PREFIX_SUFFIX`, `RESTART_SIGNAL`) | [`version_suffix`], [`v_prefix_suffix`], [`restart_signal`] |
//! | `projectTracker.ts:60-67` (`detectProjectStatusSignal`) | [`detect_project_status_signal`] |
//! | `projectTracker.ts:77-121` (`disambiguateProject`) | [`disambiguate_project`] |
//!
//! Pure functions for project status detection and name disambiguation. No
//! service dependency; dependency of `ingestion/service.ts` (S6-owned).
//!
//! # JavaScript semantics that are reproduced explicitly
//!
//! * `STATUS_PATTERNS` is walked in declaration order and the **first** match
//!   wins (`:61-64`), so `"deployed"` outranks `"maintenance"` in a text that
//!   mentions both.
//! * `Array.prototype.find` returns the first match, so an exact-name hit on a
//!   duplicate entity name takes the earlier entry.
//! * `^(.+?)(\d+)$` and `^(.+?)\s+v(\d+)$` are lazy (`:50-51`); the port keeps
//!   the non-greedy quantifiers, which is why `"Notes3"` yields the base
//!   `"Notes"` and the version `"3"`.
//! * `vMatch[1].trim().toLowerCase()` (`:100`) trims the base name before the
//!   lookup, so `"Dashboard  v2"` still finds `"dashboard"`.
//! * The fall-through returns `{ action: 'create_version' }` **without** an
//!   `existingId` (`:120`) — a new project, not a merge. The port keeps the
//!   absent id as [`None`].
//!
//! # Regex justification
//!
//! The status patterns need non-capturing groups and word boundaries (`:30-54`)
//! and the two version patterns need lazy quantifiers plus capture groups; both
//! come from the `regex` crate the workspace already depends on for this class
//! of pattern. The expected values in the tests were produced with Node 24.

use regex::Regex;
use std::sync::OnceLock;

/// `ProjectStatus` (`projectTracker.ts:8-15`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectStatus {
    Idea,
    Design,
    InProgress,
    Deployed,
    Maintenance,
    Paused,
    Abandoned,
}

impl ProjectStatus {
    /// The TypeScript union member, verbatim.
    pub fn as_str(self) -> &'static str {
        match self {
            ProjectStatus::Idea => "idea",
            ProjectStatus::Design => "design",
            ProjectStatus::InProgress => "in_progress",
            ProjectStatus::Deployed => "deployed",
            ProjectStatus::Maintenance => "maintenance",
            ProjectStatus::Paused => "paused",
            ProjectStatus::Abandoned => "abandoned",
        }
    }
}

/// `ProjectState` (`projectTracker.ts:17-22`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectState {
    pub entity_id: String,
    pub entity_name: String,
    pub status: ProjectStatus,
    pub last_worked_on: String,
}

/// `DisambiguationResult` (`projectTracker.ts:24-28`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DisambiguationResult {
    pub action: DisambiguationAction,
    pub existing_id: Option<String>,
    pub version: Option<String>,
}

/// `DisambiguationResult.action` (`projectTracker.ts:25`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DisambiguationAction {
    UseExisting,
    CreateVersion,
}

impl DisambiguationAction {
    /// The TypeScript union member, verbatim.
    pub fn as_str(self) -> &'static str {
        match self {
            DisambiguationAction::UseExisting => "use_existing",
            DisambiguationAction::CreateVersion => "create_version",
        }
    }
}

/// `STATUS_PATTERNS` (`projectTracker.ts:30-47`), in declaration order.
pub fn status_patterns() -> &'static [(Regex, ProjectStatus)] {
    static PATTERNS: OnceLock<Vec<(Regex, ProjectStatus)>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            (
                r"(?i)\b(?:live|deployed|released|veroeffentlicht|veröffentlicht|auf vercel|auf prod)\b",
                ProjectStatus::Deployed,
            ),
            (r"(?i)\b(?:pausiert|on hold|pause|ruht)\b", ProjectStatus::Paused),
            (
                r"(?i)\b(?:aufgegeben|eingestellt|abgebrochen|cancelled|abandoned)\b",
                ProjectStatus::Abandoned,
            ),
            (r"(?i)\b(?:wartung|maintenance|bugfix)\b", ProjectStatus::Maintenance),
            (r"(?i)\b(?:idee|idea|konzept|concept)\b", ProjectStatus::Idea),
            (r"(?i)\b(?:design|entwurf|planung)\b", ProjectStatus::Design),
            (
                r"(?i)\b(?:arbeite|coding|implementier|develop|baue|programmier)\b",
                ProjectStatus::InProgress,
            ),
        ]
        .into_iter()
        .map(|(pattern, status)| (Regex::new(pattern).expect("status pattern"), status))
        .collect()
    })
}

/// `/^(.+?)(\d+)$/` (`projectTracker.ts:50`).
pub fn version_suffix() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"^(.+?)(\d+)$").expect("version suffix pattern"))
}

/// `/^(.+?)\s+v(\d+)$/i` (`projectTracker.ts:51`).
pub fn v_prefix_suffix() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"(?i)^(.+?)\s+v(\d+)$").expect("v-prefix pattern"))
}

/// `RESTART_SIGNAL` (`projectTracker.ts:54`).
pub fn restart_signal() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?i)\b(?:neu bauen|komplett neu|von vorne|restart|rewrite|v2)\b")
            .expect("restart signal pattern")
    })
}

/// `detectProjectStatusSignal(text)` (`projectTracker.ts:60-67`).
pub fn detect_project_status_signal(text: &str) -> Option<ProjectStatus> {
    status_patterns()
        .iter()
        .find(|(pattern, _)| pattern.is_match(text))
        .map(|(_, status)| *status)
}

/// `disambiguateProject(mentionedName, existingProjects, messageContext)`
/// (`projectTracker.ts:77-121`).
pub fn disambiguate_project(
    mentioned_name: &str,
    existing_projects: &[ProjectState],
    message_context: &str,
) -> DisambiguationResult {
    let lower = mentioned_name.to_lowercase();

    // 1. Exact match (case-insensitive).
    if let Some(exact_match) = existing_projects
        .iter()
        .find(|project| project.entity_name.to_lowercase() == lower)
    {
        if restart_signal().is_match(message_context) {
            return DisambiguationResult {
                action: DisambiguationAction::CreateVersion,
                existing_id: Some(exact_match.entity_id.clone()),
                version: None,
            };
        }
        return DisambiguationResult {
            action: DisambiguationAction::UseExisting,
            existing_id: Some(exact_match.entity_id.clone()),
            version: None,
        };
    }

    // 2. "Dashboard v2" → base "Dashboard", version "v2".
    if let Some(captures) = v_prefix_suffix().captures(mentioned_name) {
        let base_name = captures[1].trim().to_lowercase();
        let version = format!("v{}", &captures[2]);
        if let Some(base_project) = existing_projects
            .iter()
            .find(|project| project.entity_name.to_lowercase() == base_name)
        {
            return DisambiguationResult {
                action: DisambiguationAction::CreateVersion,
                existing_id: Some(base_project.entity_id.clone()),
                version: Some(version),
            };
        }
    }

    // 3. "Notes3" → base "Notes", version "3".
    if let Some(captures) = version_suffix().captures(mentioned_name) {
        let base_name = captures[1].trim().to_lowercase();
        let version = captures[2].to_string();
        if let Some(base_project) = existing_projects
            .iter()
            .find(|project| project.entity_name.to_lowercase() == base_name)
        {
            return DisambiguationResult {
                action: DisambiguationAction::CreateVersion,
                existing_id: Some(base_project.entity_id.clone()),
                version: Some(version),
            };
        }
    }

    // 4. No match found → create a new project without an existing id.
    DisambiguationResult {
        action: DisambiguationAction::CreateVersion,
        existing_id: None,
        version: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(id: &str, name: &str) -> ProjectState {
        ProjectState {
            entity_id: id.to_string(),
            entity_name: name.to_string(),
            status: ProjectStatus::Idea,
            last_worked_on: "2026-01-01T00:00:00.000Z".to_string(),
        }
    }

    #[test]
    fn the_first_status_pattern_wins() {
        assert_eq!(
            detect_project_status_signal("das ist live"),
            Some(ProjectStatus::Deployed)
        );
        // Both `live` and `wartung` appear; declaration order decides.
        assert_eq!(
            detect_project_status_signal("live und in wartung"),
            Some(ProjectStatus::Deployed)
        );
        assert_eq!(
            detect_project_status_signal("ich arbeite daran"),
            Some(ProjectStatus::InProgress)
        );
        assert_eq!(detect_project_status_signal("nix"), None);
    }

    #[test]
    fn an_exact_name_uses_the_existing_project() {
        let projects = vec![project("e1", "Notes")];
        assert_eq!(
            disambiguate_project("Notes", &projects, "weiter"),
            DisambiguationResult {
                action: DisambiguationAction::UseExisting,
                existing_id: Some("e1".to_string()),
                version: None,
            }
        );
        // Case-insensitive in both directions.
        assert_eq!(
            disambiguate_project("notes", &projects, "weiter").action,
            DisambiguationAction::UseExisting
        );
    }

    #[test]
    fn a_restart_signal_turns_an_exact_match_into_a_new_version() {
        let projects = vec![project("e1", "Notes")];
        let result = disambiguate_project("Notes", &projects, "komplett neu bauen");
        assert_eq!(result.action, DisambiguationAction::CreateVersion);
        assert_eq!(result.existing_id.as_deref(), Some("e1"));
        // The restart branch carries no version string.
        assert_eq!(result.version, None);
    }

    #[test]
    fn a_numeric_suffix_versions_the_base_project() {
        let projects = vec![project("e1", "Notes")];
        let result = disambiguate_project("Notes3", &projects, "y");
        assert_eq!(result.action, DisambiguationAction::CreateVersion);
        assert_eq!(result.existing_id.as_deref(), Some("e1"));
        assert_eq!(result.version.as_deref(), Some("3"));
    }

    #[test]
    fn a_v_prefix_versions_the_lowercased_base_project() {
        let projects = vec![project("e2", "dashboard")];
        let result = disambiguate_project("Dashboard v2", &projects, "y");
        assert_eq!(result.action, DisambiguationAction::CreateVersion);
        assert_eq!(result.existing_id.as_deref(), Some("e2"));
        assert_eq!(result.version.as_deref(), Some("v2"));
    }

    #[test]
    fn an_unknown_name_creates_a_version_without_an_existing_id() {
        let result = disambiguate_project("Neu", &[], "y");
        assert_eq!(result.action, DisambiguationAction::CreateVersion);
        assert_eq!(result.existing_id, None);
        assert_eq!(result.version, None);
    }

    #[test]
    fn a_suffix_without_a_base_project_falls_through() {
        let projects = vec![project("e1", "Notes")];
        let result = disambiguate_project("Other3", &projects, "y");
        assert_eq!(result.existing_id, None);
        assert_eq!(result.version, None);
    }
}
