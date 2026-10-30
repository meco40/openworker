//! Port of `src/server/tasks/dispatch/failure.ts` and of the retry decision of
//! `src/server/tasks/dispatch/executeDispatch.ts:15-53`.
//!
//! The loop itself calls `chat.send` and stays in S8. The classification and the
//! decision after each attempt are pure and live here.

use serde_json::{json, Map, Value};

use super::DispatchHttpResponse;
use crate::tasks::{js_string, js_trim};

pub const MAX_DISPATCH_ATTEMPTS: u32 = 3;

/// The fields of `DispatchChatSendResult` that the classification reads.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SendResult {
    pub agent_content: Option<String>,
    pub agent_metadata: Option<Map<String, Value>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DispatchFailure {
    pub message: String,
    pub retryable: bool,
    pub details: Map<String, Value>,
}

/// `classifyDispatchFailure`. `None` means that the send counts as a success.
pub fn classify_dispatch_failure(result: Option<&SendResult>) -> Option<DispatchFailure> {
    let empty = Map::new();
    let metadata = result
        .and_then(|result| result.agent_metadata.as_ref())
        .unwrap_or(&empty);
    let execution_status = js_string(metadata.get("status")).trim().to_lowercase();
    let content = js_trim(
        result
            .and_then(|r| r.agent_content.as_deref())
            .unwrap_or_default(),
    )
    .to_string();
    let content_lower = content.to_lowercase();

    if execution_status == "tool_execution_required_unmet" {
        return Some(DispatchFailure {
            message: "Agent dispatch failed: no real execution was performed. Please retry dispatch after adjusting task instructions."
                .to_string(),
            retryable: false,
            details: metadata.clone(),
        });
    }

    if content_lower.starts_with("ai dispatch failed:") {
        let retryable = ["aborted", "all models failed", "timeout", "temporarily"]
            .iter()
            .any(|word| content_lower.contains(word));
        return Some(DispatchFailure {
            message: format!("Agent dispatch failed: {content}"),
            retryable,
            details: metadata.clone(),
        });
    }

    if content_lower.starts_with("execution failed:") {
        return Some(DispatchFailure {
            message: content,
            retryable: false,
            details: metadata.clone(),
        });
    }

    if metadata.get("ok") == Some(&Value::Bool(false)) {
        let status_text = if execution_status.is_empty() {
            "unknown_error".to_string()
        } else {
            execution_status
        };
        let retryable = ["aborted", "timeout", "temporary", "rate_limit"]
            .iter()
            .any(|word| status_text.contains(word));
        return Some(DispatchFailure {
            message: format!("Agent dispatch failed ({status_text})."),
            retryable,
            details: metadata.clone(),
        });
    }

    None
}

/// What `executeDispatch` does after a failed attempt.
#[derive(Debug, Clone, PartialEq)]
pub enum AttemptDecision {
    Retry,
    GiveUp(DispatchHttpResponse),
}

/// A retryable failure is retried until the last attempt. Any other failure gives
/// up at once with HTTP 502 and the failure's details.
pub fn decide_after_failure(attempt: u32, failure: &DispatchFailure) -> AttemptDecision {
    if failure.retryable && attempt < MAX_DISPATCH_ATTEMPTS {
        return AttemptDecision::Retry;
    }
    AttemptDecision::GiveUp(DispatchHttpResponse {
        status: 502,
        body: json!({
            "error": failure.message,
            "details": Value::Object(failure.details.clone()),
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(content: Option<&str>, metadata: Value) -> SendResult {
        SendResult {
            agent_content: content.map(str::to_string),
            agent_metadata: metadata.as_object().cloned(),
        }
    }

    #[test]
    fn a_plain_reply_is_not_a_failure() {
        let reply = result(Some("Working on it"), json!({"ok": true}));
        assert_eq!(classify_dispatch_failure(Some(&reply)), None);
        assert_eq!(classify_dispatch_failure(None), None);
    }

    #[test]
    fn unmet_tool_execution_is_permanent() {
        let send = result(None, json!({"status": "Tool_Execution_Required_Unmet"}));
        let failure = classify_dispatch_failure(Some(&send)).unwrap();
        assert!(!failure.retryable);
        assert!(failure
            .message
            .starts_with("Agent dispatch failed: no real execution"));
    }

    #[test]
    fn ai_dispatch_failures_retry_only_for_transient_causes() {
        let timeout = result(Some("  AI dispatch failed: upstream timeout  "), json!({}));
        let failure = classify_dispatch_failure(Some(&timeout)).unwrap();
        assert!(failure.retryable);
        assert_eq!(
            failure.message,
            "Agent dispatch failed: AI dispatch failed: upstream timeout"
        );

        let invalid = result(Some("AI dispatch failed: bad key"), json!({}));
        assert!(!classify_dispatch_failure(Some(&invalid)).unwrap().retryable);
    }

    #[test]
    fn execution_failed_keeps_the_content_as_message() {
        let send = result(Some("Execution failed: disk full"), json!({}));
        let failure = classify_dispatch_failure(Some(&send)).unwrap();
        assert_eq!(failure.message, "Execution failed: disk full");
        assert!(!failure.retryable);
    }

    #[test]
    fn ok_false_uses_the_status_or_unknown_error() {
        let rate_limited = result(None, json!({"ok": false, "status": "rate_limit_hit"}));
        let failure = classify_dispatch_failure(Some(&rate_limited)).unwrap();
        assert!(failure.retryable);
        assert_eq!(failure.message, "Agent dispatch failed (rate_limit_hit).");

        let unknown = result(None, json!({"ok": false}));
        let failure = classify_dispatch_failure(Some(&unknown)).unwrap();
        assert!(!failure.retryable);
        assert_eq!(failure.message, "Agent dispatch failed (unknown_error).");
    }

    #[test]
    fn give_up_body_carries_the_message_and_the_details() {
        let plain_failure = DispatchFailure {
            message: "m".to_string(),
            retryable: false,
            details: Map::new(),
        };
        match decide_after_failure(1, &plain_failure) {
            AttemptDecision::GiveUp(response) => {
                assert_eq!(response.status, 502);
                assert_eq!(response.body, json!({"error": "m", "details": {}}));
            }
            AttemptDecision::Retry => panic!("a permanent failure must not retry"),
        }
    }

    #[test]
    fn retryable_failures_retry_until_the_last_attempt() {
        let transient = DispatchFailure {
            message: "m".to_string(),
            retryable: true,
            details: Map::new(),
        };
        assert_eq!(decide_after_failure(1, &transient), AttemptDecision::Retry);
        assert_eq!(decide_after_failure(2, &transient), AttemptDecision::Retry);
        assert!(matches!(
            decide_after_failure(MAX_DISPATCH_ATTEMPTS, &transient),
            AttemptDecision::GiveUp(_)
        ));
    }
}
