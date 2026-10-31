//! Port of `src/server/skills/skillMd/loader.ts`.
//!
//! Finds SKILL.md files in four sources and merges them by `id`. A later source wins over an
//! earlier one, and the merged list keeps the position of the first occurrence, as a
//! JavaScript `Map` does. The result is cached for ten seconds per source set.
//!
//! Sources, lowest priority first:
//! 1. bundled: `<cwd>/src/skills/*/SKILL.md` (`process.cwd()` in TypeScript),
//! 2. user: `<home>/.config/betaclaw/skills/*/SKILL.md`,
//! 3. workspace: `<workspace>/skills/*/SKILL.md`,
//! 4. env-override: `$BETACLAW_SKILLS_DIR/*/SKILL.md`.
//!
//! Each directory is read in two shapes: `dir/SKILL.md` and `dir/<name>/SKILL.md`.

use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::parser::parse_skill_md;
use super::types::{ParsedSkillMd, SkillSource};

const CACHE_TTL: Duration = Duration::from_secs(10);

/// `LoadSkillsOptions`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LoadSkillsOptions {
    /// Absolute path of the current workspace, for workspace-scoped skills.
    pub workspace_cwd: Option<PathBuf>,
}

struct CacheEntry {
    key: String,
    expires_at: Instant,
    skills: Vec<ParsedSkillMd>,
}

static CACHE: Mutex<Option<CacheEntry>> = Mutex::new(None);

/// `invalidateSkillMdCache`.
pub fn invalidate_skill_md_cache() {
    *CACHE.lock().unwrap_or_else(|poison| poison.into_inner()) = None;
}

/// `loadAllSkillMd(opts)`.
pub fn load_all_skill_md(options: &LoadSkillsOptions) -> Vec<ParsedSkillMd> {
    let bundled = env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("src")
        .join("skills");
    let user = home_dir().join(".config").join("betaclaw").join("skills");
    let workspace = options.workspace_cwd.as_ref().map(|cwd| cwd.join("skills"));
    let env_dir = env::var("BETACLAW_SKILLS_DIR")
        .ok()
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);

    let mut sources: Vec<(SkillSource, PathBuf)> =
        vec![(SkillSource::Bundled, bundled), (SkillSource::User, user)];
    if let Some(dir) = workspace {
        sources.push((SkillSource::Workspace, dir));
    }
    if let Some(dir) = env_dir {
        sources.push((SkillSource::EnvOverride, dir));
    }

    let key = sources
        .iter()
        .map(|(_, dir)| dir.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("|");
    let now = Instant::now();
    {
        let cache = CACHE.lock().unwrap_or_else(|poison| poison.into_inner());
        if let Some(entry) = cache.as_ref() {
            if entry.key == key && now < entry.expires_at {
                return entry.skills.clone();
            }
        }
    }

    let mut skills: Vec<ParsedSkillMd> = Vec::new();
    let mut position: HashMap<String, usize> = HashMap::new();
    for (source, dir) in sources {
        for skill in load_from_dir(&dir, source) {
            match position.get(&skill.frontmatter_id()) {
                Some(&index) => skills[index] = skill,
                None => {
                    position.insert(skill.frontmatter_id(), skills.len());
                    skills.push(skill);
                }
            }
        }
    }

    *CACHE.lock().unwrap_or_else(|poison| poison.into_inner()) = Some(CacheEntry {
        key,
        expires_at: now + CACHE_TTL,
        skills: skills.clone(),
    });
    skills
}

impl ParsedSkillMd {
    /// `frontmatter.id`, as the merge key.
    fn frontmatter_id(&self) -> String {
        self.str_field("id").unwrap_or_default().to_string()
    }
}

fn home_dir() -> PathBuf {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// `loadSkillsFromDir(dir, source)`. A missing directory gives no skills.
fn load_from_dir(dir: &Path, source: SkillSource) -> Vec<ParsedSkillMd> {
    let Ok(read) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut entries: Vec<PathBuf> = read
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .collect();
    entries.sort();

    let mut results = Vec::new();
    for entry in entries {
        // `statSync` follows symbolic links, so `fs::metadata` does too.
        let Ok(metadata) = fs::metadata(&entry) else {
            continue;
        };
        if metadata.is_dir() {
            if let Some(parsed) = try_parse(&entry.join("SKILL.md"), source) {
                results.push(parsed);
            }
        } else if entry.file_name().is_some_and(|name| name == "SKILL.md") {
            if let Some(parsed) = try_parse(&entry, source) {
                results.push(parsed);
            }
        }
    }
    results
}

/// `tryParseSkillMd`. An unreadable or invalid file is skipped with a warning.
fn try_parse(path: &Path, source: SkillSource) -> Option<ParsedSkillMd> {
    let content = fs::read_to_string(path).ok()?;
    let shown = path.to_string_lossy().into_owned();
    match parse_skill_md(&content, &shown, source) {
        Ok(parsed) => Some(parsed),
        Err(error) => {
            tracing::warn!(
                "[skillMd] Skipping invalid SKILL.md at \"{}\": {}",
                shown,
                error
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::skill_md::types::SkillTier;

    /// A scratch directory under the system temp dir, removed on drop.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let path = env::temp_dir().join(format!("skill-md-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).expect("create scratch dir");
            Self(path)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write_skill(root: &Path, folder: &str, id: &str, body: &str) {
        let dir = root.join(folder);
        fs::create_dir_all(&dir).expect("create skill dir");
        fs::write(
            dir.join("SKILL.md"),
            format!("---\nid: {id}\n---\n{body}\n"),
        )
        .expect("write skill");
    }

    #[test]
    fn reads_both_shapes_and_skips_invalid_files() {
        let scratch = Scratch::new();
        let root = scratch.0.join("skills");
        write_skill(&root, "alpha", "alpha", "A body");
        write_skill(&root, "beta", "", "invalid, no id");
        fs::write(root.join("SKILL.md"), "---\nid: flat\n---\nFlat body\n").expect("flat");

        let parsed = load_from_dir(&root, SkillSource::Workspace);
        let ids: Vec<&str> = parsed.iter().filter_map(|s| s.str_field("id")).collect();
        assert_eq!(ids, vec!["flat", "alpha"]);
        assert!(parsed.iter().all(|s| s.tier == SkillTier::BuiltIn));
    }

    #[test]
    fn a_missing_directory_gives_no_skills() {
        let scratch = Scratch::new();
        assert!(load_from_dir(&scratch.0.join("absent"), SkillSource::User).is_empty());
    }

    #[test]
    fn a_later_source_overrides_an_earlier_one_in_place() {
        let scratch = Scratch::new();
        let workspace = scratch.0.join("ws");
        let root = workspace.join("skills");
        write_skill(&root, "one", "shared", "workspace copy");
        write_skill(&root, "two", "other", "other body");

        let options = LoadSkillsOptions {
            workspace_cwd: Some(workspace.clone()),
        };
        let loaded = load_all_skill_md(&options);
        let shared = loaded
            .iter()
            .find(|s| s.str_field("id") == Some("shared"))
            .expect("workspace skill is loaded");
        assert_eq!(shared.body, "workspace copy");
        assert_eq!(shared.source, SkillSource::Workspace);
        invalidate_skill_md_cache();
    }
}
