//! Port of `src/server/skills/skillMd/prompt.ts`.
//!
//! Builds the "Skill Guidance" section of the system prompt from the enriched skill bodies.
//! The 30 000 limit counts UTF-16 units, as JavaScript `String.length` does. When everything
//! does not fit, the largest prefix that fits is kept, found by binary search.

use super::types::EnrichedSkill;
use crate::skills::http_text::utf16_len;

const MAX_CHARS: usize = 30_000;
const SECTION_HEADER: &str = "## Skill Guidance\n\n";
const DIVIDER: &str = "---\n\n";

/// `buildSkillsPromptSection(skills)`. Skills without a body are left out. An empty string
/// means "no section".
pub fn build_skills_prompt_section(skills: &[EnrichedSkill]) -> String {
    let blocks: Vec<String> = skills
        .iter()
        .filter(|skill| !skill.body.trim().is_empty())
        .map(format_skill_block)
        .collect();
    if blocks.is_empty() {
        return String::new();
    }

    let section = |count: usize| format!("{SECTION_HEADER}{}", blocks[..count].concat());
    let fits = |count: usize| utf16_len(&section(count)) <= MAX_CHARS;

    if fits(blocks.len()) {
        return section(blocks.len());
    }

    // Largest count in 1..=len whose prefix fits. Mirrors the TypeScript search: `lo` only
    // moves up to a count that fits, and the final prefix is checked again.
    let mut lo = 0usize;
    let mut hi = blocks.len() - 1;
    while lo < hi {
        let mid = (lo + hi).div_ceil(2);
        if fits(mid + 1) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    if fits(lo + 1) {
        section(lo + 1)
    } else {
        String::new()
    }
}

/// `formatSkillBlock`: `### <emoji> <name> (\`<functionName>\`)`, the body, a divider.
fn format_skill_block(skill: &EnrichedSkill) -> String {
    let emoji = skill
        .emoji
        .as_deref()
        .filter(|emoji| !emoji.is_empty())
        .map(|emoji| format!("{emoji} "))
        .unwrap_or_default();
    format!(
        "### {emoji}{} (`{}`)\n\n{}\n\n{DIVIDER}",
        skill.name, skill.function_name, skill.body
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::skill_md::types::SkillSource;
    use serde_json::Value;

    fn skill(name: &str, body: &str, emoji: Option<&str>) -> EnrichedSkill {
        EnrichedSkill {
            id: name.to_string(),
            name: name.to_string(),
            description: String::new(),
            version: "1".to_string(),
            category: "c".to_string(),
            function_name: format!("{name}_run"),
            tool: Value::Null,
            emoji: emoji.map(str::to_string),
            body: body.to_string(),
            file_path: String::new(),
            source: SkillSource::Bundled,
        }
    }

    #[test]
    fn blocks_carry_the_emoji_name_function_and_body() {
        let section = build_skills_prompt_section(&[skill("alpha", "Use it.", Some("🐚"))]);
        assert_eq!(
            section,
            "## Skill Guidance\n\n### 🐚 alpha (`alpha_run`)\n\nUse it.\n\n---\n\n"
        );
    }

    #[test]
    fn skills_without_a_body_give_no_section() {
        assert_eq!(
            build_skills_prompt_section(&[skill("beta", "  ", None)]),
            ""
        );
        assert_eq!(build_skills_prompt_section(&[]), "");
    }

    #[test]
    fn an_oversized_section_keeps_the_largest_prefix_that_fits() {
        let big = "x".repeat(12_000);
        let skills = [
            skill("one", &big, None),
            skill("two", &big, None),
            skill("three", &big, None),
        ];
        let section = build_skills_prompt_section(&skills);
        assert!(utf16_len(&section) <= MAX_CHARS);
        assert!(section.contains("### one "));
        assert!(section.contains("### two "));
        assert!(!section.contains("### three "));
    }

    #[test]
    fn a_single_block_that_is_too_large_gives_no_section() {
        let huge = "x".repeat(MAX_CHARS);
        assert_eq!(
            build_skills_prompt_section(&[skill("huge", &huge, None)]),
            ""
        );
    }
}
