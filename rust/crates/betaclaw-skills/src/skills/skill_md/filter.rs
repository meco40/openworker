//! Port of `src/server/skills/skillMd/filter.ts`.
//!
//! Keeps the skills that may be shown to the model on this platform. The checks are the OS
//! list, the required environment variables and the required binaries on `PATH`.

use std::env;
use std::path::PathBuf;

use serde_json::Value;

use super::types::ParsedSkillMd;

/// `process.platform` of the host, in the Node spelling.
pub fn current_platform() -> &'static str {
    match env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    }
}

/// `filterEligibleSkills(skills, { platform })`.
///
/// - `always: true` passes, and skips every other check.
/// - `os` must list the platform, when it is non-empty.
/// - `requires.env` must all be set and non-empty.
/// - `requires.bins` must all be on `PATH`.
/// - `requires.anyBins` needs at least one on `PATH`, when it is non-empty.
pub fn filter_eligible_skills(skills: &[ParsedSkillMd], platform: &str) -> Vec<ParsedSkillMd> {
    skills
        .iter()
        .filter(|skill| is_eligible(skill, platform))
        .cloned()
        .collect()
}

fn is_eligible(skill: &ParsedSkillMd, platform: &str) -> bool {
    let frontmatter = &skill.frontmatter;
    if frontmatter.get("always") == Some(&Value::Bool(true)) {
        return true;
    }

    if let Some(Value::Array(os)) = frontmatter.get("os") {
        if !os.is_empty() && !os.iter().any(|entry| entry.as_str() == Some(platform)) {
            return false;
        }
    }

    let Some(Value::Object(requires)) = frontmatter.get("requires") else {
        return true;
    };

    if let Some(Value::Array(names)) = requires.get("env") {
        for name in names {
            let name = name
                .as_str()
                .map_or_else(|| name.to_string(), str::to_string);
            match env::var(&name) {
                Ok(value) if !value.is_empty() => {}
                _ => return false,
            }
        }
    }

    if let Some(Value::Array(bins)) = requires.get("bins") {
        for bin in bins.iter().filter_map(Value::as_str) {
            if !bin_on_path(bin) {
                return false;
            }
        }
    }

    if let Some(Value::Array(any_bins)) = requires.get("anyBins") {
        let names: Vec<&str> = any_bins.iter().filter_map(Value::as_str).collect();
        if !names.is_empty() && !names.iter().any(|bin| bin_on_path(bin)) {
            return false;
        }
    }

    true
}

/// Whether `bin` names a file in a `PATH` directory. On Windows the usual executable
/// extensions are tried as well, as the TypeScript check does.
fn bin_on_path(bin: &str) -> bool {
    let candidates: Vec<String> = if cfg!(windows) {
        vec![
            bin.to_string(),
            format!("{bin}.exe"),
            format!("{bin}.cmd"),
            format!("{bin}.bat"),
        ]
    } else {
        vec![bin.to_string()]
    };
    let Some(path) = env::var_os("PATH") else {
        return false;
    };
    env::split_paths(&path).any(|dir: PathBuf| {
        candidates
            .iter()
            .any(|candidate| dir.join(candidate).is_file())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::skill_md::parser::parse_skill_md;
    use crate::skills::skill_md::types::SkillSource;

    fn skill(frontmatter: &str) -> ParsedSkillMd {
        parse_skill_md(
            &format!("---\nid: s\n{frontmatter}\n---\nbody"),
            "s/SKILL.md",
            SkillSource::Bundled,
        )
        .expect("parses")
    }

    #[test]
    fn the_os_list_decides_by_platform() {
        let linux_only = skill("os:\n  - linux");
        assert_eq!(
            filter_eligible_skills(std::slice::from_ref(&linux_only), "linux").len(),
            1
        );
        assert!(filter_eligible_skills(&[linux_only], "win32").is_empty());
        assert_eq!(
            filter_eligible_skills(&[skill("")], "win32").len(),
            1,
            "no os list means all"
        );
    }

    #[test]
    fn always_bypasses_every_other_check() {
        let forced = skill(
            "always: true\nos:\n  - darwin\nrequires:\n  env:\n    - BETACLAW_NO_SUCH_VAR_EVER",
        );
        assert_eq!(filter_eligible_skills(&[forced], "linux").len(), 1);
    }

    #[test]
    fn a_required_env_var_must_be_set_and_non_empty() {
        let needs_var = skill("requires:\n  env:\n    - BETACLAW_FILTER_TEST_VAR");
        std::env::remove_var("BETACLAW_FILTER_TEST_VAR");
        assert!(filter_eligible_skills(std::slice::from_ref(&needs_var), "linux").is_empty());
        std::env::set_var("BETACLAW_FILTER_TEST_VAR", "1");
        assert_eq!(
            filter_eligible_skills(std::slice::from_ref(&needs_var), "linux").len(),
            1
        );
        std::env::remove_var("BETACLAW_FILTER_TEST_VAR");
    }

    #[test]
    fn a_missing_binary_hides_the_skill_and_any_bins_needs_one() {
        let missing = skill("requires:\n  bins:\n    - betaclaw-no-such-binary-xyz");
        assert!(filter_eligible_skills(&[missing], "linux").is_empty());

        let any = skill("requires:\n  anyBins:\n    - betaclaw-no-such-binary-xyz\n    - betaclaw-also-missing-xyz");
        assert!(filter_eligible_skills(&[any], "linux").is_empty());
    }
}
