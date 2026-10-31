//! Port of `src/server/knowledge/taskTracker.ts` (1-83).
//!
//! | TypeScript                                          | Rust |
//! | --------------------------------------------------- | ---- |
//! | `taskTracker.ts:8` (`TaskStatus`)                   | [`TaskStatus`] |
//! | `taskTracker.ts:9` (`TaskType`)                     | [`TaskType`] |
//! | `taskTracker.ts:11-26` (`TrackedTask`)              | [`TrackedTask`] |
//! | `taskTracker.ts:28-31` (`TaskCompletionMatch`)      | [`TaskCompletionMatch`] |
//! | `taskTracker.ts:33-34` (`COMPLETION_SIGNALS`)       | [`completion_signals`] |
//! | `taskTracker.ts:43-83` (`detectTaskCompletion`)     | [`detect_task_completion`] |
//!
//! # JavaScript semantics that are reproduced explicitly
//!
//! * `\b` is JavaScript's ASCII boundary (`(?-u:\b)`), and `\s` is spelled out
//!   as [`JS_WHITESPACE`] — the fragments the recurrence detector already uses.
//! * `title.split(/\s+/)` (`:60`) splits on runs of JavaScript whitespace, and
//!   `filter((w) => w.length > 3)` counts UTF-16 code units. The port counts
//!   `char`s, which differs only for astral-plane characters.
//! * `lower.split(/[^\p{L}\p{N}]+/u)` (`:63`) keeps letter/number runs and drops
//!   the empty strings `split` produces at the ends (`filter(Boolean)`).
//! * `Math.max(1, Math.ceil(keywords.length * 0.5))` (`:77`) is computed in
//!   `f64` and rounded up, exactly like the source.
//! * `word.startsWith(normalized.slice(0, 5))` (`:72`) compares the first five
//!   units of both sides, so `"termin"` matches `"Termin"`; the port takes the
//!   first five `char`s.
//! * The second pass returns the *first* task of the input order that clears
//!   the threshold (`:59-80`), not the best-scoring one.

use regex::Regex;
use std::sync::OnceLock;

use super::recurrence_detector::JS_WHITESPACE;

/// `TaskStatus` from `taskTracker.ts:8`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskStatus {
    Open,
    InProgress,
    Done,
    Overdue,
    Cancelled,
}

impl TaskStatus {
    /// The TypeScript union member, verbatim.
    pub fn as_str(self) -> &'static str {
        match self {
            TaskStatus::Open => "open",
            TaskStatus::InProgress => "in_progress",
            TaskStatus::Done => "done",
            TaskStatus::Overdue => "overdue",
            TaskStatus::Cancelled => "cancelled",
        }
    }
}

/// `TaskType` from `taskTracker.ts:9`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskType {
    OneTime,
    Recurring,
    Deadline,
    Preference,
}

impl TaskType {
    /// The TypeScript union member, verbatim.
    pub fn as_str(self) -> &'static str {
        match self {
            TaskType::OneTime => "one_time",
            TaskType::Recurring => "recurring",
            TaskType::Deadline => "deadline",
            TaskType::Preference => "preference",
        }
    }
}

/// `TrackedTask` from `taskTracker.ts:11-26`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrackedTask {
    pub id: String,
    pub user_id: String,
    pub persona_id: String,
    pub title: String,
    pub description: Option<String>,
    pub task_type: TaskType,
    pub status: TaskStatus,
    pub deadline: Option<String>,
    pub recurrence: Option<String>,
    pub location: Option<String>,
    pub related_entity_id: Option<String>,
    pub created_at: String,
    pub completed_at: Option<String>,
    pub source_conversation_id: String,
}

/// `TaskCompletionMatch` from `taskTracker.ts:28-31`.
#[derive(Debug, Clone, PartialEq)]
pub struct TaskCompletionMatch {
    pub task: TrackedTask,
    pub match_confidence: f64,
}
/// `COMPLETION_SIGNALS` from `taskTracker.ts:33-34`.
pub fn completion_signals() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?i)(?-u:\b)(erledigt|gemacht|fertig|abgehakt|war beim|hab ich|done|geschafft|abgeschlossen)(?-u:\b)")
            .expect("completion signal pattern")
    })
}

/// `detectTaskCompletion(text, openTasks)` (`taskTracker.ts:43-83`).
pub fn detect_task_completion(
    text: &str,
    open_tasks: &[TrackedTask],
) -> Option<TaskCompletionMatch> {
    if !completion_signals().is_match(text) {
        return None;
    }

    let lower = text.to_lowercase();

    // First pass: exact title match (high confidence) (`:52-56`).
    for task in open_tasks {
        if lower.contains(&task.title.to_lowercase()) {
            return Some(TaskCompletionMatch {
                task: task.clone(),
                match_confidence: 0.9,
            });
        }
    }

    // Second pass: fuzzy keyword match (`:59-80`).
    let message_words: Vec<&str> = word_pattern()
        .split(&lower)
        .filter(|word| !word.is_empty())
        .collect();

    for task in open_tasks {
        let keywords: Vec<&str> = whitespace_pattern()
            .split(&task.title)
            .filter(|word| word.chars().count() > 3)
            .collect();
        if keywords.is_empty() {
            continue;
        }

        let match_count = keywords
            .iter()
            .filter(|keyword| {
                let normalized = keyword.to_lowercase();
                lower.contains(&normalized)
                    || message_words.iter().any(|word| {
                        word.chars().count() >= 5
                            && normalized.chars().count() >= 5
                            && (word.starts_with(&first_five(&normalized))
                                || normalized.starts_with(&first_five(word)))
                    })
            })
            .count();

        let threshold = (keywords.len() as f64 * 0.5).ceil().max(1.0) as usize;
        if match_count >= threshold {
            return Some(TaskCompletionMatch {
                task: task.clone(),
                match_confidence: 0.7,
            });
        }
    }

    None
}

/// `/\s+/` (`taskTracker.ts:60`) over JavaScript's whitespace set.
fn whitespace_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN
        .get_or_init(|| Regex::new(&format!("{JS_WHITESPACE}+")).expect("whitespace run pattern"))
}

/// `/[^\p{L}\p{N}]+/u` (`taskTracker.ts:63`).
fn word_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"[^\p{L}\p{N}]+").expect("word separator pattern"))
}

/// `value.slice(0, 5)` (`taskTracker.ts:72`).
fn first_five(value: &str) -> String {
    value.chars().take(5).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(id: &str, title: &str) -> TrackedTask {
        TrackedTask {
            id: id.to_string(),
            user_id: "user-1".to_string(),
            persona_id: "persona-1".to_string(),
            title: title.to_string(),
            description: None,
            task_type: TaskType::OneTime,
            status: TaskStatus::Open,
            deadline: None,
            recurrence: None,
            location: None,
            related_entity_id: None,
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
            completed_at: None,
            source_conversation_id: "conversation-1".to_string(),
        }
    }

    fn open_tasks() -> Vec<TrackedTask> {
        vec![
            task("1", "Nata anrufen"),
            task("2", "Zahnarzt Termin"),
            task("3", "Buch lesen"),
        ]
    }

    /// Node 24 expectations for the fixture list above.
    #[test]
    fn the_two_passes_match_the_source() {
        let tasks = open_tasks();

        // No completion signal at all (`:47`).
        assert_eq!(detect_task_completion("nichts davon", &tasks), None);
        assert_eq!(detect_task_completion("hab ich gemacht", &tasks), None);

        // Exact title, so 0.9 (`:52-56`).
        let exact = detect_task_completion("Zahnarzt Termin ist erledigt", &tasks)
            .expect("an exact title match");
        assert_eq!(exact.task.id, "2");
        assert_eq!(exact.match_confidence, 0.9);

        // The keyword pass, so 0.7 (`:59-80`). Node 24 picks the first task of
        // the input order that clears the threshold.
        for (text, expected_id) in [
            ("Buch gelesen, fertig", "3"),
            ("Der Termin beim Zahnarzt ist geschafft", "2"),
            ("termin erledigt", "2"),
        ] {
            let fuzzy = detect_task_completion(text, &tasks).expect("a fuzzy match");
            assert_eq!(fuzzy.task.id, expected_id, "{text}");
            assert_eq!(fuzzy.match_confidence, 0.7, "{text}");
        }

        // `Nata anrufen` has no keyword above three characters in the message.
        assert_eq!(detect_task_completion("Ich hab das erledigt", &tasks), None);
    }

    /// `matchConfidence` stays a `number` (`:54`, `:78`), and the keyword
    /// filter of `:60` drops titles whose every word is three characters or
    /// shorter — but only *after* the exact pass has failed.
    #[test]
    fn short_title_words_are_dropped_by_the_keyword_filter() {
        let tasks = vec![task("1", "Buch")];
        // The exact pass already matches `buch`, so 0.9 (`:52-56`).
        let matched = detect_task_completion("buch erledigt", &tasks).expect("an exact match");
        assert_eq!(matched.match_confidence, 0.9);

        // `Tee` is filtered out, so the keyword pass has nothing to compare
        // and the source returns null (Node 24).
        let tasks = vec![task("1", "Tee")];
        assert_eq!(detect_task_completion("hab das erledigt", &tasks), None);

        let tasks = vec![task("1", "Buecher lesen")];
        let matched =
            detect_task_completion("buecher lesen erledigt", &tasks).expect("an exact title match");
        assert_eq!(matched.match_confidence, 0.9);
    }

    #[test]
    fn completion_signals_use_the_javascript_boundary() {
        for text in [
            "erledigt",
            "Das ist gemocht gemacht",
            "fertig!",
            "abgehakt",
            "war beim Zahnarzt",
            "hab ich",
            "done",
            "geschafft",
            "abgeschlossen",
        ] {
            assert!(completion_signals().is_match(text), "{text}");
        }
        // `\b` is ASCII, so an umlaut directly before the signal keeps the word.
        assert!(completion_signals().is_match("üerledigt"));
        assert!(!completion_signals().is_match("unerledigt"));
        assert!(!completion_signals().is_match("geschafftsein"));
    }

    #[test]
    fn the_type_spellings_are_the_typescript_ones() {
        assert_eq!(TaskStatus::Open.as_str(), "open");
        assert_eq!(TaskStatus::InProgress.as_str(), "in_progress");
        assert_eq!(TaskStatus::Done.as_str(), "done");
        assert_eq!(TaskStatus::Overdue.as_str(), "overdue");
        assert_eq!(TaskStatus::Cancelled.as_str(), "cancelled");
        assert_eq!(TaskType::OneTime.as_str(), "one_time");
        assert_eq!(TaskType::Recurring.as_str(), "recurring");
        assert_eq!(TaskType::Deadline.as_str(), "deadline");
        assert_eq!(TaskType::Preference.as_str(), "preference");
    }
}
