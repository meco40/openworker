//! Port of `src/server/skills/skillMd/enricher.ts`.
//!
//! Tier-1 (built-in): the manifest from `builtInSkills` is the source of the tool schema.
//! SKILL.md adds the emoji and the body. Tier-2 (user): the whole manifest comes from the
//! SKILL.md frontmatter, and its `tool:` block is validated first.

use serde_json::{Map, Value};

use super::types::{EnrichedSkill, ParsedSkillMd, SkillTier};
use crate::skills::builtin_skills::SkillManifest;
use crate::skills::types::js_to_string;

/// `enrichBuiltInManifest(manifest, parsed)`. The manifest's tool schema is kept as it is.
pub fn enrich_built_in_manifest(manifest: &SkillManifest, parsed: &ParsedSkillMd) -> EnrichedSkill {
    EnrichedSkill {
        id: manifest.id.to_string(),
        name: manifest.name.to_string(),
        description: manifest.description.to_string(),
        version: manifest.version.to_string(),
        category: manifest.category.to_string(),
        function_name: manifest.function_name.to_string(),
        tool: manifest.tool.clone(),
        emoji: parsed.str_field("emoji").map(str::to_string),
        body: parsed.body.clone(),
        file_path: parsed.file_path.clone(),
        source: parsed.source,
    }
}

/// `userSkillToManifest(parsed)`. Fails when the file is not Tier-2 or its `tool:` block is
/// malformed. The caller then skips the skill.
pub fn user_skill_to_manifest(parsed: &ParsedSkillMd) -> Result<EnrichedSkill, String> {
    if parsed.tier != SkillTier::User {
        return Err(format!(
            "userSkillToManifest called on a Tier-1 skill at \"{}\". Use enrichBuiltInManifest instead.",
            parsed.file_path
        ));
    }

    let tool = validate_tool_definition(parsed.frontmatter.get("tool"), &parsed.file_path)?;
    let field = |key: &str| {
        parsed
            .frontmatter
            .get(key)
            .map(js_to_string)
            .unwrap_or_default()
    };
    Ok(EnrichedSkill {
        id: field("id"),
        name: field("name"),
        description: field("description"),
        version: field("version"),
        category: field("category"),
        function_name: field("functionName"),
        tool,
        emoji: parsed.str_field("emoji").map(str::to_string),
        body: parsed.body.clone(),
        file_path: parsed.file_path.clone(),
        source: parsed.source,
    })
}

/// `validateToolDefinition`. A built-in definition needs a `providerConfig` object. Any other
/// definition needs a non-empty `name` and `description`, and a `parameters` object.
fn validate_tool_definition(raw: Option<&Value>, file_path: &str) -> Result<Value, String> {
    let Some(Value::Object(object)) = raw else {
        return Err(format!(
            "SKILL.md at \"{file_path}\": \"tool\" must be an object."
        ));
    };

    if object.get("builtIn") == Some(&Value::Bool(true)) {
        return match object.get("providerConfig") {
            Some(Value::Object(_)) => Ok(Value::Object(object.clone())),
            _ => Err(format!(
                "SKILL.md at \"{file_path}\": built-in tool definition requires a \"providerConfig\" object."
            )),
        };
    }

    if !non_empty_string(object, "name") {
        return Err(format!(
            "SKILL.md at \"{file_path}\": tool definition requires a non-empty \"name\"."
        ));
    }
    if !non_empty_string(object, "description") {
        return Err(format!(
            "SKILL.md at \"{file_path}\": tool definition requires a non-empty \"description\"."
        ));
    }
    if !matches!(object.get("parameters"), Some(Value::Object(_))) {
        return Err(format!(
            "SKILL.md at \"{file_path}\": tool definition requires a \"parameters\" object."
        ));
    }
    Ok(Value::Object(object.clone()))
}

fn non_empty_string(object: &Map<String, Value>, key: &str) -> bool {
    matches!(object.get(key), Some(Value::String(text)) if !text.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::skill_md::parser::parse_skill_md;
    use crate::skills::skill_md::types::SkillSource;
    use serde_json::json;

    fn user_file(tool: &str) -> ParsedSkillMd {
        parse_skill_md(
            &format!(
                "---\nid: weather\nname: Weather\ndescription: d\nversion: 2\ncategory: Web\nfunctionName: weather_get\nemoji: ☀️\ntool: {tool}\n---\nUse it.\n"
            ),
            "u/SKILL.md",
            SkillSource::User,
        )
        .expect("parses")
    }

    #[test]
    fn a_user_skill_takes_its_manifest_from_the_frontmatter() {
        let enriched = user_skill_to_manifest(&user_file(
            "{name: weather_get, description: Get weather, parameters: {type: object, properties: {}}}",
        ))
        .expect("valid tool");
        assert_eq!(enriched.id, "weather");
        assert_eq!(
            enriched.version, "2",
            "a number renders as JavaScript String() does"
        );
        assert_eq!(enriched.function_name, "weather_get");
        assert_eq!(enriched.emoji.as_deref(), Some("☀️"));
        assert_eq!(enriched.body, "Use it.");
        assert_eq!(enriched.tool["name"], "weather_get");
    }

    #[test]
    fn a_malformed_tool_block_is_refused() {
        let no_parameters = user_file("{name: weather_get, description: Get weather}");
        assert!(user_skill_to_manifest(&no_parameters)
            .expect_err("no parameters")
            .contains("requires a \"parameters\" object"));

        let built_in_without_config = user_file("{builtIn: true}");
        assert!(user_skill_to_manifest(&built_in_without_config)
            .expect_err("no providerConfig")
            .contains("providerConfig"));
    }

    #[test]
    fn a_built_in_enrichment_keeps_the_manifest_schema() {
        let manifest = crate::skills::builtin_skills::built_in_skills()
            .into_iter()
            .find(|seed| seed.manifest.id == "browser")
            .expect("browser seed")
            .manifest;
        let parsed = parse_skill_md(
            "---\nid: browser\nemoji: 🌐\nos:\n  - linux\n---\nGuidance.\n",
            "b/SKILL.md",
            SkillSource::Bundled,
        )
        .expect("parses");
        let enriched = enrich_built_in_manifest(&manifest, &parsed);
        assert_eq!(enriched.function_name, "browser_snapshot");
        assert_eq!(enriched.tool, json!(manifest.tool));
        assert_eq!(enriched.emoji.as_deref(), Some("🌐"));
        assert_eq!(enriched.body, "Guidance.");
    }

    #[test]
    fn a_tier_one_file_is_not_a_user_skill() {
        let tier_one =
            parse_skill_md("---\nid: x\n---\n", "x", SkillSource::Bundled).expect("parses");
        assert!(user_skill_to_manifest(&tier_one).is_err());
    }
}
