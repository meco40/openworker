//! Mirrors `src/server/security/pathBoundary.ts`.
//!
//! `isPathWithinRoot` in TypeScript asks `path.relative(root, candidate)` and does not
//! compare string prefixes, so the sibling `/workspace-evil` is outside `/workspace`.
//! This port compares path components, which gives the same answer for resolved paths.
//!
//! Node's quirk is kept on purpose: a relative path whose first segment starts with `..`
//! (a directory named `..cache`, say) counts as outside the root. That is stricter than
//! necessary, and the TypeScript side behaves the same way.
//!
//! Both sides are resolved lexically first, as `path.resolve` does, and lower-cased on
//! Windows, as `normalizeForComparison` does. Symbolic links are not followed here.

use std::path::{Path, PathBuf};

use crate::skills::execution_cwd::lexical_resolve;

/// `assertPathWithinRoot` throws `new Error('Path escapes the allowed root.')`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("Path escapes the allowed root.")]
pub struct PathEscapesRoot;

/// `isPathWithinRoot`: true when `candidate` is `root` or sits below it.
pub fn is_path_within_root(candidate: &Path, root: &Path) -> bool {
    let candidate = comparable_components(candidate);
    let root = comparable_components(root);
    if !candidate.starts_with(&root) {
        return false;
    }
    match candidate.get(root.len()) {
        // `relative === ''`: the candidate is the root itself.
        None => true,
        // `!relative.startsWith('..')`, applied to the first segment below the root.
        Some(first) => !first.starts_with(".."),
    }
}

/// `assertPathWithinRoot`: returns the resolved candidate, or an error when it lies
/// outside `root`.
pub fn assert_path_within_root(candidate: &Path, root: &Path) -> Result<PathBuf, PathEscapesRoot> {
    let resolved = lexical_resolve(candidate);
    if is_path_within_root(&resolved, root) {
        Ok(resolved)
    } else {
        Err(PathEscapesRoot)
    }
}

/// The resolved path split into components, lower-cased on Windows.
fn comparable_components(path: &Path) -> Vec<String> {
    lexical_resolve(path)
        .components()
        .map(|component| {
            let text = component.as_os_str().to_string_lossy();
            if cfg!(windows) {
                text.to_lowercase()
            } else {
                text.into_owned()
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sibling_with_a_shared_prefix_is_outside() {
        assert!(!is_path_within_root(
            Path::new("/workspace-evil/x"),
            Path::new("/workspace")
        ));
        assert!(!is_path_within_root(
            Path::new("/workspace-evil"),
            Path::new("/workspace")
        ));
    }

    #[test]
    fn root_and_its_children_are_inside() {
        assert!(is_path_within_root(
            Path::new("/workspace"),
            Path::new("/workspace")
        ));
        assert!(is_path_within_root(
            Path::new("/workspace/a/b.txt"),
            Path::new("/workspace")
        ));
    }

    #[test]
    fn dot_dot_is_resolved_before_the_comparison() {
        assert!(assert_path_within_root(
            Path::new("/workspace/a/../../etc"),
            Path::new("/workspace")
        )
        .is_err());
        assert!(
            assert_path_within_root(Path::new("/workspace/a/../b"), Path::new("/workspace"))
                .is_ok()
        );
    }

    #[test]
    fn segment_starting_with_dot_dot_counts_as_outside_as_in_node() {
        assert!(!is_path_within_root(
            Path::new("/workspace/..cache/x"),
            Path::new("/workspace")
        ));
    }

    #[cfg(windows)]
    #[test]
    fn comparison_ignores_case_on_windows() {
        assert!(is_path_within_root(
            Path::new(r"E:\Workspace\a"),
            Path::new(r"e:\workspace")
        ));
    }
}
