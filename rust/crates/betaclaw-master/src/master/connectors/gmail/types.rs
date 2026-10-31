//! Port of `src/server/master/connectors/gmail/types.ts:1-16`.
//!
//! The two domain shapes the Gmail client works with. The optional fields stay
//! `Option` so an absent value is omitted on serialization, matching the
//! `undefined` of the source literals.

use serde::{Deserialize, Serialize};

/// `GmailMessage` from `types.ts:1-11`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GmailMessage {
    pub id: String,
    pub from: String,
    pub to: String,
    pub subject: String,
    pub body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warnings: Option<Vec<String>>,
    pub created_at: String,
}

/// `GmailDraftInput` from `types.ts:13-16`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GmailDraftInput {
    pub to: String,
    pub subject: String,
    pub body: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_optionals_are_omitted_like_undefined() {
        let message = GmailMessage {
            id: "1".to_string(),
            from: "a".to_string(),
            to: "b".to_string(),
            subject: "s".to_string(),
            body: "x".to_string(),
            body_text: None,
            snippet: None,
            warnings: None,
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
        };
        let json = serde_json::to_string(&message).unwrap();
        assert!(!json.contains("bodyText"));
        assert!(!json.contains("snippet"));
        assert!(!json.contains("warnings"));
        assert!(json.contains("\"createdAt\":\"2026-01-01T00:00:00.000Z\""));
    }

    #[test]
    fn a_present_warning_serializes() {
        let message = GmailMessage {
            id: "1".to_string(),
            from: "a".to_string(),
            to: "b".to_string(),
            subject: "s".to_string(),
            body: "x".to_string(),
            body_text: Some("x".to_string()),
            snippet: Some("".to_string()),
            warnings: Some(vec!["w".to_string()]),
            created_at: "t".to_string(),
        };
        let json = serde_json::to_string(&message).unwrap();
        assert!(json.contains("\"warnings\":[\"w\"]"));
    }

    #[test]
    fn draft_input_uses_camel_case_keys() {
        let draft = GmailDraftInput {
            to: "a".to_string(),
            subject: "s".to_string(),
            body: "b".to_string(),
        };
        assert_eq!(
            serde_json::to_string(&draft).unwrap(),
            "{\"to\":\"a\",\"subject\":\"s\",\"body\":\"b\"}"
        );
    }
}
