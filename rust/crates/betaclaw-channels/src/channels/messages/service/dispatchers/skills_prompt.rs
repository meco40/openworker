//! Port of `src/server/channels/messages/service/dispatchers/skillsPrompt.ts`.
//!
//! The SKILL.md machinery (`loadAllSkillMd`, `enrichBuiltInManifest`,
//! `userSkillToManifest`, `buildSkillsPromptSection`) is not part of S8. It sits
//! behind [`SkillMdPort`]. The ordering and fallback rules of
//! `buildActiveSkillsPromptSection` are ported here.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::channels::messages::service::execution::ports::PortResult;
use crate::channels::messages::service::ports::SkillRow;

/// Tier of a parsed SKILL.md (`parsed.tier`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkillTier {
    BuiltIn,
    User,
}

/// Projection of `ParsedSkillMd`. `payload` is the port's own data, opaque to S8.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedSkillMd {
    /// `frontmatter.id`.
    pub id: String,
    pub tier: SkillTier,
    pub payload: Value,
}

/// Projection of `BuiltInSkillSeed`. `id` is `manifest.id`.
#[derive(Debug, Clone, PartialEq)]
pub struct BuiltInSkillSeed {
    pub id: String,
    pub payload: Value,
}

/// `SkillSource` of `skillMd`: `bundled` for built-ins, otherwise `user`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkillSource {
    Bundled,
    User,
}

/// `EnrichedSkill` (`skillMd`), the fields the prompt section reads.
#[derive(Debug, Clone, PartialEq)]
pub struct EnrichedSkill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub category: String,
    pub function_name: String,
    pub tool: Value,
    /// `emoji` of the SKILL.md frontmatter; the prompt section shows it before the name.
    pub emoji: Option<String>,
    pub body: String,
    pub file_path: String,
    pub source: SkillSource,
}

/// The SKILL.md seam (`@/server/skills/skillMd`, `builtInSkills`). Target: S11 (skills).
pub trait SkillMdPort: Send + Sync {
    /// `filterEligibleSkills(loadAllSkillMd({ workspaceCwd }))`.
    fn eligible_parsed_skills(
        &self,
        workspace_cwd: Option<String>,
    ) -> PortResult<Vec<ParsedSkillMd>>;
    /// `BUILT_IN_SKILLS`.
    fn built_in_seeds(&self) -> Vec<BuiltInSkillSeed>;
    /// `enrichBuiltInManifest(seed.manifest, parsed)`.
    fn enrich_built_in(&self, seed: &BuiltInSkillSeed, parsed: &ParsedSkillMd) -> EnrichedSkill;
    /// `userSkillToManifest(parsed)`; an error skips the skill.
    fn user_skill_to_manifest(&self, parsed: &ParsedSkillMd) -> PortResult<EnrichedSkill>;
    /// `buildSkillsPromptSection(skills)`.
    fn build_skills_prompt_section(&self, skills: &[EnrichedSkill]) -> String;
}

/// `buildActiveSkillsPromptSection({ installedSkills, eligibleParsedSkills, builtInSeeds })`
/// (`skillsPrompt.ts:18-51`). Installed skills keep their registry order. A skill
/// without SKILL.md guidance gets the registry fallback.
pub fn build_active_skills_prompt_section(
    installed: &[SkillRow],
    eligible: &[ParsedSkillMd],
    built_in_seeds: &[BuiltInSkillSeed],
    port: &dyn SkillMdPort,
) -> String {
    if installed.is_empty() {
        return String::new();
    }

    let installed_ids: HashSet<&str> = installed.iter().map(|skill| skill.id.as_str()).collect();
    let built_in_by_id: HashMap<&str, &BuiltInSkillSeed> = built_in_seeds
        .iter()
        .map(|seed| (seed.id.as_str(), seed))
        .collect();
    let mut enriched_by_id: HashMap<String, EnrichedSkill> = HashMap::new();

    for parsed in eligible {
        if !installed_ids.contains(parsed.id.as_str()) {
            continue;
        }

        if parsed.tier == SkillTier::BuiltIn {
            if let Some(seed) = built_in_by_id.get(parsed.id.as_str()) {
                enriched_by_id.insert(parsed.id.clone(), port.enrich_built_in(seed, parsed));
            }
            continue;
        }

        // A malformed user SKILL.md must not break chat dispatch.
        if let Ok(skill) = port.user_skill_to_manifest(parsed) {
            enriched_by_id.insert(parsed.id.clone(), skill);
        }
    }

    let ordered: Vec<EnrichedSkill> = installed
        .iter()
        .map(|skill| {
            enriched_by_id
                .get(&skill.id)
                .cloned()
                .unwrap_or_else(|| create_fallback_skill(skill))
        })
        .collect();

    port.build_skills_prompt_section(&ordered)
}

/// `createFallbackSkill(skill)` (`skillsPrompt.ts:53-68`).
fn create_fallback_skill(skill: &SkillRow) -> EnrichedSkill {
    EnrichedSkill {
        id: skill.id.clone(),
        name: skill.name.clone(),
        description: skill.description.clone(),
        version: skill.version.clone(),
        category: skill.category.clone(),
        function_name: skill.function_name.clone(),
        tool: skill.tool_definition.clone(),
        emoji: None,
        body: format!(
            "Active skill from registry (no SKILL.md guidance loaded).\n\
             Purpose: {}",
            skill.description
        ),
        file_path: "[generated-from-skill-registry]".to_string(),
        source: map_source(&skill.source),
    }
}

/// `mapSource(source)` (`skillsPrompt.ts:70-73`).
fn map_source(source: &str) -> SkillSource {
    if source == "built-in" {
        SkillSource::Bundled
    } else {
        SkillSource::User
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Port fake: enriches by echoing ids, fails for user skills whose payload says so.
    struct FakeSkillMd;

    impl SkillMdPort for FakeSkillMd {
        fn eligible_parsed_skills(&self, _cwd: Option<String>) -> PortResult<Vec<ParsedSkillMd>> {
            Ok(vec![])
        }
        fn built_in_seeds(&self) -> Vec<BuiltInSkillSeed> {
            vec![]
        }
        fn enrich_built_in(
            &self,
            seed: &BuiltInSkillSeed,
            _parsed: &ParsedSkillMd,
        ) -> EnrichedSkill {
            enriched(&seed.id, "bundled guidance", SkillSource::Bundled)
        }
        fn user_skill_to_manifest(&self, parsed: &ParsedSkillMd) -> PortResult<EnrichedSkill> {
            if parsed.payload == json!("broken") {
                return Err("malformed".into());
            }
            Ok(enriched(&parsed.id, "user guidance", SkillSource::User))
        }
        fn build_skills_prompt_section(&self, skills: &[EnrichedSkill]) -> String {
            skills
                .iter()
                .map(|s| format!("{}:{}", s.id, s.body))
                .collect::<Vec<_>>()
                .join("|")
        }
    }

    fn enriched(id: &str, body: &str, source: SkillSource) -> EnrichedSkill {
        EnrichedSkill {
            id: id.into(),
            name: id.into(),
            description: "d".into(),
            version: "1".into(),
            category: "c".into(),
            function_name: id.into(),
            tool: Value::Null,
            emoji: None,
            body: body.into(),
            file_path: "f".into(),
            source,
        }
    }

    fn row(id: &str, source: &str) -> SkillRow {
        SkillRow {
            id: id.into(),
            name: id.into(),
            description: format!("{id} description"),
            category: "c".into(),
            installed: true,
            version: "1".into(),
            function_name: id.into(),
            source: source.into(),
            source_url: None,
            tool_definition: json!({"name": id}),
        }
    }

    #[test]
    fn no_installed_skills_means_no_section() {
        assert_eq!(
            build_active_skills_prompt_section(&[], &[], &[], &FakeSkillMd),
            ""
        );
    }

    #[test]
    fn registry_order_is_kept_and_missing_guidance_falls_back() {
        let installed = vec![row("alpha", "user"), row("beta", "built-in")];
        let eligible = vec![ParsedSkillMd {
            id: "alpha".into(),
            tier: SkillTier::User,
            payload: json!({}),
        }];
        let section = build_active_skills_prompt_section(&installed, &eligible, &[], &FakeSkillMd);
        assert_eq!(
            section,
            "alpha:user guidance|beta:Active skill from registry (no SKILL.md guidance loaded).\nPurpose: beta description"
        );
    }

    #[test]
    fn a_malformed_user_skill_falls_back_instead_of_failing() {
        let installed = vec![row("gamma", "user")];
        let eligible = vec![ParsedSkillMd {
            id: "gamma".into(),
            tier: SkillTier::User,
            payload: json!("broken"),
        }];
        let section = build_active_skills_prompt_section(&installed, &eligible, &[], &FakeSkillMd);
        assert!(
            section.starts_with("gamma:Active skill from registry"),
            "{section}"
        );
    }

    #[test]
    fn built_in_guidance_needs_a_matching_seed() {
        let installed = vec![row("delta", "built-in")];
        let eligible = vec![ParsedSkillMd {
            id: "delta".into(),
            tier: SkillTier::BuiltIn,
            payload: json!({}),
        }];
        // No seed: the built-in is skipped and the registry fallback is used.
        let without = build_active_skills_prompt_section(&installed, &eligible, &[], &FakeSkillMd);
        assert!(without.contains("no SKILL.md guidance loaded"));
        let seeds = vec![BuiltInSkillSeed {
            id: "delta".into(),
            payload: json!({}),
        }];
        let with = build_active_skills_prompt_section(&installed, &eligible, &seeds, &FakeSkillMd);
        assert_eq!(with, "delta:bundled guidance");
    }

    #[test]
    fn source_mapping_treats_only_built_in_as_bundled() {
        assert_eq!(map_source("built-in"), SkillSource::Bundled);
        assert_eq!(map_source("github"), SkillSource::User);
        assert_eq!(
            create_fallback_skill(&row("x", "built-in")).source,
            SkillSource::Bundled
        );
    }
}
