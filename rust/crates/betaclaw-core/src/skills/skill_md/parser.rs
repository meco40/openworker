//! Port of `src/server/skills/skillMd/parser.ts`.
//!
//! Splits a SKILL.md file into its YAML frontmatter and its Markdown body, checks the
//! required fields and returns a [`ParsedSkillMd`]. Errors are returned as messages, the
//! text the TypeScript code throws.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;

use super::types::{ParsedSkillMd, SkillSource, SkillTier};
use super::yaml;

/// Required frontmatter fields of a Tier-2 file (`REQUIRED_USER_FIELDS`).
const REQUIRED_USER_FIELDS: [&str; 7] = [
    "id",
    "name",
    "description",
    "version",
    "category",
    "functionName",
    "tool",
];

/// `parseSkillMd(content, filePath, source)`.
pub fn parse_skill_md(
    content: &str,
    file_path: &str,
    source: SkillSource,
) -> Result<ParsedSkillMd, String> {
    static FRONTMATTER: OnceLock<Regex> = OnceLock::new();
    let pattern = FRONTMATTER.get_or_init(|| {
        Regex::new(r"^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)").expect("valid regex")
    });
    let Some(matched) = pattern.captures(content) else {
        return Err(format!(
            "SKILL.md at \"{file_path}\" is missing a YAML frontmatter block (expected opening and closing ---)."
        ));
    };
    let whole = matched.get(0).map_or(0, |m| m.end());
    let body = content[whole..].trim().to_string();

    let raw = yaml::parse(&matched[1]).map_err(|error| {
        format!("SKILL.md at \"{file_path}\" has invalid YAML frontmatter: {error}")
    })?;
    let Value::Object(frontmatter) = raw else {
        return Err(format!(
            "SKILL.md at \"{file_path}\" frontmatter must be a YAML mapping."
        ));
    };

    if !matches!(frontmatter.get("id"), Some(Value::String(id)) if !id.is_empty()) {
        return Err(format!(
            "SKILL.md at \"{file_path}\" frontmatter is missing a required string \"id\"."
        ));
    }

    // A Tier-2 file is recognised by its `tool:` key.
    let is_user = frontmatter.contains_key("tool");
    if is_user {
        let missing: Vec<&str> = REQUIRED_USER_FIELDS
            .into_iter()
            .filter(|key| !frontmatter.contains_key(*key))
            .collect();
        if !missing.is_empty() {
            return Err(format!(
                "SKILL.md at \"{file_path}\" is a Tier-2 (user) skill but is missing required fields: {}.",
                missing.join(", ")
            ));
        }
    }

    Ok(ParsedSkillMd {
        tier: if is_user {
            SkillTier::User
        } else {
            SkillTier::BuiltIn
        },
        frontmatter,
        body,
        file_path: file_path.to_string(),
        source,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_built_in_file_keeps_its_frontmatter_and_body() {
        let text = "---\nid: shell-access\nemoji: 🐚\nos:\n  - linux\n---\n\nUse this skill.\n";
        let parsed = parse_skill_md(text, "a/SKILL.md", SkillSource::Bundled).expect("parses");
        assert_eq!(parsed.tier, SkillTier::BuiltIn);
        assert_eq!(parsed.str_field("id"), Some("shell-access"));
        assert_eq!(parsed.body, "Use this skill.");
        assert_eq!(parsed.string_list("os"), Some(vec!["linux".to_string()]));
    }

    #[test]
    fn a_file_with_tool_is_tier_two_and_needs_every_field() {
        let complete = "---\nid: x\nname: X\ndescription: d\nversion: 1\ncategory: c\nfunctionName: x_run\ntool:\n  name: x_run\n---\nbody";
        let parsed = parse_skill_md(complete, "u/SKILL.md", SkillSource::User).expect("parses");
        assert_eq!(parsed.tier, SkillTier::User);

        let partial = "---\nid: x\ntool: {name: x}\n---\n";
        let error = parse_skill_md(partial, "u/SKILL.md", SkillSource::User).expect_err("missing");
        assert!(
            error.contains("missing required fields: name, description"),
            "{error}"
        );
    }

    #[test]
    fn missing_frontmatter_and_missing_id_are_errors() {
        let no_block =
            parse_skill_md("no frontmatter", "p", SkillSource::User).expect_err("no block");
        assert!(no_block.contains("missing a YAML frontmatter block"));

        let no_id =
            parse_skill_md("---\nname: x\n---\n", "p", SkillSource::User).expect_err("no id");
        assert!(no_id.contains("required string \"id\""));

        let empty_id =
            parse_skill_md("---\nid: \"\"\n---\n", "p", SkillSource::User).expect_err("empty id");
        assert!(empty_id.contains("required string \"id\""));
    }

    #[test]
    fn a_frontmatter_that_is_not_a_mapping_is_an_error() {
        let error = parse_skill_md("---\n- a\n---\n", "p", SkillSource::User).expect_err("list");
        assert!(error.contains("must be a YAML mapping"));
    }
}
