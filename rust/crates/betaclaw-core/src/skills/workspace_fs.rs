//! Port of `src/server/skills/handlers/workspaceFs.ts`.
//!
//! A path given by the model is resolved lexically against the workspace root. It must stay
//! inside the root, and its real location, with symbolic links resolved, must also stay
//! inside it. Backslashes count as separators.

use std::fs;
use std::path::{Path, PathBuf};

use super::execution_cwd::{
    assert_real_path_within_root, is_within_root, lexical_resolve, resolve_skill_execution_cwd,
};
use super::types::{js_trim, SkillDispatchContext, SkillError};
use crate::personas::workspace::PersonaWorkspace;
use crate::safe_error_message;

/// `resolveWorkspacePath`'s result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspacePath {
    pub workspace_root: PathBuf,
    pub resolved_path: PathBuf,
    /// Relative to the root, with `/` separators.
    pub relative_path: String,
}

/// `resolveWorkspaceRoot`.
pub fn resolve_workspace_root(
    personas: &PersonaWorkspace,
    ctx: &SkillDispatchContext,
) -> Result<PathBuf, SkillError> {
    resolve_skill_execution_cwd(personas, ctx)
}

/// `resolveWorkspacePath`.
pub fn resolve_workspace_path(
    input: &str,
    personas: &PersonaWorkspace,
    ctx: &SkillDispatchContext,
) -> Result<WorkspacePath, SkillError> {
    let workspace_root = resolve_workspace_root(personas, ctx)?;
    let requested = js_trim(input).replace('\\', "/");
    if requested.is_empty() {
        return Err(SkillError("Path is required.".to_string()));
    }
    let resolved_path = lexical_resolve(&workspace_root.join(&requested));
    if !is_within_root(&resolved_path, &workspace_root) {
        return Err(SkillError(
            "Path must stay inside workspace root.".to_string(),
        ));
    }
    assert_real_path_within_root(&resolved_path, &workspace_root)?;
    let relative_path = relative_to(&workspace_root, &resolved_path);
    Ok(WorkspacePath {
        workspace_root,
        resolved_path,
        relative_path,
    })
}

/// `ensureParentDir`.
pub fn ensure_parent_dir(path: &Path) -> Result<(), SkillError> {
    match path.parent() {
        Some(parent) => fs::create_dir_all(parent).map_err(io_error),
        None => Ok(()),
    }
}

/// `path.relative(root, resolved)` with `/` separators. The resolved path is below the root
/// (checked by the caller), so the first components of both paths are the same.
fn relative_to(root: &Path, resolved: &Path) -> String {
    let root_len = lexical_resolve(root).components().count();
    lexical_resolve(resolved)
        .components()
        .skip(root_len)
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

fn io_error(error: std::io::Error) -> SkillError {
    SkillError(safe_error_message(&error))
}

#[cfg(test)]
mod tests {
    use super::super::types::test_support::TempDir;
    use super::*;

    /// A workspace below the persona root, so that the dispatch context is accepted.
    fn context_in(personas: &PersonaWorkspace) -> SkillDispatchContext {
        SkillDispatchContext {
            bypass_approval: false,
            workspace_cwd: Some(
                personas
                    .root_dir()
                    .join("ada")
                    .to_string_lossy()
                    .into_owned(),
            ),
        }
    }

    #[test]
    fn relative_paths_resolve_inside_the_workspace_with_slash_separators() {
        let dir = TempDir::new();
        let personas = PersonaWorkspace::new(dir.0.join("personas"));
        let ctx = context_in(&personas);
        let resolved = resolve_workspace_path("src\\lib/a.txt", &personas, &ctx).expect("path");
        assert_eq!(resolved.relative_path, "src/lib/a.txt");
        assert!(resolved.resolved_path.starts_with(&resolved.workspace_root));
        let root = resolve_workspace_path(".", &personas, &ctx).expect("root");
        assert_eq!(root.relative_path, "");
    }

    #[test]
    fn a_path_that_leaves_the_root_is_refused() {
        let dir = TempDir::new();
        let personas = PersonaWorkspace::new(dir.0.join("personas"));
        let ctx = context_in(&personas);
        let error = resolve_workspace_path("../../escape.txt", &personas, &ctx).unwrap_err();
        assert_eq!(error.0, "Path must stay inside workspace root.");
        let error = resolve_workspace_path("   ", &personas, &ctx).unwrap_err();
        assert_eq!(error.0, "Path is required.");
    }
}
