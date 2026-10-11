//! Port of `src/server/world-model/services/correctionResolver.ts:1-46`.

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CorrectionAction {
    None,
    CancelOld,
    Replace,
    Ambiguous,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CorrectionResolution {
    pub action: CorrectionAction,
    pub replaced_event_id: Option<String>,
    pub reason: Option<String>,
}

pub fn resolve_correction(
    old_status: &str,
    old_event_id: &str,
    new_event_proposed: bool,
    kind: &str,
) -> CorrectionResolution {
    if kind == "cancellation" {
        return CorrectionResolution {
            action: CorrectionAction::CancelOld,
            replaced_event_id: Some(old_event_id.into()),
            reason: Some("user cancelled".into()),
        };
    }
    if kind == "change" && new_event_proposed && old_status == "planned" {
        return CorrectionResolution {
            action: CorrectionAction::Replace,
            replaced_event_id: Some(old_event_id.into()),
            reason: Some("replaced by a new plan".into()),
        };
    }
    CorrectionResolution {
        action: CorrectionAction::None,
        replaced_event_id: None,
        reason: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_replacement_links_only_a_planned_event() {
        assert_eq!(
            resolve_correction("planned", "e1", true, "change").action,
            CorrectionAction::Replace
        );
        assert_eq!(
            resolve_correction("completed", "e1", true, "change").action,
            CorrectionAction::None
        );
        assert_eq!(
            resolve_correction("cancelled", "e1", false, "cancellation")
                .reason
                .as_deref(),
            Some("user cancelled")
        );
    }
}
