//! Mirrors `src/server/skills/handlers/fileRead.ts`.
//!
//! Reads one text file from the workspace. The path must start with an allowed top-level
//! directory, or name one of the allowed top-level files. Its real location, with symbolic
//! links resolved, must stay inside the workspace root.
//!
//! The TypeScript root is the repository root, derived from the module's own location.
//! Rust has no such location, so the caller passes `workspace_root`. As in TypeScript, the
//! root itself is not resolved through symbolic links.
//!
//! Deviation: the size limit counts UTF-16 code units, as JavaScript `String.length` does.
//! A cut that would split a surrogate pair stops one unit earlier.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use super::execution_cwd::{lexical_resolve, real_path};
use super::types::{arg_string, js_trim, SkillError};
use crate::safe_error_message;
use crate::security::path_boundary::is_path_within_root;

/// `MAX_FILE_BYTES`. The TypeScript code compares it with `String.length`.
const MAX_CONTENT_UNITS: usize = 256_000;

const ALLOWED_TOP_LEVEL_DIRS: [&str; 13] = [
    "app",
    "components",
    "core",
    "docs",
    "lib",
    "messenger",
    "ops",
    "services",
    "skills",
    "src",
    "styles",
    "tests",
    "types",
];
const ALLOWED_TOP_LEVEL_FILES: [&str; 6] = [
    "README.md",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "next.config.ts",
    ".oxlintrc.json",
];

/// The `{ path, resolvedPath, truncated, content }` result of `fileReadHandler`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileReadOutput {
    /// The trimmed path as the caller sent it.
    pub path: String,
    pub resolved_path: PathBuf,
    pub truncated: bool,
    pub content: String,
}

/// `fileReadHandler`.
pub async fn file_read(
    args: &Map<String, Value>,
    workspace_root: &Path,
) -> Result<FileReadOutput, SkillError> {
    let input_path = js_trim(&arg_string(args, "path")).to_string();
    if input_path.is_empty() {
        return Err(SkillError(
            "file_read requires a non-empty path.".to_string(),
        ));
    }

    let resolved = ensure_workspace_path(&input_path, workspace_root)?;
    let real = real_path(&resolved).map_err(io_error)?;
    if !is_path_within_root(&real, workspace_root) {
        return Err(SkillError(
            "Path escapes workspace root through a symbolic link.".to_string(),
        ));
    }

    let bytes = tokio::fs::read(&real).await.map_err(io_error)?;
    let (content, truncated) = truncate_units(
        String::from_utf8_lossy(&bytes).into_owned(),
        MAX_CONTENT_UNITS,
    );
    Ok(FileReadOutput {
        path: input_path,
        resolved_path: real,
        truncated,
        content,
    })
}

/// `ensureWorkspacePath`: maps the user path to a location under the workspace root,
/// using only the allowed top-level entries. Backslashes count as separators.
fn ensure_workspace_path(user_path: &str, workspace_root: &Path) -> Result<PathBuf, SkillError> {
    let normalized = user_path.replace('\\', "/");
    let mut segments = normalized
        .trim_start_matches('/')
        .split('/')
        .filter(|segment| !segment.is_empty());
    let Some(head) = segments.next() else {
        return Err(SkillError(
            "Path must reference a workspace file.".to_string(),
        ));
    };
    let tail: Vec<&str> = segments.collect();

    let resolved = if ALLOWED_TOP_LEVEL_DIRS.contains(&head) {
        lexical_resolve(&workspace_root.join(head).join(tail.join("/")))
    } else if ALLOWED_TOP_LEVEL_FILES.contains(&head) && tail.is_empty() {
        lexical_resolve(&workspace_root.join(head))
    } else {
        return Err(SkillError(format!(
            "Path is not in an allowed workspace location: {head}"
        )));
    };

    if !is_path_within_root(&resolved, workspace_root) {
        return Err(SkillError("Path escapes workspace root.".to_string()));
    }
    Ok(resolved)
}

/// `content.length > MAX` and `content.slice(0, MAX)`, counted in UTF-16 code units.
fn truncate_units(content: String, max_units: usize) -> (String, bool) {
    if content.encode_utf16().count() <= max_units {
        return (content, false);
    }
    let mut units = 0;
    let mut end = 0;
    for (index, character) in content.char_indices() {
        let width = character.len_utf16();
        if units + width > max_units {
            break;
        }
        units += width;
        end = index + character.len_utf8();
    }
    (content[..end].to_string(), true)
}

fn io_error(error: std::io::Error) -> SkillError {
    SkillError(safe_error_message(&error))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::skills::types::test_support::TempDir;
    use serde_json::json;

    /// A workspace root `<temp>/ws` with `src/a.txt` and `README.md`. The root is
    /// canonical, as the production root is expected to be.
    fn workspace() -> (TempDir, PathBuf) {
        let dir = TempDir::new();
        let root = dir.0.join("ws");
        fs::create_dir_all(root.join("src")).expect("src");
        fs::write(root.join("src").join("a.txt"), "hello").expect("a.txt");
        fs::write(root.join("README.md"), "readme").expect("README");
        let root = real_path(&root).expect("canonical root");
        (dir, root)
    }

    fn args(path: &str) -> Map<String, Value> {
        json!({ "path": path })
            .as_object()
            .cloned()
            .unwrap_or_default()
    }

    fn error_text(result: Result<FileReadOutput, SkillError>) -> String {
        result.expect_err("expected an error").0
    }

    #[tokio::test]
    async fn reads_an_allowed_file_and_accepts_backslashes() {
        let (_dir, root) = workspace();
        let out = file_read(&args("src\\a.txt"), &root).await.expect("read");
        assert_eq!(out.path, "src\\a.txt");
        assert_eq!(out.content, "hello");
        assert!(!out.truncated);
        assert_eq!(
            out.resolved_path,
            real_path(&root.join("src").join("a.txt")).expect("real")
        );
    }

    #[tokio::test]
    async fn top_level_files_are_only_allowed_without_a_tail() {
        let (_dir, root) = workspace();
        let out = file_read(&args("README.md"), &root).await.expect("README");
        assert_eq!(out.content, "readme");
        assert_eq!(
            error_text(file_read(&args("README.md/x"), &root).await),
            "Path is not in an allowed workspace location: README.md"
        );
    }

    #[tokio::test]
    async fn empty_and_rootless_paths_are_rejected() {
        let (_dir, root) = workspace();
        assert_eq!(
            error_text(file_read(&args("   "), &root).await),
            "file_read requires a non-empty path."
        );
        assert_eq!(
            error_text(file_read(&args("/"), &root).await),
            "Path must reference a workspace file."
        );
    }

    #[tokio::test]
    async fn disallowed_top_level_entries_are_rejected() {
        let (_dir, root) = workspace();
        assert_eq!(
            error_text(file_read(&args("etc/passwd"), &root).await),
            "Path is not in an allowed workspace location: etc"
        );
        assert_eq!(
            error_text(file_read(&args("../secret"), &root).await),
            "Path is not in an allowed workspace location: .."
        );
    }

    #[tokio::test]
    async fn dot_dot_inside_an_allowed_directory_cannot_leave_the_root() {
        let (dir, root) = workspace();
        fs::write(dir.0.join("secret.txt"), "outside").expect("secret");
        assert_eq!(
            error_text(file_read(&args("src/../../secret.txt"), &root).await),
            "Path escapes workspace root."
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlink_out_of_the_root_is_rejected() {
        let (dir, root) = workspace();
        let outside = dir.0.join("outside");
        fs::create_dir_all(&outside).expect("outside");
        fs::write(outside.join("secret.txt"), "outside").expect("secret");
        std::os::unix::fs::symlink(&outside, root.join("src").join("link")).expect("link");
        assert_eq!(
            error_text(file_read(&args("src/link/secret.txt"), &root).await),
            "Path escapes workspace root through a symbolic link."
        );
    }

    #[tokio::test]
    async fn content_above_the_limit_is_cut_and_flagged() {
        let (_dir, root) = workspace();
        fs::write(root.join("src").join("big.txt"), "a".repeat(300_000)).expect("big");
        let out = file_read(&args("src/big.txt"), &root).await.expect("read");
        assert!(out.truncated);
        assert_eq!(out.content.len(), MAX_CONTENT_UNITS);
    }

    #[test]
    fn truncation_does_not_split_a_surrogate_pair() {
        // "😀" is two UTF-16 units. 255 999 + 2 would be 256 001, so the emoji is dropped.
        let text = format!("{}😀", "a".repeat(255_999));
        let (cut, truncated) = truncate_units(text, MAX_CONTENT_UNITS);
        assert!(truncated);
        assert_eq!(cut.encode_utf16().count(), 255_999);
    }
}
