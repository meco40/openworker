//! Port of `src/server/skills/skillActivation.ts`.
//!
//! `assertSkillActive` accepts a function name in either spelling (`vendor.tool` or
//! `vendor_tool`) and matches it against the stored function name, the skill id or the
//! tool name inside the tool definition. The first row in creation order wins, as in
//! TypeScript. The error quotes the caller's name as given, before trimming.
//!
//! Not ported: the process-wide repository lookup. The repository is passed in.

use std::collections::HashSet;

use serde_json::Value;

use super::store::SkillRepository;
use super::types::{js_string_or_empty, js_trim, SkillError};

/// Fails with `Skill is not active: <name>` unless the first matching row is installed.
pub fn assert_skill_active(
    repository: &SkillRepository,
    function_name: &str,
) -> Result<(), SkillError> {
    let normalized = js_trim(function_name);
    let candidates: HashSet<String> = [normalized.to_string(), normalized.replace('.', "_")]
        .into_iter()
        .collect();

    let skills = repository.list_skills()?;
    let skill = skills.iter().find(|row| {
        // `String(toolDefinition.name || '')` for an object, '' for anything else.
        let tool_name = match &row.tool_definition {
            Value::Object(map) => js_string_or_empty(map.get("name").unwrap_or(&Value::Null)),
            _ => String::new(),
        };
        candidates.contains(&row.function_name)
            || candidates.contains(&row.id)
            || candidates.contains(&tool_name)
    });

    match skill {
        Some(skill) if skill.installed => Ok(()),
        _ => Err(SkillError(format!("Skill is not active: {function_name}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::builtin_skills::built_in_skills;
    use crate::skills::store::InstallSkillInput;
    use serde_json::json;

    fn repository() -> SkillRepository {
        let repository = SkillRepository::in_memory().expect("open in-memory store");
        repository
            .seed_built_ins(&built_in_skills())
            .expect("seed built-ins");
        repository
    }

    fn install(repository: &SkillRepository, id: &str, function_name: &str, tool_name: &str) {
        repository
            .install_skill(&InstallSkillInput {
                id: Some(id.to_string()),
                name: id.to_string(),
                description: String::new(),
                category: "Custom".to_string(),
                version: "1.0.0".to_string(),
                function_name: function_name.to_string(),
                source: "manual".to_string(),
                source_url: None,
                tool_definition: json!({ "name": tool_name }),
                handler_path: None,
            })
            .expect("install");
    }

    #[test]
    fn installed_built_in_is_active_under_its_function_name() {
        assert_skill_active(&repository(), "browser_snapshot").expect("active");
    }

    #[test]
    fn dotted_name_matches_the_underscore_spelling() {
        let repository = repository();
        install(&repository, "row-dot", "vendor_tool", "vendor_tool");
        assert_skill_active(&repository, "vendor.tool").expect("active");
    }

    #[test]
    fn matches_by_skill_id_and_by_tool_name() {
        let repository = repository();
        install(&repository, "row-id", "unrelated_fn", "tool_by_name");
        assert_skill_active(&repository, "row-id").expect("matched by id");
        assert_skill_active(&repository, "tool_by_name").expect("matched by tool name");
    }

    #[test]
    fn inactive_seeded_skill_is_refused() {
        let error = assert_skill_active(&repository(), "github_query").expect_err("inactive");
        assert_eq!(error.0, "Skill is not active: github_query");
    }

    #[test]
    fn unknown_name_is_refused_with_the_name_as_given() {
        let error = assert_skill_active(&repository(), "  nope  ").expect_err("unknown");
        assert_eq!(error.0, "Skill is not active:   nope  ");
    }
}
