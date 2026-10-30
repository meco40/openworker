//! Port of `src/server/skills/skillMd/` (S11): the SKILL.md metadata system.
//!
//! `index.ts` maps to the re-exports below. `yaml` replaces the `yaml` package of the
//! TypeScript parser (see that module for the subset it reads).

pub mod enricher;
pub mod filter;
pub mod loader;
pub mod parser;
pub mod prompt;
pub mod types;
mod yaml;

pub use enricher::{enrich_built_in_manifest, user_skill_to_manifest};
pub use filter::{current_platform, filter_eligible_skills};
pub use loader::{invalidate_skill_md_cache, load_all_skill_md, LoadSkillsOptions};
pub use parser::parse_skill_md;
pub use prompt::build_skills_prompt_section;
pub use types::{EnrichedSkill, ParsedSkillMd, SkillSource, SkillTier};
