//! Port of `src/server/world-model/services/clarificationService.ts:1-51`.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClarificationCandidate {
    pub id: String,
    pub label: String,
    pub summary: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClarificationPrompt {
    pub prompt: String,
    pub candidates: Vec<ClarificationCandidate>,
}

pub fn build_clarification_prompt(
    targets: &[ClarificationCandidate],
    subject_text: Option<&str>,
) -> Option<ClarificationPrompt> {
    if targets.len() < 2 {
        return None;
    }
    let prompt = if subject_text.is_some_and(|text| !text.is_empty()) {
        "Deine Antwort könnte sich auf mehrere Dinge beziehen. Meinst du:"
    } else {
        "Es gibt mehrere passende offene Punkte. Worauf beziehst du dich?"
    };
    Some(ClarificationPrompt {
        prompt: prompt.into(),
        candidates: targets.to_vec(),
    })
}

pub fn is_ambiguous(prompt: Option<&ClarificationPrompt>) -> bool {
    prompt.is_some()
}

pub fn resolve_clarification_choice(
    prompt: &ClarificationPrompt,
    selected_id: &str,
) -> Result<ClarificationCandidate, String> {
    prompt.candidates.iter().find(|candidate| candidate.id == selected_id).cloned().ok_or_else(|| {
        format!("[world-model] clarification choice '{selected_id}' is not among the offered candidates")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ambiguity_is_only_reported_for_multiple_candidates_and_choice_is_validated() {
        let candidates = vec![
            ClarificationCandidate {
                id: "1".into(),
                label: "A".into(),
                summary: None,
            },
            ClarificationCandidate {
                id: "2".into(),
                label: "B".into(),
                summary: Some("detail".into()),
            },
        ];
        let prompt = build_clarification_prompt(&candidates, Some("reply")).expect("ambiguous");
        assert_eq!(
            prompt.prompt,
            "Deine Antwort könnte sich auf mehrere Dinge beziehen. Meinst du:"
        );
        assert_eq!(
            resolve_clarification_choice(&prompt, "2").unwrap().label,
            "B"
        );
        assert_eq!(
            resolve_clarification_choice(&prompt, "3").unwrap_err(),
            "[world-model] clarification choice '3' is not among the offered candidates"
        );
        assert!(build_clarification_prompt(&candidates[..1], None).is_none());
    }
}
