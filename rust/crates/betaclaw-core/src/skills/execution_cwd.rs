//! Port of `src/server/skills/handlers/executionCwd.ts`.
//!
//! Chooses the directory a skill runs in: the persona workspace root by default, or a
//! `workspaceCwd` that must resolve inside that root, including through symbolic links.
//!
//! `path.resolve` in Node normalises `..` lexically. `std::path` does not, so
//! [`lexical_resolve`] does it explicitly. Without it, `root/../x` would pass a
//! prefix check.
//!
//! Comparisons lower-case both sides on Windows, as the TypeScript module does.
//! `fs::canonicalize` returns `\\?\` paths on Windows, so [`real_path`] strips that
//! prefix before the comparison.

use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf, MAIN_SEPARATOR};

use super::types::{js_trim, SkillDispatchContext, SkillError};
use crate::personas::workspace::PersonaWorkspace;
use crate::safe_error_message;

/// `resolveSkillExecutionCwd`.
pub fn resolve_skill_execution_cwd(
    personas: &PersonaWorkspace,
    ctx: &SkillDispatchContext,
) -> Result<PathBuf, SkillError> {
    let requested = js_trim(ctx.workspace_cwd.as_deref().unwrap_or(""));
    if requested.is_empty() {
        return std::env::current_dir().map_err(io_error);
    }

    let resolved_requested = lexical_resolve(Path::new(requested));
    let personas_root = lexical_resolve(personas.root_dir());
    if !is_within_root(&resolved_requested, &personas_root) {
        return Err(SkillError(
            "workspaceCwd must resolve inside persona workspace root.".to_string(),
        ));
    }

    fs::create_dir_all(&personas_root).map_err(io_error)?;
    assert_real_path_within_root(&resolved_requested, &personas_root)?;
    fs::create_dir_all(&resolved_requested).map_err(io_error)?;
    real_path(&resolved_requested).map_err(io_error)
}

/// `assertRealPathWithinRoot`. Walks up to the nearest existing ancestor of `candidate`
/// and checks that its real location stays inside the real `root`.
pub(crate) fn assert_real_path_within_root(
    candidate: &Path,
    root: &Path,
) -> Result<(), SkillError> {
    let mut existing = candidate.to_path_buf();
    while let Err(error) = fs::symlink_metadata(&existing) {
        let parent = existing
            .parent()
            .filter(|parent| *parent != existing)
            .map(Path::to_path_buf);
        match parent {
            Some(parent) if error.kind() == io::ErrorKind::NotFound => existing = parent,
            _ => return Err(io_error(error)),
        }
    }

    let real_existing = real_path(&existing).map_err(io_error)?;
    let real_root = real_path(root).map_err(io_error)?;
    if is_within_root(&real_existing, &real_root) {
        Ok(())
    } else {
        Err(SkillError(
            "Path escapes workspace root through a symbolic link.".to_string(),
        ))
    }
}

/// `isWithinRoot`: the candidate equals the root or sits below it. Both sides are
/// lexically resolved first, and lower-cased on Windows.
pub(crate) fn is_within_root(candidate: &Path, root: &Path) -> bool {
    let candidate = comparable(candidate);
    let root = comparable(root);
    candidate == root || candidate.starts_with(&format!("{root}{MAIN_SEPARATOR}"))
}

/// `path.resolve` for an absolute or relative path: `..` and `.` are resolved without
/// touching the file system. A relative path is first joined with the working directory.
pub(crate) fn lexical_resolve(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    let mut resolved = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::ParentDir => {
                resolved.pop();
            }
            Component::CurDir => {}
            other => resolved.push(other.as_os_str()),
        }
    }
    resolved
}

/// `fs.realpathSync`, with the `\\?\` prefix that `fs::canonicalize` adds on Windows
/// removed.
pub(crate) fn real_path(path: &Path) -> io::Result<PathBuf> {
    fs::canonicalize(path).map(strip_verbatim_prefix)
}

#[cfg(windows)]
fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy().into_owned();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path
    }
}

#[cfg(not(windows))]
fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    path
}

fn comparable(path: &Path) -> String {
    let text = lexical_resolve(path).to_string_lossy().into_owned();
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text
    }
}

fn io_error(error: io::Error) -> SkillError {
    SkillError(safe_error_message(&error))
}

#[cfg(test)]
mod tests {
    use super::super::types::test_support::TempDir;
    use super::*;

    fn personas_of(dir: &TempDir) -> PersonaWorkspace {
        PersonaWorkspace::new(dir.0.join("personas"))
    }

    fn ctx(workspace_cwd: &str) -> SkillDispatchContext {
        SkillDispatchContext {
            bypass_approval: false,
            workspace_cwd: Some(workspace_cwd.to_string()),
        }
    }

    #[test]
    fn default_is_the_process_working_directory() {
        let dir = TempDir::new();
        let cwd = resolve_skill_execution_cwd(&personas_of(&dir), &SkillDispatchContext::default())
            .expect("default cwd");
        assert_eq!(cwd, std::env::current_dir().expect("cwd"));
    }

    #[test]
    fn requested_directory_is_created_below_the_root() {
        let dir = TempDir::new();
        let personas = personas_of(&dir);
        // A relative workspaceCwd resolves against the process directory, as in TypeScript,
        // so the test passes an absolute path below the persona root.
        let requested = personas.root_dir().join("ada").join("projects");
        let resolved = resolve_skill_execution_cwd(&personas, &ctx(&requested.to_string_lossy()))
            .expect("resolve");
        assert!(resolved.is_dir());
        assert!(is_within_root(
            &resolved,
            &lexical_resolve(personas.root_dir())
        ));
    }

    #[test]
    fn dot_dot_cannot_leave_the_root_even_in_the_middle() {
        let dir = TempDir::new();
        let personas = personas_of(&dir);
        let err =
            resolve_skill_execution_cwd(&personas, &ctx("ada/../../escape")).expect_err("escape");
        assert_eq!(
            err.0,
            "workspaceCwd must resolve inside persona workspace root."
        );
        assert!(!dir.0.join("escape").exists());
    }

    #[test]
    fn sibling_prefix_is_not_inside_the_root() {
        assert!(!is_within_root(
            Path::new("/w/personas-evil"),
            Path::new("/w/personas")
        ));
        assert!(is_within_root(
            Path::new("/w/personas/a"),
            Path::new("/w/personas")
        ));
        assert!(is_within_root(
            Path::new("/w/personas"),
            Path::new("/w/personas")
        ));
    }

    #[cfg(unix)]
    #[test]
    fn symlink_out_of_the_root_is_rejected() {
        let dir = TempDir::new();
        let personas = personas_of(&dir);
        fs::create_dir_all(personas.root_dir()).expect("root");
        let outside = dir.0.join("outside");
        fs::create_dir_all(&outside).expect("outside");
        std::os::unix::fs::symlink(&outside, personas.root_dir().join("link")).expect("link");

        let requested = personas.root_dir().join("link").join("inner");
        let err = resolve_skill_execution_cwd(&personas, &ctx(&requested.to_string_lossy()))
            .expect_err("symlink escape");
        assert_eq!(
            err.0,
            "Path escapes workspace root through a symbolic link."
        );
        assert!(!outside.join("inner").exists());
    }
}
