//! Port of `src/server/channels/messages/service/recall/evidence/format.ts`.
//!
//! The German sentences are copied from the source byte for byte. Tests compare
//! them exactly.

use super::super::types::StrictRecallCandidate;

/// `confidence` of an evidence reply.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvidenceConfidence {
    High,
    Medium,
    Low,
}

impl EvidenceConfidence {
    pub fn as_str(self) -> &'static str {
        match self {
            EvidenceConfidence::High => "high",
            EvidenceConfidence::Medium => "medium",
            EvidenceConfidence::Low => "low",
        }
    }
}

const NOTHING_FOUND: &str =
    "Ich finde keine belastbare Erinnerung dazu, welche Übung du heute nochmal machen willst.";

/// `formatEvidenceLines`: `1. [source/role] text (createdAt)`.
pub fn format_evidence_lines(candidates: &[StrictRecallCandidate]) -> Vec<String> {
    candidates
        .iter()
        .enumerate()
        .map(|(index, candidate)| format_line(index, candidate))
        .collect()
}

fn format_line(index: usize, candidate: &StrictRecallCandidate) -> String {
    let created = match candidate
        .created_at
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        Some(value) => format!(" ({value})"),
        None => String::new(),
    };
    format!(
        "{}. [{}/{}] {}{}",
        index + 1,
        candidate.source.as_str(),
        candidate.role,
        candidate.text,
        created
    )
}

/// `buildLowConfidenceResponse`: up to three context lines, quoted.
pub fn build_low_confidence_response(
    sorted_context: &[StrictRecallCandidate],
) -> (String, EvidenceConfidence) {
    let context_lines: Vec<String> = sorted_context
        .iter()
        .take(3)
        .map(|candidate| format!("- \"{}\"", candidate.text))
        .collect();
    let content = if context_lines.is_empty() {
        NOTHING_FOUND.to_string()
    } else {
        [
            NOTHING_FOUND.to_string(),
            String::new(),
            "Ich finde nur diese Aussagen zum Zeitkontext:".to_string(),
        ]
        .into_iter()
        .chain(context_lines)
        .collect::<Vec<_>>()
        .join("\n")
    };
    (content, EvidenceConfidence::Low)
}

/// `buildHighConfidenceResponse`. With a conflict the reply lists up to three
/// candidates and is `medium`. Otherwise it names the winner and is `high`.
pub fn build_high_confidence_response(
    winner: &StrictRecallCandidate,
    sorted_relevant: &[StrictRecallCandidate],
    has_conflict: bool,
) -> (String, EvidenceConfidence) {
    let evidence_count = if has_conflict { 3 } else { 2 };
    let evidence_lines =
        format_evidence_lines(&sorted_relevant[..sorted_relevant.len().min(evidence_count)]);

    let answer = if has_conflict {
        let options = sorted_relevant
            .iter()
            .take(3)
            .map(|candidate| format!("\"{}\"", candidate.text))
            .collect::<Vec<_>>()
            .join(" | ");
        format!(
            "Ich finde mehrere gleich plausible Erinnerungen und kann keine eindeutig priorisieren.\nMögliche Aussagen: {options}"
        )
    } else {
        format!(
            "Nach den belegbaren Erinnerungen willst du heute nochmal: \"{}\"",
            winner.text
        )
    };

    let content = [answer, String::new(), "Belege:".to_string()]
        .into_iter()
        .chain(evidence_lines)
        .collect::<Vec<_>>()
        .join("\n");
    let confidence = if has_conflict {
        EvidenceConfidence::Medium
    } else {
        EvidenceConfidence::High
    };
    (content, confidence)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channels::messages::service::recall::testing::candidate;
    use crate::channels::messages::service::recall::types::CandidateSource;

    #[test]
    fn low_confidence_without_context_is_the_plain_sentence() {
        let (content, confidence) = build_low_confidence_response(&[]);
        assert_eq!(content, NOTHING_FOUND);
        assert_eq!(confidence, EvidenceConfidence::Low);
    }

    #[test]
    fn low_confidence_lists_at_most_three_context_lines() {
        let context: Vec<_> = ["a", "b", "c", "d"]
            .iter()
            .map(|text| candidate(text, None))
            .collect();
        let (content, _) = build_low_confidence_response(&context);
        assert_eq!(
            content,
            format!(
                "{NOTHING_FOUND}\n\nIch finde nur diese Aussagen zum Zeitkontext:\n- \"a\"\n- \"b\"\n- \"c\""
            )
        );
    }

    #[test]
    fn high_confidence_names_the_winner_and_cites_two_sources() {
        let mut winner = candidate("Yoga am Dienstag", Some("2026-10-05T10:00:00.000Z"));
        winner.source = CandidateSource::Memory;
        winner.role = "memory".to_string();
        let runner = candidate("Schwimmen", None);
        let (content, confidence) =
            build_high_confidence_response(&winner, &[winner.clone(), runner], false);
        assert_eq!(confidence, EvidenceConfidence::High);
        assert!(content.starts_with(
            "Nach den belegbaren Erinnerungen willst du heute nochmal: \"Yoga am Dienstag\"\n\nBelege:\n"
        ));
        assert!(content.contains("1. [memory/memory] Yoga am Dienstag (2026-10-05T10:00:00.000Z)"));
        assert!(content.ends_with("2. [chat/user] Schwimmen"));
    }

    #[test]
    fn conflict_reports_medium_with_options() {
        let first = candidate("A", None);
        let second = candidate("B", None);
        let (content, confidence) =
            build_high_confidence_response(&first, &[first.clone(), second], true);
        assert_eq!(confidence, EvidenceConfidence::Medium);
        assert!(content.contains("Mögliche Aussagen: \"A\" | \"B\""));
    }
}
