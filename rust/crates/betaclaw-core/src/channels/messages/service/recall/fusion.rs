//! Port of `src/server/channels/messages/recallFusion.ts`.
//!
//! The file sits outside `recall/`, but only the recall service calls it. It is
//! ported here so that recall works without touching the parent directory.
//! Move it to `channels/messages/recall_fusion.rs` when that directory is in
//! scope.
//!
//! Budgets are in UTF-16 units, as in JavaScript `string.length`.
//! `formatDateDE` uses the local time zone, and so does this port.

use crate::messages_store::StoredMessage;

use super::utils::{utf16_len, utf16_prefix};

/// `RECALL_FUSION_TOTAL_BUDGET`.
pub const RECALL_FUSION_TOTAL_BUDGET: usize = 5000;

const WORLD_MODEL_BUDGET: usize = 1800;
const KNOWLEDGE_BUDGET: usize = 1800;
const MEMORY_BUDGET: usize = 1200;
const CHAT_BUDGET: usize = 2000;
const CHAT_LINE_BUDGET: usize = 400;

/// `RecallSources` (`recallFusion.ts:20-33`). Each field is one source's text.
#[derive(Debug, Clone, Copy, Default)]
pub struct RecallSourcesInput<'a> {
    pub world_model: Option<&'a str>,
    pub knowledge: Option<&'a str>,
    pub memory: Option<&'a str>,
    pub chat_hits: &'a [StoredMessage],
    pub computed_answer: Option<&'a str>,
}

/// `fuseRecallSources`. Returns `None` when no source has content.
pub fn fuse_recall_sources(sources: &RecallSourcesInput<'_>) -> Option<String> {
    let mut sections: Vec<String> = Vec::new();

    if let Some(text) = non_empty_trimmed(sources.computed_answer) {
        sections.push(format!("[Computed Answer]\n{text}"));
    }
    if let Some(text) = non_empty_trimmed(sources.world_model) {
        sections.push(format!(
            "[World Model]\n{}",
            truncate(text, WORLD_MODEL_BUDGET)
        ));
    }
    if !sources.chat_hits.is_empty() {
        let chat_block = sources
            .chat_hits
            .iter()
            .map(|message| {
                format!(
                    "- \"{}\" \u{2014} {}",
                    truncate(&message.content, CHAT_LINE_BUDGET),
                    format_date_de(&message.created_at)
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        sections.push(format!(
            "[Chat History]\n{}",
            truncate(&chat_block, CHAT_BUDGET)
        ));
    }
    if let Some(text) = non_empty_trimmed(sources.knowledge) {
        sections.push(format!("[Knowledge]\n{}", truncate(text, KNOWLEDGE_BUDGET)));
    }
    if let Some(text) = non_empty_trimmed(sources.memory) {
        sections.push(format!("[Memory]\n{}", truncate(text, MEMORY_BUDGET)));
    }

    if sections.is_empty() {
        return None;
    }
    Some(truncate(&sections.join("\n\n"), RECALL_FUSION_TOTAL_BUDGET))
}

fn non_empty_trimmed(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|text| !text.is_empty())
}

/// `truncate(text, maxLength)`: keeps `maxLength - 1` units and appends `…`.
fn truncate(text: &str, max_length: usize) -> String {
    if utf16_len(text) <= max_length {
        return text.to_string();
    }
    format!("{}\u{2026}", utf16_prefix(text, max_length - 1))
}

/// `formatDateDE`: `dd.mm.yyyy` in local time. An unparsable value is returned
/// unchanged, as the TypeScript `NaN` branch does. Only RFC 3339 is parsed.
pub fn format_date_de(iso: &str) -> String {
    match chrono::DateTime::parse_from_rfc3339(iso) {
        Ok(parsed) => parsed
            .with_timezone(&chrono::Local)
            .format("%d.%m.%Y")
            .to_string(),
        Err(_) => iso.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;
    use crate::channels::messages::service::recall::testing::stored;

    #[test]
    fn nothing_to_fuse_yields_none() {
        let sources = RecallSourcesInput {
            world_model: Some("   "),
            knowledge: None,
            memory: Some(""),
            chat_hits: &[],
            computed_answer: None,
        };
        assert_eq!(fuse_recall_sources(&sources), None);
    }

    #[test]
    fn sections_keep_source_order_and_are_labelled() {
        let hits = [stored(
            "m1",
            "user",
            "Yoga um 9",
            "2026-10-05T10:00:00.000Z",
        )];
        let sources = RecallSourcesInput {
            world_model: Some("Wohnort: Berlin"),
            knowledge: Some("Meeting am Montag"),
            memory: Some("Mag kein Obst"),
            chat_hits: &hits,
            computed_answer: Some("3 Tage"),
        };
        let fused = fuse_recall_sources(&sources).expect("content");
        let order: Vec<usize> = [
            "[Computed Answer]",
            "[World Model]",
            "[Chat History]",
            "[Knowledge]",
            "[Memory]",
        ]
        .iter()
        .map(|label| fused.find(label).expect("label present"))
        .collect();
        assert!(order.windows(2).all(|pair| pair[0] < pair[1]));
        let line = format!(
            "- \"Yoga um 9\" \u{2014} {}",
            format_date_de("2026-10-05T10:00:00.000Z")
        );
        assert!(fused.contains(&line), "{fused}");
    }

    #[test]
    fn source_budget_truncates_with_ellipsis() {
        let long = "a".repeat(WORLD_MODEL_BUDGET + 50);
        let sources = RecallSourcesInput {
            world_model: Some(&long),
            ..Default::default()
        };
        let fused = fuse_recall_sources(&sources).expect("content");
        let body = fused.strip_prefix("[World Model]\n").expect("label");
        assert_eq!(utf16_len(body), WORLD_MODEL_BUDGET);
        assert!(body.ends_with('\u{2026}'));
    }

    #[test]
    fn date_is_german_local_day() {
        let local = chrono::Local
            .with_ymd_and_hms(2026, 3, 5, 12, 0, 0)
            .single()
            .expect("local noon exists")
            .to_rfc3339();
        assert_eq!(format_date_de(&local), "05.03.2026");
        assert_eq!(format_date_de("kein Datum"), "kein Datum");
    }
}
