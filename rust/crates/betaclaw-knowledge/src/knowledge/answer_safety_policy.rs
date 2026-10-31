//! Port of `src/server/knowledge/answerSafetyPolicy.ts` (1-62).
//!
//! | TypeScript                                     | Rust |
//! | ---------------------------------------------- | ---- |
//! | `answerSafetyPolicy.ts:7-12` (`EvidenceAssessment`) | [`EvidenceAssessment`] |
//! | `answerSafetyPolicy.ts:14` (`AnswerSafetyLevel`)    | [`AnswerSafetyLevel`] |
//! | `answerSafetyPolicy.ts:19-34` (`assessAnswerSafety`) | [`assess_answer_safety`] |
//! | `answerSafetyPolicy.ts:40-62` (`buildSafetyInstruction`) | [`build_safety_instruction`] |
//!
//! Dependency of `formatters/budgetCalculator.ts:6-7`; it lives at the
//! knowledge root because that is where its TypeScript original lives.
//!
//! The three instruction strings are copied verbatim, including the `ue`/`ae`
//! transliterations and the literal quotation marks, because they are injected
//! into the model prompt and their wording is the contract.

/// `EvidenceAssessment` from `answerSafetyPolicy.ts:7-12`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EvidenceAssessment {
    pub total_sources: f64,
    pub avg_confidence: f64,
    pub has_computed_answer: bool,
    pub has_contradiction: bool,
}

/// `AnswerSafetyLevel` from `answerSafetyPolicy.ts:14`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnswerSafetyLevel {
    Confident,
    Hedged,
    Caveat,
    Decline,
}

/// `assessAnswerSafety` from `answerSafetyPolicy.ts:19-34`.
///
/// The three `avgConfidence` thresholds are `>=`, in the source's order:
/// computed answer, strong evidence, moderate evidence, weak evidence, none.
pub fn assess_answer_safety(evidence: &EvidenceAssessment) -> AnswerSafetyLevel {
    // Computed answer without contradiction → full confidence
    if evidence.has_computed_answer && !evidence.has_contradiction {
        return AnswerSafetyLevel::Confident;
    }

    // Strong evidence
    if evidence.total_sources >= 3.0 && evidence.avg_confidence >= 0.7 {
        return AnswerSafetyLevel::Confident;
    }

    // Moderate evidence → hedge
    if evidence.total_sources >= 1.0 && evidence.avg_confidence >= 0.5 {
        return AnswerSafetyLevel::Hedged;
    }

    // Weak evidence → caveat
    if evidence.total_sources >= 1.0 {
        return AnswerSafetyLevel::Caveat;
    }

    // No evidence → decline
    AnswerSafetyLevel::Decline
}

/// `buildSafetyInstruction` from `answerSafetyPolicy.ts:40-62`.
///
/// `confident` yields [`None`] ("Returns null when no restriction is needed").
pub fn build_safety_instruction(level: AnswerSafetyLevel) -> Option<String> {
    match level {
        AnswerSafetyLevel::Confident => None,
        AnswerSafetyLevel::Hedged => Some(
            r#"ERINNERUNGSHINWEIS: Die verfuegbare Evidenz ist moderat. Antworte natuerlich, aber verwende Formulierungen wie "Soweit ich mich erinnere..." oder "Ich glaube..." statt absolute Behauptungen."#
                .to_string(),
        ),
        AnswerSafetyLevel::Caveat => Some(
            r#"ERINNERUNGSHINWEIS: Die verfuegbare Evidenz ist schwach. Sage klar, dass du dir nicht sicher bist. Verwende "Ich bin mir nicht ganz sicher, aber..." und biete an, dass der User dich korrigieren kann."#
                .to_string(),
        ),
        AnswerSafetyLevel::Decline => Some(
            r#"ERINNERUNGSHINWEIS: Zu dieser Frage gibt es keine zuverlaessige Erinnerung. Sage ehrlich, dass du dazu nichts in deiner Erinnerung findest. BEHAUPTE NICHTS ohne Evidenz."#
                .to_string(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assessment(
        total_sources: f64,
        avg_confidence: f64,
        has_computed_answer: bool,
    ) -> EvidenceAssessment {
        EvidenceAssessment {
            total_sources,
            avg_confidence,
            has_computed_answer,
            has_contradiction: false,
        }
    }

    #[test]
    fn the_safety_levels_follow_the_source_order() {
        assert_eq!(
            assess_answer_safety(&assessment(0.0, 0.0, true)),
            AnswerSafetyLevel::Confident
        );
        assert_eq!(
            assess_answer_safety(&assessment(3.0, 0.7, false)),
            AnswerSafetyLevel::Confident
        );
        assert_eq!(
            assess_answer_safety(&assessment(1.0, 0.5, false)),
            AnswerSafetyLevel::Hedged
        );
        assert_eq!(
            assess_answer_safety(&assessment(1.0, 0.4, false)),
            AnswerSafetyLevel::Caveat
        );
        assert_eq!(
            assess_answer_safety(&assessment(0.0, 0.0, false)),
            AnswerSafetyLevel::Decline
        );
    }

    #[test]
    fn a_contradiction_takes_the_computed_answer_confidence_away() {
        let mut evidence = assessment(0.0, 0.0, true);
        evidence.has_contradiction = true;
        assert_eq!(assess_answer_safety(&evidence), AnswerSafetyLevel::Decline);
    }

    #[test]
    fn only_the_confident_level_needs_no_instruction() {
        assert!(build_safety_instruction(AnswerSafetyLevel::Confident).is_none());
        let hedged = build_safety_instruction(AnswerSafetyLevel::Hedged).expect("hedged");
        assert!(hedged.starts_with("ERINNERUNGSHINWEIS: Die verfuegbare Evidenz ist moderat."));
        assert!(hedged.contains(r#""Soweit ich mich erinnere...""#));
        let caveat = build_safety_instruction(AnswerSafetyLevel::Caveat).expect("caveat");
        assert!(caveat.contains(r#""Ich bin mir nicht ganz sicher, aber...""#));
        let decline = build_safety_instruction(AnswerSafetyLevel::Decline).expect("decline");
        assert!(decline.ends_with("BEHAUPTE NICHTS ohne Evidenz."));
    }
}
