//! Port of `src/server/clawhub/clawhubPromptBuilder.ts`.
//!
//! Builds the advisory block that lists the enabled skills and an excerpt of
//! each `SKILL.md`. Limits are counted in characters, where the TypeScript
//! counts UTF-16 units; the two differ only for characters outside the Basic
//! Multilingual Plane, such as emoji, at the cut-off.

use std::path::Path;

use super::errors::ClawHubError;
use super::repository::ClawHubRepository;
use super::types::SkillStatus;

const HEADER: &str =
    "ClawHub Skill Context (advisory; core system and safety instructions always take precedence):";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PromptLimits {
    pub max_skills: usize,
    pub max_chars_per_skill: usize,
    pub max_total_chars: usize,
}

impl Default for PromptLimits {
    fn default() -> Self {
        Self {
            max_skills: 6,
            max_chars_per_skill: 320,
            max_total_chars: 1600,
        }
    }
}

const FRONTMATTER_FENCE: &str = "---\n";

/// `stripFrontmatter`: the body after a leading `---` block, trimmed.
fn strip_frontmatter(content: &str) -> &str {
    if !content.starts_with(FRONTMATTER_FENCE) {
        return content;
    }
    match content[4..].find("\n---") {
        Some(offset) => content[4 + offset + 4..].trim(),
        None => content,
    }
}

/// `readDescriptionFromFrontmatter`: the `description:` line of the block.
fn read_description(content: &str) -> String {
    if !content.starts_with(FRONTMATTER_FENCE) {
        return String::new();
    }
    let Some(offset) = content[4..].find("\n---") else {
        return String::new();
    };
    let frontmatter = &content[4..4 + offset];
    static DESCRIPTION: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?i)(?:^|\n)description:\s*(.+)").expect("description pattern is valid")
    });
    DESCRIPTION
        .captures(frontmatter)
        .and_then(|captures| captures.get(1))
        .map(|value| value.as_str().trim().to_string())
        .unwrap_or_default()
}

/// `compactWhitespace`: runs of whitespace become one space.
fn compact_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `buildClawHubPromptBlock`. Returns an empty string when no enabled, installed
/// skill has a readable `SKILL.md`.
pub fn build_clawhub_prompt_block(
    workspace_dir: &Path,
    repository: &ClawHubRepository,
    limits: PromptLimits,
) -> Result<String, ClawHubError> {
    let enabled: Vec<_> = repository
        .list_enabled_skills()?
        .into_iter()
        .filter(|skill| skill.status == SkillStatus::Installed)
        .take(limits.max_skills)
        .collect();
    if enabled.is_empty() {
        return Ok(String::new());
    }

    let mut lines: Vec<String> = vec![HEADER.to_string()];
    for skill in &enabled {
        let skill_path = workspace_dir.join(&skill.local_path).join("SKILL.md");
        // `safeReadFile`: an unreadable file is treated as empty.
        let markdown = std::fs::read_to_string(&skill_path).unwrap_or_default();
        if markdown.is_empty() {
            continue;
        }

        let frontmatter_description = read_description(&markdown);
        let body = compact_whitespace(strip_frontmatter(&markdown));
        let excerpt: String = body.chars().take(limits.max_chars_per_skill).collect();
        // `frontmatterDescription || skill.title || skill.slug`: the first non-empty one.
        let description_source = [
            frontmatter_description.as_str(),
            skill.title.as_str(),
            skill.slug.as_str(),
        ]
        .into_iter()
        .find(|candidate| !candidate.is_empty())
        .unwrap_or("");
        let description = compact_whitespace(description_source);

        lines.push(format!("- {}: {}", skill.slug, description));
        if !excerpt.is_empty() {
            lines.push(format!("  Guidance: {excerpt}"));
        }
    }

    if lines.len() == 1 {
        return Ok(String::new());
    }

    let block = lines.join("\n");
    if block.chars().count() > limits.max_total_chars {
        let kept: String = block
            .chars()
            .take(limits.max_total_chars.saturating_sub(1))
            .collect();
        return Ok(format!("{kept}…"));
    }
    Ok(block)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clawhub::types::{SkillRow, UpsertSkillInput};

    fn workspace_with(skills: &[(&str, &str)]) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "clawhub-prompt-{}",
            crate::stats::util::short_uuid()
        ));
        for (slug, markdown) in skills {
            let dir = root.join("skills").join(slug);
            std::fs::create_dir_all(&dir).expect("skill dir");
            std::fs::write(dir.join("SKILL.md"), markdown).expect("skill file");
        }
        root
    }

    fn install(repository: &ClawHubRepository, slug: &str) -> SkillRow {
        repository
            .upsert_skill(&UpsertSkillInput {
                slug: slug.into(),
                version: "1.0.0".into(),
                title: format!("{slug} title"),
                status: SkillStatus::Installed,
                enabled: Some(true),
                local_path: format!("skills/{slug}"),
                installed_at: None,
                last_action_at: None,
                last_error: None,
            })
            .expect("install")
    }

    #[test]
    fn uses_the_frontmatter_description_and_an_excerpt() {
        let root = workspace_with(&[(
            "weather",
            "---\nname: weather\ndescription: Forecasts for cities\n---\n\n# Use it\n\nAsk for a city.\n",
        )]);
        let repository = ClawHubRepository::in_memory().expect("open");
        install(&repository, "weather");

        let block =
            build_clawhub_prompt_block(&root, &repository, PromptLimits::default()).expect("block");
        assert!(block.starts_with(HEADER));
        assert!(block.contains("- weather: Forecasts for cities"));
        assert!(block.contains("  Guidance: # Use it Ask for a city."));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn truncates_the_block_to_the_total_limit() {
        let root = workspace_with(&[("plain", "no frontmatter here")]);
        let repository = ClawHubRepository::in_memory().expect("open");
        install(&repository, "plain");

        let limits = PromptLimits {
            max_skills: 6,
            max_chars_per_skill: 320,
            max_total_chars: 40,
        };
        let block = build_clawhub_prompt_block(&root, &repository, limits).expect("block");
        assert_eq!(block.chars().count(), 40);
        assert!(block.ends_with('…'));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn no_readable_skill_gives_an_empty_block() {
        let root = workspace_with(&[]);
        let repository = ClawHubRepository::in_memory().expect("open");
        install(&repository, "missing");
        let block =
            build_clawhub_prompt_block(&root, &repository, PromptLimits::default()).expect("block");
        assert!(block.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn frontmatter_helpers_need_a_closing_fence() {
        assert_eq!(strip_frontmatter("---\nno end"), "---\nno end");
        assert_eq!(read_description("---\ndescription: x\nno end"), "");
        assert_eq!(
            read_description("---\ndescription:   spaced  \n---\nbody"),
            "spaced"
        );
    }
}
