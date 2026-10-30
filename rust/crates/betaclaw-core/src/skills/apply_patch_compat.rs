//! Port of `src/server/skills/handlers/applyPatchCompatUpdate.ts`.
//!
//! `applyUpdateHunk` applies the chunks of one `*** Update File` section to a file. Each chunk
//! is searched for from the end of the previous match. The search tries an exact match, then
//! a match ignoring trailing whitespace, then one ignoring all surrounding whitespace.

use std::path::Path;

use super::types::{is_js_space, js_trim, SkillError};
use crate::safe_error_message;

/// One `@@` chunk of an update hunk (applyPatchCompatUpdate.ts `UpdateFileChunk`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateChunk {
    pub change_context: Option<String>,
    pub old_lines: Vec<String>,
    pub new_lines: Vec<String>,
    pub is_end_of_file: bool,
}

/// `(start, old_length, new_lines)`: one replacement, applied from the back.
type Replacement = (usize, usize, Vec<String>);

/// `applyUpdateHunk`: reads `file_path`, applies `chunks` and returns the new contents.
pub async fn apply_update_hunk(
    file_path: &Path,
    chunks: &[UpdateChunk],
) -> Result<String, SkillError> {
    let original = tokio::fs::read(file_path).await.map_err(|error| {
        SkillError(format!(
            "Failed to read file to update {}: {}",
            file_path.display(),
            safe_error_message(&error)
        ))
    })?;
    let text = String::from_utf8_lossy(&original);
    let mut lines: Vec<String> = text.split('\n').map(str::to_string).collect();
    if lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }

    let replacements = compute_replacements(&lines, file_path, chunks)?;
    let mut new_lines = apply_replacements(lines, replacements);
    if new_lines.last().is_none_or(|line| !line.is_empty()) {
        new_lines.push(String::new());
    }
    Ok(new_lines.join("\n"))
}

fn compute_replacements(
    lines: &[String],
    file_path: &Path,
    chunks: &[UpdateChunk],
) -> Result<Vec<Replacement>, SkillError> {
    let mut replacements = Vec::new();
    let mut line_index = 0usize;

    for chunk in chunks {
        if let Some(context) = chunk.change_context.as_deref().filter(|c| !c.is_empty()) {
            let context_index = seek_sequence(lines, &[context.to_string()], line_index, false)
                .ok_or_else(|| {
                    SkillError(format!(
                        "Failed to find context '{context}' in {}",
                        file_path.display()
                    ))
                })?;
            line_index = context_index + 1;
        }

        if chunk.old_lines.is_empty() {
            let insertion = if lines.last().is_some_and(String::is_empty) {
                lines.len() - 1
            } else {
                lines.len()
            };
            replacements.push((insertion, 0, chunk.new_lines.clone()));
            continue;
        }

        let mut pattern_len = chunk.old_lines.len();
        let mut new_slice = chunk.new_lines.clone();
        let mut found = seek_sequence(lines, &chunk.old_lines, line_index, chunk.is_end_of_file);
        if found.is_none() && chunk.old_lines.last().is_some_and(String::is_empty) {
            // A trailing empty line in the pattern may be the end of the file.
            pattern_len -= 1;
            if new_slice.last().is_some_and(String::is_empty) {
                new_slice.pop();
            }
            found = seek_sequence(
                lines,
                &chunk.old_lines[..pattern_len],
                line_index,
                chunk.is_end_of_file,
            );
        }

        let Some(found) = found else {
            return Err(SkillError(format!(
                "Failed to find expected lines in {}:\n{}",
                file_path.display(),
                chunk.old_lines.join("\n")
            )));
        };
        replacements.push((found, pattern_len, new_slice));
        line_index = found + pattern_len;
    }

    // `Array.prototype.sort` is stable, and so is `sort_by_key`.
    replacements.sort_by_key(|replacement| replacement.0);
    Ok(replacements)
}

/// `applyReplacements`: removes and inserts lines, from the last replacement to the first.
fn apply_replacements(mut lines: Vec<String>, replacements: Vec<Replacement>) -> Vec<String> {
    for (start, old_length, new_lines) in replacements.into_iter().rev() {
        for _ in 0..old_length {
            if start < lines.len() {
                lines.remove(start);
            }
        }
        for (offset, line) in new_lines.into_iter().enumerate() {
            // `splice` past the end appends, so the insertion index is clamped.
            let at = (start + offset).min(lines.len());
            lines.insert(at, line);
        }
    }
    lines
}

/// `seekSequence`: the first index at or after `start` where `pattern` matches, trying three
/// levels of whitespace tolerance in turn.
fn seek_sequence(lines: &[String], pattern: &[String], start: usize, eof: bool) -> Option<usize> {
    if pattern.is_empty() {
        return Some(start);
    }
    if pattern.len() > lines.len() {
        return None;
    }
    let max_start = lines.len() - pattern.len();
    let search_start = if eof && lines.len() >= pattern.len() {
        max_start
    } else {
        start
    };
    if search_start > max_start {
        return None;
    }
    let levels: [fn(&str) -> &str; 3] = [exact, trim_end, trim_both];
    for normalize in levels {
        for index in search_start..=max_start {
            if lines_match(lines, pattern, index, normalize) {
                return Some(index);
            }
        }
    }
    None
}

fn lines_match(
    lines: &[String],
    pattern: &[String],
    start: usize,
    normalize: fn(&str) -> &str,
) -> bool {
    pattern
        .iter()
        .enumerate()
        .all(|(offset, expected)| normalize(&lines[start + offset]) == normalize(expected))
}

fn exact(text: &str) -> &str {
    text
}

fn trim_end(text: &str) -> &str {
    text.trim_end_matches(is_js_space)
}

fn trim_both(text: &str) -> &str {
    js_trim(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::types::test_support::TempDir;
    use std::fs;

    fn chunk(old: &[&str], new: &[&str]) -> UpdateChunk {
        UpdateChunk {
            change_context: None,
            old_lines: old.iter().map(|line| line.to_string()).collect(),
            new_lines: new.iter().map(|line| line.to_string()).collect(),
            is_end_of_file: false,
        }
    }

    #[tokio::test]
    async fn a_chunk_replaces_its_lines_and_keeps_the_final_newline() {
        let dir = TempDir::new();
        let file = dir.0.join("a.txt");
        fs::write(&file, "a\nb\nc\n").expect("write");
        let updated = apply_update_hunk(&file, &[chunk(&["b"], &["B"])])
            .await
            .expect("apply");
        assert_eq!(updated, "a\nB\nc\n");
    }

    #[tokio::test]
    async fn a_chunk_matches_when_only_whitespace_differs() {
        let dir = TempDir::new();
        let file = dir.0.join("a.txt");
        fs::write(&file, "fn main()  \n    run();\n").expect("write");
        let updated = apply_update_hunk(
            &file,
            &[chunk(&["fn main()", "    run();"], &["fn main() {"])],
        )
        .await
        .expect("apply");
        assert_eq!(updated, "fn main() {\n");
    }

    #[tokio::test]
    async fn a_missing_pattern_is_reported_with_the_expected_lines() {
        let dir = TempDir::new();
        let file = dir.0.join("a.txt");
        fs::write(&file, "one\n").expect("write");
        let error = apply_update_hunk(&file, &[chunk(&["two"], &["2"])])
            .await
            .unwrap_err();
        assert!(
            error.0.starts_with("Failed to find expected lines in "),
            "{}",
            error.0
        );
        assert!(error.0.ends_with(":\ntwo"), "{}", error.0);
    }

    #[test]
    fn an_insertion_past_the_end_is_clamped() {
        let lines = vec!["x".to_string()];
        let out = apply_replacements(lines, vec![(5, 0, vec!["y".to_string()])]);
        assert_eq!(out, vec!["x".to_string(), "y".to_string()]);
    }
}
