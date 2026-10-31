//! Port of `src/server/channels/messages/service/projectGuard.ts`.
//!
//! Build intent without an active project triggers a clarification question. The
//! sanitising steps run in the TypeScript order: trim, collapse whitespace, strip
//! quote characters, then cap at 80 UTF-16 units. No second trim follows the quote
//! removal, so a name such as `' Notes'` keeps its inner space.

use std::sync::LazyLock;

use regex::Regex;

use crate::channels::messages::service::utils::js_regex::{js_regex, slice_utf16};

static BUILD_VERB_RE: LazyLock<Regex> = LazyLock::new(|| {
    js_regex(
        r"(?i)\b(erstelle|bau|baue|implementiere|entwickle|programmiere|schreibe|fixe|repariere|refactor|refaktoriere|build|create|implement|develop|code|write|fix|refactor)\b",
    )
});
static CODE_TARGET_RE: LazyLock<Regex> = LazyLock::new(|| {
    js_regex(
        r"(?i)\b(webapp|web-app|app|website|frontend|backend|fullstack|next\.?js|react|node\.?js|api|repo|repository|projekt|project|feature|funktion|component|komponente|datenbank|database|migration|test|tests|bug)\b",
    )
});
static DIRECT_ENGINEERING_CUE_RE: LazyLock<Regex> = LazyLock::new(|| {
    js_regex(
        r"(?i)\b(next\.?js|react|typescript|javascript|python|docker|git|pull request|commit|branch|worktree|npm|pnpm|yarn)\b",
    )
});
static AUTO_REPLY_RE: LazyLock<Regex> =
    LazyLock::new(|| js_regex(r"(?i)^(auto|egal|ja|yes|ok|okay|weiter|mach|go)$"));
static QUOTE_EDGE_RE: LazyLock<Regex> = LazyLock::new(|| js_regex(r#"^["'`]+|["'`]+$"#));

/// `GuardProjectSuggestion` (`projectGuard.ts:1-4`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuardProjectSuggestion {
    pub name: String,
    pub slug: String,
}

/// `isProjectRequiredIntent(content)` (`projectGuard.ts:13-24`).
pub fn is_project_required_intent(content: &str) -> bool {
    let normalized = content.trim();
    if normalized.is_empty() {
        return false;
    }
    if normalized.starts_with('/') {
        return false;
    }

    let has_build_verb = BUILD_VERB_RE.is_match(normalized);
    let has_code_target = CODE_TARGET_RE.is_match(normalized);
    if has_build_verb && has_code_target {
        return true;
    }

    DIRECT_ENGINEERING_CUE_RE.is_match(normalized) && has_build_verb
}

/// `sanitizeProjectName` (`projectGuard.ts:26-32`).
fn sanitize_project_name(value: &str) -> String {
    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let unquoted = QUOTE_EDGE_RE.replace_all(&collapsed, "");
    slice_utf16(&unquoted, 80).to_string()
}

/// `resolveProjectNameFromClarificationReply` (`projectGuard.ts:34-48`).
pub fn resolve_project_name_from_clarification_reply(
    reply: &str,
    original_task: &str,
) -> Option<String> {
    let reply = sanitize_project_name(reply);
    if reply.is_empty() {
        return None;
    }

    if AUTO_REPLY_RE.is_match(&reply) {
        let fallback = sanitize_project_name(original_task);
        return Some(if fallback.is_empty() {
            "Project".to_string()
        } else {
            fallback
        });
    }

    Some(reply)
}

/// `buildProjectClarificationPrompt({ projects })` (`projectGuard.ts:50-77`). Lists
/// at most five projects.
pub fn build_project_clarification_prompt(projects: &[GuardProjectSuggestion]) -> String {
    let mut lines: Vec<String> = vec![
        "Build/Code-Intent erkannt, aber es ist kein aktives Projekt gesetzt.".to_string(),
        String::new(),
        "Nenne bitte jetzt den Projektnamen (eine Antwort reicht).".to_string(),
        "Beispiel: `Notes`".to_string(),
        String::new(),
        "Danach erstelle ich das Projekt automatisch und setze die Aufgabe direkt end-to-end um."
            .to_string(),
        "Optional kannst du auch `auto` schreiben.".to_string(),
    ];

    let listed: Vec<&GuardProjectSuggestion> = projects.iter().take(5).collect();
    if !listed.is_empty() {
        lines.push(String::new());
        lines.push("Vorhandene Projekte:".to_string());
        for project in listed {
            lines.push(format!("- {} ({})", project.name, project.slug));
        }
        lines.push(String::new());
        lines.push(
            "Falls du eines davon nutzen willst, antworte mit dem genauen Namen oder nutze `/project use <id|slug|index>`."
                .to_string(),
        );
    }

    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_verb_with_code_target_needs_project() {
        assert!(is_project_required_intent(
            "Erstelle eine Webapp fuer Notizen"
        ));
        assert!(is_project_required_intent("implement the login feature"));
        assert!(!is_project_required_intent(
            "Erstelle ein Gedicht ueber Katzen"
        ));
        assert!(!is_project_required_intent("/build something"));
        assert!(!is_project_required_intent("   "));
    }

    #[test]
    fn engineering_cue_with_build_verb_needs_project() {
        assert!(is_project_required_intent("fix the docker setup"));
        assert!(!is_project_required_intent("docker is nice"));
    }

    #[test]
    fn auto_reply_falls_back_to_the_original_task() {
        assert_eq!(
            resolve_project_name_from_clarification_reply("  auto ", "Mein Kochbuch"),
            Some("Mein Kochbuch".to_string())
        );
        assert_eq!(
            resolve_project_name_from_clarification_reply("ja", "   "),
            Some("Project".to_string())
        );
    }

    #[test]
    fn explicit_name_is_sanitised_and_quotes_are_stripped() {
        assert_eq!(
            resolve_project_name_from_clarification_reply("  \"My   Notes\" ", "task"),
            Some("My Notes".to_string())
        );
        assert_eq!(
            resolve_project_name_from_clarification_reply("` ", "task"),
            None,
            "a reply that is only quotes and spaces is empty"
        );
    }

    #[test]
    fn name_is_capped_at_eighty_utf16_units() {
        let long = "x".repeat(120);
        let name = resolve_project_name_from_clarification_reply(&long, "t").expect("name");
        assert_eq!(name.len(), 80);
    }

    #[test]
    fn prompt_lists_at_most_five_projects() {
        let projects: Vec<GuardProjectSuggestion> = (0..7)
            .map(|index| GuardProjectSuggestion {
                name: format!("P{index}"),
                slug: format!("p-{index}"),
            })
            .collect();
        let prompt = build_project_clarification_prompt(&projects);
        assert!(prompt.contains("- P4 (p-4)"));
        assert!(!prompt.contains("P5"));
        assert!(prompt.ends_with("`/project use <id|slug|index>`."));
    }

    #[test]
    fn prompt_without_projects_has_no_list() {
        let prompt = build_project_clarification_prompt(&[]);
        assert!(!prompt.contains("Vorhandene Projekte"));
        assert!(prompt.ends_with("Optional kannst du auch `auto` schreiben."));
    }
}
