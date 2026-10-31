//! Port of `src/server/skills/handlers/codingCompat.ts`.
//!
//! The coding tools `read`, `write`, `edit` and `apply_patch`. Every path goes through
//! [`resolve_workspace_path`], so each tool stays inside the workspace root.
//!
//! Deviations:
//! - A single-occurrence `edit` inserts `newText` literally. TypeScript's `String.replace`
//!   also reads `$&`, `$1` and similar patterns in the replacement, which is a bug, not a
//!   feature. `replaceAll` already inserted it literally in TypeScript.
//! - `write` and `edit` read and write the file as UTF-8, with invalid bytes replaced when
//!   reading, as Node does.
//! - Error texts from the file system come from Rust (`os error N`), not from Node's `ENOENT`
//!   format.

use serde_json::{json, Map, Value};
use tokio::io::AsyncWriteExt as _;

use super::apply_patch_compat::{apply_update_hunk, UpdateChunk};
use super::http_text::{js_slice_to, json_number, utf16_len};
use super::types::{
    arg_string, js_to_number, js_to_string, js_trim, SkillDispatchContext, SkillError,
};
use super::workspace_fs::{
    ensure_parent_dir, resolve_workspace_path, resolve_workspace_root, WorkspacePath,
};
use crate::personas::workspace::PersonaWorkspace;
use crate::safe_error_message;

/// `DEFAULT_READ_MAX_CHARS`.
const DEFAULT_READ_MAX_CHARS: f64 = 200_000.0;
const BEGIN_PATCH: &str = "*** Begin Patch";
const END_PATCH: &str = "*** End Patch";
const ADD_FILE: &str = "*** Add File: ";
const DELETE_FILE: &str = "*** Delete File: ";
const UPDATE_FILE: &str = "*** Update File: ";
const MOVE_TO: &str = "*** Move to: ";
const EOF_MARKER: &str = "*** End of File";
const CHANGE_CONTEXT: &str = "@@ ";
const EMPTY_CHANGE_CONTEXT: &str = "@@";

/// One section of a patch (codingCompat.ts `Hunk`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Hunk {
    Add {
        path: String,
        contents: String,
    },
    Delete {
        path: String,
    },
    Update {
        path: String,
        move_path: Option<String>,
        chunks: Vec<UpdateChunk>,
    },
}

/// `read`: a line range of a workspace file.
pub async fn read_compat(
    args: &Map<String, Value>,
    ctx: &SkillDispatchContext,
    personas: &PersonaWorkspace,
) -> Result<Value, SkillError> {
    let input_path = path_arg(args);
    if input_path.is_empty() {
        return Err(SkillError("read requires path.".to_string()));
    }
    let max_chars_raw = first_number(args, &["maxChars"], DEFAULT_READ_MAX_CHARS);
    let max_chars = if max_chars_raw.is_finite() {
        max_chars_raw.floor().clamp(1_000.0, 1_000_000.0) as usize
    } else {
        DEFAULT_READ_MAX_CHARS as usize
    };

    let workspace = resolve_workspace_path(&input_path, personas, ctx)?;
    let bytes = tokio::fs::read(&workspace.resolved_path)
        .await
        .map_err(io_error)?;
    let content = String::from_utf8_lossy(&bytes).into_owned();

    let from_raw = first_number(args, &["from", "startLine"], 1.0);
    let lines_raw = first_number(args, &["lines", "lineCount"], f64::INFINITY);
    let start_line = if from_raw.is_finite() {
        from_raw.floor().max(1.0)
    } else {
        1.0
    };
    let line_count = lines_raw.is_finite().then(|| lines_raw.floor().max(1.0));

    let split: Vec<&str> = content.split('\n').collect();
    let total = split.len();
    let end_line = match line_count {
        Some(count) => (start_line + count - 1.0).min(total as f64),
        None => total as f64,
    };
    let first = ((start_line - 1.0).min(total as f64)) as usize;
    let end = end_line as usize;
    let selected = if end > first {
        split[first..end].join("\n")
    } else {
        String::new()
    };

    let truncated = utf16_len(&selected) > max_chars;
    let content = if truncated {
        js_slice_to(&selected, max_chars as i64).to_string()
    } else {
        selected
    };
    Ok(json!({
        "path": workspace.relative_path,
        "resolvedPath": workspace.resolved_path.to_string_lossy(),
        "startLine": json_number(start_line),
        "endLine": json_number(end_line),
        "totalLines": total,
        "truncated": truncated,
        "content": content,
    }))
}

/// `write`: replaces the file, or appends to it when `append` is truthy.
pub async fn write_compat(
    args: &Map<String, Value>,
    ctx: &SkillDispatchContext,
    personas: &PersonaWorkspace,
) -> Result<Value, SkillError> {
    let input_path = path_arg(args);
    if input_path.is_empty() {
        return Err(SkillError("write requires path.".to_string()));
    }
    let content = first_text(args, &["content", "text"]);
    let append = is_truthy(args.get("append"));
    let workspace = resolve_workspace_path(&input_path, personas, ctx)?;
    ensure_parent_dir(&workspace.resolved_path)?;

    if append {
        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&workspace.resolved_path)
            .await
            .map_err(io_error)?;
        file.write_all(content.as_bytes()).await.map_err(io_error)?;
        file.flush().await.map_err(io_error)?;
    } else {
        tokio::fs::write(&workspace.resolved_path, content.as_bytes())
            .await
            .map_err(io_error)?;
    }
    let mode = if append { "append" } else { "write" };
    Ok(json!({
        "ok": true,
        "path": workspace.relative_path,
        "bytes": content.len(),
        "mode": mode,
    }))
}

/// `edit`: replaces `oldText` with `newText`, or replaces a line range.
pub async fn edit_compat(
    args: &Map<String, Value>,
    ctx: &SkillDispatchContext,
    personas: &PersonaWorkspace,
) -> Result<Value, SkillError> {
    let input_path = path_arg(args);
    if input_path.is_empty() {
        return Err(SkillError("edit requires path.".to_string()));
    }
    let workspace = resolve_workspace_path(&input_path, personas, ctx)?;
    let original = read_text(&workspace).await?;

    let old_text = first_text(args, &["oldText", "old", "search"]);
    let new_text = first_text(args, &["newText", "new", "replace"]);
    let replace_all = is_truthy(args.get("replaceAll"));

    if !old_text.is_empty() {
        if !original.contains(&old_text) {
            return Err(SkillError(
                "edit could not find oldText in file.".to_string(),
            ));
        }
        if replace_all {
            let replacements = original.matches(&old_text).count();
            let next = original.replace(&old_text, &new_text);
            write_text(&workspace, &next).await?;
            return Ok(json!({
                "ok": true,
                "path": workspace.relative_path,
                "replacements": replacements,
                "mode": "text",
            }));
        }
        let next = original.replacen(&old_text, &new_text, 1);
        write_text(&workspace, &next).await?;
        return Ok(json!({
            "ok": true,
            "path": workspace.relative_path,
            "replacements": 1,
            "mode": "text",
        }));
    }

    let from_raw = first_number(args, &["from", "startLine"], f64::NAN);
    let to_raw = first_number(args, &["to", "endLine"], f64::NAN);
    if !from_raw.is_finite() || !to_raw.is_finite() {
        return Err(SkillError(
            "edit requires oldText/newText or from/to line range.".to_string(),
        ));
    }
    let start_line = from_raw.floor().max(1.0);
    let end_line = to_raw.floor().max(start_line);
    let lines: Vec<&str> = original.split('\n').collect();
    let total = lines.len() as f64;
    let before_end = (start_line - 1.0).min(total) as usize;
    let after_start = end_line.min(total) as usize;
    let replacement: Vec<&str> = new_text.split('\n').collect();
    let mut next_lines: Vec<&str> = Vec::with_capacity(lines.len() + replacement.len());
    next_lines.extend_from_slice(&lines[..before_end]);
    next_lines.extend_from_slice(&replacement);
    next_lines.extend_from_slice(&lines[after_start..]);
    write_text(&workspace, &next_lines.join("\n")).await?;

    Ok(json!({
        "ok": true,
        "path": workspace.relative_path,
        "mode": "line-range",
        "startLine": json_number(start_line),
        "endLine": json_number(end_line),
        "insertedLines": replacement.len(),
    }))
}

/// `apply_patch`: applies a `*** Begin Patch` ... `*** End Patch` document.
///
/// As in TypeScript, the sections are applied one after another. A failure part way through
/// leaves the earlier sections applied.
pub async fn apply_patch_compat(
    args: &Map<String, Value>,
    ctx: &SkillDispatchContext,
    personas: &PersonaWorkspace,
) -> Result<Value, SkillError> {
    let input = js_trim(&first_text(args, &["input", "patch"])).to_string();
    if input.is_empty() {
        return Err(SkillError("apply_patch requires input.".to_string()));
    }
    let workspace_root = resolve_workspace_root(personas, ctx)?;
    let hunks = parse_patch_text(&input)?;
    if hunks.is_empty() {
        return Err(SkillError("No files were modified.".to_string()));
    }

    let mut summary = Summary::default();
    for hunk in hunks {
        match hunk {
            Hunk::Add { path, contents } => {
                let target = resolve_workspace_path(&path, personas, ctx)?;
                ensure_parent_dir(&target.resolved_path)?;
                tokio::fs::write(&target.resolved_path, contents)
                    .await
                    .map_err(io_error)?;
                summary.added.push(target.relative_path);
            }
            Hunk::Delete { path } => {
                let target = resolve_workspace_path(&path, personas, ctx)?;
                tokio::fs::remove_file(&target.resolved_path)
                    .await
                    .map_err(io_error)?;
                summary.deleted.push(target.relative_path);
            }
            Hunk::Update {
                path,
                move_path,
                chunks,
            } => {
                let source = resolve_workspace_path(&path, personas, ctx)?;
                let updated = apply_update_hunk(&source.resolved_path, &chunks).await?;
                match move_path.filter(|target| !target.is_empty()) {
                    Some(move_to) => {
                        let target = resolve_workspace_path(&move_to, personas, ctx)?;
                        ensure_parent_dir(&target.resolved_path)?;
                        tokio::fs::write(&target.resolved_path, updated)
                            .await
                            .map_err(io_error)?;
                        tokio::fs::remove_file(&source.resolved_path)
                            .await
                            .map_err(io_error)?;
                        summary.modified.push(target.relative_path);
                    }
                    None => {
                        tokio::fs::write(&source.resolved_path, updated)
                            .await
                            .map_err(io_error)?;
                        summary.modified.push(source.relative_path);
                    }
                }
            }
        }
    }

    let text = format_summary(&summary);
    Ok(json!({
        "ok": true,
        "workspaceRoot": workspace_root.to_string_lossy(),
        "summary": {
            "added": summary.added,
            "modified": summary.modified,
            "deleted": summary.deleted,
        },
        "text": text,
    }))
}

#[derive(Debug, Default)]
struct Summary {
    added: Vec<String>,
    modified: Vec<String>,
    deleted: Vec<String>,
}

fn format_summary(summary: &Summary) -> String {
    let mut lines = vec!["Success. Updated the following files:".to_string()];
    lines.extend(summary.added.iter().map(|file| format!("A {file}")));
    lines.extend(summary.modified.iter().map(|file| format!("M {file}")));
    lines.extend(summary.deleted.iter().map(|file| format!("D {file}")));
    lines.join("\n")
}

/// `parsePatchText`: splits a patch into its sections. Lines are split on `\n`, and a
/// `\r` before it is dropped.
pub fn parse_patch_text(input: &str) -> Result<Vec<Hunk>, SkillError> {
    let lines = split_patch_lines(input);
    let last = lines.len() - 1;
    if js_trim(lines[0]) != BEGIN_PATCH {
        return Err(SkillError(
            "The first line of the patch must be '*** Begin Patch'.".to_string(),
        ));
    }
    if js_trim(lines[last]) != END_PATCH {
        return Err(SkillError(
            "The last line of the patch must be '*** End Patch'.".to_string(),
        ));
    }

    // The loop bound is `lines.length - 1` in TypeScript, which is `last` here.
    let mut hunks = Vec::new();
    let mut cursor = 1usize;
    while cursor < last {
        let line = js_trim(lines[cursor]);
        if line.is_empty() {
            cursor += 1;
            continue;
        }

        if let Some(path) = line.strip_prefix(ADD_FILE) {
            cursor += 1;
            let mut contents = Vec::new();
            while cursor < last {
                let Some(added) = lines[cursor].strip_prefix('+') else {
                    break;
                };
                contents.push(added);
                cursor += 1;
            }
            hunks.push(Hunk::Add {
                path: path.to_string(),
                contents: format!("{}\n", contents.join("\n")),
            });
            continue;
        }

        if let Some(path) = line.strip_prefix(DELETE_FILE) {
            hunks.push(Hunk::Delete {
                path: path.to_string(),
            });
            cursor += 1;
            continue;
        }

        if let Some(path) = line.strip_prefix(UPDATE_FILE) {
            cursor += 1;
            let mut move_path = None;
            let candidate = js_trim(lines.get(cursor).copied().unwrap_or(""));
            if let Some(target) = candidate.strip_prefix(MOVE_TO) {
                move_path = Some(target.to_string());
                cursor += 1;
            }
            let chunks = parse_update_chunks(&lines, &mut cursor, last)?;
            if chunks.is_empty() {
                return Err(SkillError(format!(
                    "Invalid patch hunk for {path}: update has no chunks."
                )));
            }
            hunks.push(Hunk::Update {
                path: path.to_string(),
                move_path,
                chunks,
            });
            continue;
        }

        return Err(SkillError(format!("Invalid patch line: {line}")));
    }
    Ok(hunks)
}

/// The `@@` chunks of one update section. Stops at the next `*** ` header.
fn parse_update_chunks(
    lines: &[&str],
    cursor: &mut usize,
    last: usize,
) -> Result<Vec<UpdateChunk>, SkillError> {
    let mut chunks = Vec::new();
    while *cursor < last {
        let current = lines[*cursor];
        let trimmed = js_trim(current);
        if trimmed.is_empty() {
            *cursor += 1;
            continue;
        }
        if trimmed.starts_with("*** ") {
            break;
        }

        let mut change_context = None;
        if current == EMPTY_CHANGE_CONTEXT {
            *cursor += 1;
        } else if let Some(context) = current.strip_prefix(CHANGE_CONTEXT) {
            change_context = Some(context.to_string());
            *cursor += 1;
        }

        let mut chunk = UpdateChunk {
            change_context,
            old_lines: Vec::new(),
            new_lines: Vec::new(),
            is_end_of_file: false,
        };
        while *cursor < last {
            let raw = lines[*cursor];
            if raw == EOF_MARKER {
                chunk.is_end_of_file = true;
                *cursor += 1;
                break;
            }
            match raw.chars().next() {
                Some(' ') => {
                    chunk.old_lines.push(raw[1..].to_string());
                    chunk.new_lines.push(raw[1..].to_string());
                }
                Some('+') => chunk.new_lines.push(raw[1..].to_string()),
                Some('-') => chunk.old_lines.push(raw[1..].to_string()),
                _ => break,
            }
            *cursor += 1;
        }

        if chunk.old_lines.is_empty() && chunk.new_lines.is_empty() {
            return Err(SkillError("Invalid update hunk: empty chunk.".to_string()));
        }
        chunks.push(chunk);
    }
    Ok(chunks)
}

/// `input.split(/\r?\n/)`: a `\r` is dropped only when a `\n` follows it.
fn split_patch_lines(input: &str) -> Vec<&str> {
    let parts: Vec<&str> = input.split('\n').collect();
    let last = parts.len() - 1;
    parts
        .iter()
        .enumerate()
        .map(|(index, &part)| {
            if index < last {
                part.strip_suffix('\r').unwrap_or(part)
            } else {
                part
            }
        })
        .collect()
}

/// `String(args.path || '').trim()`.
fn path_arg(args: &Map<String, Value>) -> String {
    js_trim(&arg_string(args, "path")).to_string()
}

/// `String(args[k1] ?? args[k2] ?? ... ?? '')`: the first key whose value is not null.
fn first_text(args: &Map<String, Value>, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| match args.get(*key) {
            None | Some(Value::Null) => None,
            Some(value) => Some(js_to_string(value)),
        })
        .unwrap_or_default()
}

/// `Number(args[k1] ?? args[k2] ?? ... ?? fallback)`.
fn first_number(args: &Map<String, Value>, keys: &[&str], fallback: f64) -> f64 {
    keys.iter()
        .find_map(|key| match args.get(*key) {
            None | Some(Value::Null) => None,
            Some(value) => Some(js_to_number(value)),
        })
        .unwrap_or(fallback)
}

/// JavaScript truthiness of an optional argument.
fn is_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

async fn read_text(workspace: &WorkspacePath) -> Result<String, SkillError> {
    let bytes = tokio::fs::read(&workspace.resolved_path)
        .await
        .map_err(io_error)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

async fn write_text(workspace: &WorkspacePath, contents: &str) -> Result<(), SkillError> {
    tokio::fs::write(&workspace.resolved_path, contents.as_bytes())
        .await
        .map_err(io_error)
}

fn io_error(error: std::io::Error) -> SkillError {
    SkillError(safe_error_message(&error))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::*;
    use crate::skills::types::test_support::TempDir;

    struct Sandbox {
        _dir: TempDir,
        personas: PersonaWorkspace,
        ctx: SkillDispatchContext,
        root: PathBuf,
    }

    /// A workspace `ada` below the persona root, so the dispatch context is accepted.
    fn sandbox() -> Sandbox {
        let dir = TempDir::new();
        let personas = PersonaWorkspace::new(dir.0.join("personas"));
        let root = personas.root_dir().join("ada");
        fs::create_dir_all(&root).expect("workspace");
        let ctx = SkillDispatchContext {
            bypass_approval: false,
            workspace_cwd: Some(root.to_string_lossy().into_owned()),
        };
        Sandbox {
            _dir: dir,
            personas,
            ctx,
            root,
        }
    }

    fn args(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    #[tokio::test]
    async fn read_returns_the_requested_lines_and_totals() {
        let sb = sandbox();
        fs::write(sb.root.join("notes.txt"), "one\ntwo\nthree\nfour").expect("write");
        let out = read_compat(
            &args(json!({"path": "notes.txt", "from": 2, "lines": 2})),
            &sb.ctx,
            &sb.personas,
        )
        .await
        .expect("read");
        assert_eq!(out["content"], "two\nthree");
        assert_eq!(out["startLine"], 2);
        assert_eq!(out["endLine"], 3);
        assert_eq!(out["totalLines"], 4);
        assert_eq!(out["path"], "notes.txt");
        assert_eq!(out["truncated"], false);
    }

    #[tokio::test]
    async fn read_without_a_path_fails_as_in_typescript() {
        let sb = sandbox();
        let error = read_compat(&args(json!({})), &sb.ctx, &sb.personas)
            .await
            .unwrap_err();
        assert_eq!(error.0, "read requires path.");
    }

    #[tokio::test]
    async fn write_replaces_or_appends_and_counts_utf8_bytes() {
        let sb = sandbox();
        let out = write_compat(
            &args(json!({"path": "sub/a.txt", "content": "h\u{e4}"})),
            &sb.ctx,
            &sb.personas,
        )
        .await
        .expect("write");
        assert_eq!(out["bytes"], 3);
        assert_eq!(out["mode"], "write");
        let out = write_compat(
            &args(json!({"path": "sub/a.txt", "text": "!", "append": true})),
            &sb.ctx,
            &sb.personas,
        )
        .await
        .expect("append");
        assert_eq!(out["mode"], "append");
        assert_eq!(
            fs::read_to_string(sb.root.join("sub").join("a.txt")).expect("read"),
            "h\u{e4}!"
        );
    }

    #[tokio::test]
    async fn edit_replaces_the_first_match_or_all_matches() {
        let sb = sandbox();
        fs::write(sb.root.join("e.txt"), "x x x").expect("write");
        let out = edit_compat(
            &args(json!({"path": "e.txt", "oldText": "x", "newText": "y"})),
            &sb.ctx,
            &sb.personas,
        )
        .await
        .expect("edit");
        assert_eq!(out["replacements"], 1);
        assert_eq!(
            fs::read_to_string(sb.root.join("e.txt")).expect("read"),
            "y x x"
        );
        let out = edit_compat(
            &args(json!({"path": "e.txt", "oldText": "x", "newText": "$&", "replaceAll": true})),
            &sb.ctx,
            &sb.personas,
        )
        .await
        .expect("replace all");
        assert_eq!(out["replacements"], 2);
        assert_eq!(
            fs::read_to_string(sb.root.join("e.txt")).expect("read"),
            "y $& $&"
        );
    }

    #[tokio::test]
    async fn edit_replaces_a_line_range_and_reports_missing_text() {
        let sb = sandbox();
        fs::write(sb.root.join("l.txt"), "a\nb\nc\n").expect("write");
        let out = edit_compat(
            &args(json!({"path": "l.txt", "from": 2, "to": 2, "newText": "B1\nB2"})),
            &sb.ctx,
            &sb.personas,
        )
        .await
        .expect("line edit");
        assert_eq!(out["mode"], "line-range");
        assert_eq!(out["insertedLines"], 2);
        assert_eq!(
            fs::read_to_string(sb.root.join("l.txt")).expect("read"),
            "a\nB1\nB2\nc\n"
        );
        let error = edit_compat(
            &args(json!({"path": "l.txt", "oldText": "zzz", "newText": "q"})),
            &sb.ctx,
            &sb.personas,
        )
        .await
        .unwrap_err();
        assert_eq!(error.0, "edit could not find oldText in file.");
    }

    #[tokio::test]
    async fn apply_patch_adds_updates_moves_and_deletes_files() {
        let sb = sandbox();
        fs::write(sb.root.join("keep.txt"), "a\nb\nc\n").expect("keep");
        fs::write(sb.root.join("gone.txt"), "bye\n").expect("gone");
        let patch = "*** Begin Patch\n*** Add File: new/added.txt\n+hello\n+world\n*** Update File: keep.txt\n*** Move to: moved.txt\n@@\n a\n-b\n+B\n c\n*** Delete File: gone.txt\n*** End Patch";
        let out = apply_patch_compat(&args(json!({"input": patch})), &sb.ctx, &sb.personas)
            .await
            .expect("patch");
        assert_eq!(
            out["text"],
            "Success. Updated the following files:\nA new/added.txt\nM moved.txt\nD gone.txt"
        );
        assert_eq!(
            fs::read_to_string(sb.root.join("new").join("added.txt")).expect("added"),
            "hello\nworld\n"
        );
        assert_eq!(
            fs::read_to_string(sb.root.join("moved.txt")).expect("moved"),
            "a\nB\nc\n"
        );
        assert!(!sb.root.join("keep.txt").exists());
        assert!(!sb.root.join("gone.txt").exists());
    }

    #[test]
    fn parse_rejects_malformed_patches_with_the_typescript_messages() {
        assert_eq!(
            parse_patch_text("nope\n*** End Patch").unwrap_err().0,
            "The first line of the patch must be '*** Begin Patch'."
        );
        assert_eq!(
            parse_patch_text("*** Begin Patch\n*** Nothing")
                .unwrap_err()
                .0,
            "The last line of the patch must be '*** End Patch'."
        );
        assert_eq!(
            parse_patch_text("*** Begin Patch\nbogus\n*** End Patch")
                .unwrap_err()
                .0,
            "Invalid patch line: bogus"
        );
        assert_eq!(
            parse_patch_text("*** Begin Patch\n*** Update File: a.txt\n*** End Patch")
                .unwrap_err()
                .0,
            "Invalid patch hunk for a.txt: update has no chunks."
        );
        let empty = parse_patch_text("*** Begin Patch\n*** End Patch").expect("parses");
        assert!(empty.is_empty());
    }

    #[test]
    fn parse_reads_move_targets_and_end_of_file_markers() {
        let hunks = parse_patch_text("*** Begin Patch\r\n*** Update File: a.txt\r\n*** Move to: b.txt\r\n@@ fn main\r\n-x\r\n+y\r\n*** End of File\r\n*** End Patch").expect("parses");
        match &hunks[0] {
            Hunk::Update {
                path,
                move_path,
                chunks,
            } => {
                assert_eq!(path, "a.txt");
                assert_eq!(move_path.as_deref(), Some("b.txt"));
                assert_eq!(chunks[0].change_context.as_deref(), Some("fn main"));
                assert!(chunks[0].is_end_of_file);
            }
            other => panic!("unexpected hunk {other:?}"),
        }
    }
}
