//! Mirrors `src/server/security/fileAccess.ts` (`resolveAllowedExistingPath`).
//!
//! The file preview and reveal routes use this check. The path must exist, and its real
//! location (symbolic links resolved) must sit inside one of the roots given by
//! `WORKSPACE_BASE_PATH` and `PROJECTS_PATH`. An existing root is resolved through
//! symbolic links too, so both sides of the comparison are real paths.
//!
//! The rejection statuses and messages are those of the TypeScript result object.
//! Deviation: when the real path cannot be read after the existence check, TypeScript
//! throws. Here that becomes an explicit 500.

use std::env;
use std::path::{Path, PathBuf};

use super::path_boundary::is_path_within_root;
use crate::skills::execution_cwd::{lexical_resolve, real_path};
use crate::skills::types::js_trim;

/// The `{ ok: false, status, error }` branch of `ResolveAllowedPathResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RejectedPath {
    pub status: u16,
    pub error: &'static str,
}

/// `resolveAllowedExistingPath`. Reads `HOME`/`USERPROFILE` and the two roots at call
/// time, as the TypeScript module does.
pub fn resolve_allowed_existing_path(raw_path: &str) -> Result<PathBuf, RejectedPath> {
    let home = env::var("HOME")
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| env::var("USERPROFILE").ok())
        .unwrap_or_default();
    let workspace_base = env::var("WORKSPACE_BASE_PATH").ok();
    let projects = env::var("PROJECTS_PATH").ok();
    resolve_with_config(
        raw_path,
        &home,
        &[workspace_base.as_deref(), projects.as_deref()],
    )
}

/// The check with the environment values passed in, so tests do not change
/// process-wide variables.
pub(crate) fn resolve_with_config(
    raw_path: &str,
    home: &str,
    configured_roots: &[Option<&str>],
) -> Result<PathBuf, RejectedPath> {
    let trimmed = js_trim(raw_path);
    if trimmed.is_empty() {
        return Err(RejectedPath {
            status: 400,
            error: "path is required",
        });
    }

    let absolute = lexical_resolve(Path::new(&expand_home_path(trimmed, home)));
    if !absolute.exists() {
        return Err(RejectedPath {
            status: 404,
            error: "File or directory not found",
        });
    }

    let roots = allowed_roots(configured_roots, home);
    if roots.is_empty() {
        return Err(RejectedPath {
            status: 500,
            error: "Allowed file roots are not configured",
        });
    }

    let resolved = real_path(&absolute).map_err(|_| RejectedPath {
        status: 500,
        error: "Failed to resolve path",
    })?;
    if !roots
        .iter()
        .any(|root| is_path_within_root(&resolved, root))
    {
        return Err(RejectedPath {
            status: 403,
            error: "Path not allowed",
        });
    }
    Ok(resolved)
}

/// `resolveAllowedRoots`: trimmed, non-empty values, resolved lexically, then through
/// symbolic links when they exist.
fn allowed_roots(configured: &[Option<&str>], home: &str) -> Vec<PathBuf> {
    configured
        .iter()
        .copied()
        .flatten()
        .map(js_trim)
        .filter(|value| !value.is_empty())
        .map(|value| lexical_resolve(Path::new(&expand_home_path(value, home))))
        .map(|root| {
            if root.exists() {
                real_path(&root).unwrap_or(root)
            } else {
                root
            }
        })
        .collect()
}

/// `expandHomePath`: a leading `~` that is followed by the end, `/` or `\` becomes the
/// home directory. Without a home directory the input is returned unchanged.
fn expand_home_path(input: &str, home: &str) -> String {
    if home.is_empty() {
        return input.to_string();
    }
    match input.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with(['/', '\\']) => {
            format!("{home}{rest}")
        }
        _ => input.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::*;
    use crate::skills::types::test_support::TempDir;

    /// `<temp>/base` with `root/inside.txt` and `root-evil/secret.txt`, as real paths.
    fn fixture() -> (TempDir, PathBuf) {
        let dir = TempDir::new();
        let base = real_path(&dir.0).expect("canonical temp dir");
        fs::create_dir_all(base.join("root")).expect("root");
        fs::create_dir_all(base.join("root-evil")).expect("sibling");
        fs::write(base.join("root").join("inside.txt"), "in").expect("inside");
        fs::write(base.join("root-evil").join("secret.txt"), "out").expect("secret");
        (dir, base)
    }

    #[test]
    fn empty_path_is_400() {
        let err = resolve_with_config("   ", "", &[Some("/x")]).expect_err("empty");
        assert_eq!(
            err,
            RejectedPath {
                status: 400,
                error: "path is required"
            }
        );
    }

    #[test]
    fn missing_path_is_404() {
        let (_dir, base) = fixture();
        let missing = base.join("root").join("nope.txt");
        let err = resolve_with_config(&missing.to_string_lossy(), "", &[Some("root")])
            .expect_err("missing");
        assert_eq!(err.status, 404);
        assert_eq!(err.error, "File or directory not found");
    }

    #[test]
    fn no_configured_roots_is_500() {
        let (_dir, base) = fixture();
        let file = base.join("root").join("inside.txt");
        let err = resolve_with_config(&file.to_string_lossy(), "", &[None, Some("  "), Some("")])
            .expect_err("no roots");
        assert_eq!(
            err,
            RejectedPath {
                status: 500,
                error: "Allowed file roots are not configured"
            }
        );
    }

    #[test]
    fn file_below_a_root_is_allowed_and_returned_resolved() {
        let (_dir, base) = fixture();
        let root = base.join("root");
        let file = root.join("inside.txt");
        let resolved = resolve_with_config(
            &file.to_string_lossy(),
            "",
            &[Some(root.to_str().expect("utf-8 path"))],
        )
        .expect("allowed");
        assert_eq!(resolved, real_path(&file).expect("real"));
    }

    #[test]
    fn sibling_sharing_the_root_prefix_is_403() {
        let (_dir, base) = fixture();
        let root = base.join("root");
        let secret = base.join("root-evil").join("secret.txt");
        let err = resolve_with_config(
            &secret.to_string_lossy(),
            "",
            &[Some(root.to_str().expect("utf-8 path"))],
        )
        .expect_err("sibling");
        assert_eq!(
            err,
            RejectedPath {
                status: 403,
                error: "Path not allowed"
            }
        );
    }

    #[test]
    fn tilde_expands_to_the_home_directory() {
        let (_dir, base) = fixture();
        let root = base.join("root");
        let resolved = resolve_with_config(
            "~/root/inside.txt",
            &base.to_string_lossy(),
            &[Some(root.to_str().expect("utf-8 path"))],
        )
        .expect("tilde path");
        assert_eq!(resolved, real_path(&root.join("inside.txt")).expect("real"));
    }

    #[cfg(unix)]
    #[test]
    fn symlink_out_of_the_root_is_403() {
        let (_dir, base) = fixture();
        let root = base.join("root");
        std::os::unix::fs::symlink(base.join("root-evil"), root.join("link")).expect("link");
        let err = resolve_with_config(
            &root.join("link").join("secret.txt").to_string_lossy(),
            "",
            &[Some(root.to_str().expect("utf-8 path"))],
        )
        .expect_err("symlink");
        assert_eq!(err.status, 403);
    }
}
