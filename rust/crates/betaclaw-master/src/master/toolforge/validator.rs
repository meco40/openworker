//! Port of `src/server/master/toolforge/validator.ts:1-8`.
//!
//! The gate every toolforge pipeline run passes first: a spec must be non-empty
//! after trimming and must look JSON-ish (contain `{` and `}`).

/// `{ valid, reason? }` — the return of `validateToolForgeSpec`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolForgeSpecValidation {
    pub valid: bool,
    pub reason: Option<String>,
}

/// `validateToolForgeSpec` — `validator.ts:1-8`.
///
/// `String(spec || '').trim()`: the port takes `&str`, so the `|| ''` fallback
/// for `undefined` becomes the caller's empty string.
pub fn validate_tool_forge_spec(spec: &str) -> ToolForgeSpecValidation {
    let trimmed = spec.trim();
    if trimmed.is_empty() {
        return ToolForgeSpecValidation {
            valid: false,
            reason: Some("empty_spec".to_string()),
        };
    }
    if !trimmed.contains('{') || !trimmed.contains('}') {
        return ToolForgeSpecValidation {
            valid: false,
            reason: Some("spec_must_be_json_like".to_string()),
        };
    }
    ToolForgeSpecValidation {
        valid: true,
        reason: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_spec_is_rejected() {
        assert_eq!(
            validate_tool_forge_spec("   "),
            ToolForgeSpecValidation {
                valid: false,
                reason: Some("empty_spec".to_string())
            }
        );
    }

    #[test]
    fn a_spec_without_braces_is_rejected() {
        assert_eq!(
            validate_tool_forge_spec("just text"),
            ToolForgeSpecValidation {
                valid: false,
                reason: Some("spec_must_be_json_like".to_string())
            }
        );
        // Only one of the two braces is present.
        assert_eq!(
            validate_tool_forge_spec("{").reason.as_deref(),
            Some("spec_must_be_json_like")
        );
    }

    #[test]
    fn a_json_like_spec_passes() {
        assert_eq!(
            validate_tool_forge_spec("{\"name\":\"x\"}"),
            ToolForgeSpecValidation {
                valid: true,
                reason: None
            }
        );
    }
}
