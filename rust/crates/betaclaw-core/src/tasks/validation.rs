//! Port of `CreateTaskSchema` and `UpdateTaskSchema` (`src/lib/validation.ts:23-43`)
//! and of the enums they use (`src/lib/validation.ts:4-11`).
//!
//! The route layer decodes the request body, so field types are not checked
//! here. This module checks what the Zod schemas add on top of the types: the
//! enum members, the string lengths and the UUID format. Lengths count UTF-16
//! code units, as `String.length` does. Custom messages are copied from the
//! schemas. The default Zod 4 messages (`Too small`, `Too big`, `Invalid option`,
//! `Invalid UUID`) follow `node_modules/zod/v4/locales/en.js` and the UUID rule
//! follows `node_modules/zod/v4/core/regexes.js`.

use super::types::{TaskPriority, TaskStatus};

/// `CreateTaskSchema` after decoding. `None` is an absent key. `Some(None)` is `null`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CreateTaskInput {
    pub title: String,
    pub description: Option<String>,
    pub status: Option<String>,
    pub priority: Option<String>,
    pub assigned_agent_id: Option<Option<String>>,
    pub created_by_agent_id: Option<Option<String>>,
    pub business_id: Option<String>,
    pub workspace_id: Option<String>,
    pub due_date: Option<Option<String>>,
}

/// `UpdateTaskSchema` after decoding. The `Option<Option<_>>` fields keep the
/// difference between an absent key and `null`, which `updateTask` relies on.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UpdateTaskInput {
    pub title: Option<String>,
    pub description: Option<String>,
    pub status: Option<String>,
    pub priority: Option<String>,
    pub assigned_agent_id: Option<Option<String>>,
    pub due_date: Option<Option<String>>,
    pub updated_by_agent_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationIssue {
    pub field: &'static str,
    pub message: String,
}

pub fn validate_create_task(input: &CreateTaskInput) -> Result<(), Vec<ValidationIssue>> {
    let mut issues = Vec::new();
    match utf16_len(&input.title) {
        0 => issues.push(issue("title", "Title is required")),
        length if length > 500 => {
            issues.push(issue("title", "Title must be 500 characters or less"))
        }
        _ => {}
    }
    if let Some(description) = &input.description {
        if utf16_len(description) > 10_000 {
            issues.push(issue(
                "description",
                "Description must be 10000 characters or less",
            ));
        }
    }
    check_status(&mut issues, "status", input.status.as_deref());
    check_priority(&mut issues, "priority", input.priority.as_deref());
    check_nullable_uuid(
        &mut issues,
        "assigned_agent_id",
        input.assigned_agent_id.as_ref(),
    );
    check_nullable_uuid(
        &mut issues,
        "created_by_agent_id",
        input.created_by_agent_id.as_ref(),
    );
    finish(issues)
}

pub fn validate_update_task(input: &UpdateTaskInput) -> Result<(), Vec<ValidationIssue>> {
    let mut issues = Vec::new();
    if let Some(title) = &input.title {
        match utf16_len(title) {
            0 => issues.push(issue(
                "title",
                "Too small: expected string to have >=1 characters",
            )),
            length if length > 500 => issues.push(issue(
                "title",
                "Too big: expected string to have <=500 characters",
            )),
            _ => {}
        }
    }
    if let Some(description) = &input.description {
        if utf16_len(description) > 10_000 {
            issues.push(issue(
                "description",
                "Too big: expected string to have <=10000 characters",
            ));
        }
    }
    check_status(&mut issues, "status", input.status.as_deref());
    check_priority(&mut issues, "priority", input.priority.as_deref());
    check_nullable_uuid(
        &mut issues,
        "assigned_agent_id",
        input.assigned_agent_id.as_ref(),
    );
    if let Some(updated_by) = &input.updated_by_agent_id {
        if !is_uuid(updated_by) {
            issues.push(issue("updated_by_agent_id", "Invalid UUID"));
        }
    }
    finish(issues)
}

/// The RFC 9562 UUID rule of Zod 4 (`uuid()` in `core/regexes.js`), with the nil
/// and max UUIDs accepted explicitly.
pub fn is_uuid(value: &str) -> bool {
    if value == "00000000-0000-0000-0000-000000000000"
        || value == "ffffffff-ffff-ffff-ffff-ffffffffffff"
    {
        return true;
    }
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    bytes.iter().enumerate().all(|(index, byte)| match index {
        8 | 13 | 18 | 23 => *byte == b'-',
        14 => matches!(byte, b'1'..=b'8'),
        19 => matches!(byte, b'8' | b'9' | b'a' | b'b' | b'A' | b'B'),
        _ => byte.is_ascii_hexdigit(),
    })
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn issue(field: &'static str, message: &str) -> ValidationIssue {
    ValidationIssue {
        field,
        message: message.to_string(),
    }
}

fn finish(issues: Vec<ValidationIssue>) -> Result<(), Vec<ValidationIssue>> {
    if issues.is_empty() {
        Ok(())
    } else {
        Err(issues)
    }
}

fn check_status(issues: &mut Vec<ValidationIssue>, field: &'static str, value: Option<&str>) {
    if let Some(value) = value {
        if TaskStatus::parse(value).is_none() {
            let members = TaskStatus::ALL.map(|status| format!("\"{}\"", status.as_str()));
            issues.push(issue(
                field,
                &format!("Invalid option: expected one of {}", members.join("|")),
            ));
        }
    }
}

fn check_priority(issues: &mut Vec<ValidationIssue>, field: &'static str, value: Option<&str>) {
    if let Some(value) = value {
        if TaskPriority::parse(value).is_none() {
            let members = TaskPriority::ALL.map(|priority| format!("\"{}\"", priority.as_str()));
            issues.push(issue(
                field,
                &format!("Invalid option: expected one of {}", members.join("|")),
            ));
        }
    }
}

fn check_nullable_uuid(
    issues: &mut Vec<ValidationIssue>,
    field: &'static str,
    value: Option<&Option<String>>,
) {
    if let Some(Some(id)) = value {
        if !is_uuid(id) {
            issues.push(issue(field, "Invalid UUID"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_create() -> CreateTaskInput {
        CreateTaskInput {
            title: "Build the page".to_string(),
            ..CreateTaskInput::default()
        }
    }

    #[test]
    fn create_requires_a_title_and_caps_its_length() {
        let mut input = valid_create();
        input.title.clear();
        let issues = validate_create_task(&input).unwrap_err();
        assert_eq!(issues[0].message, "Title is required");

        input.title = "x".repeat(501);
        let issues = validate_create_task(&input).unwrap_err();
        assert_eq!(issues[0].message, "Title must be 500 characters or less");

        input.title = "x".repeat(500);
        assert!(validate_create_task(&input).is_ok());
    }

    #[test]
    fn length_counts_utf16_code_units_like_javascript() {
        // Each emoji is two UTF-16 code units, so 251 emojis are 502 units.
        let mut input = valid_create();
        input.title = "🙂".repeat(251);
        assert!(validate_create_task(&input).is_err());
        input.title = "🙂".repeat(250);
        assert!(validate_create_task(&input).is_ok());
    }

    #[test]
    fn enums_reject_unknown_members_with_the_zod_message() {
        let mut input = valid_create();
        input.status = Some("archived".to_string());
        let issues = validate_create_task(&input).unwrap_err();
        assert_eq!(issues[0].field, "status");
        assert_eq!(
            issues[0].message,
            "Invalid option: expected one of \"pending_dispatch\"|\"planning\"|\"inbox\"|\"assigned\"|\"in_progress\"|\"testing\"|\"review\"|\"done\""
        );

        let mut input = valid_create();
        input.priority = Some("normal".to_string());
        assert!(validate_create_task(&input).is_ok());
        input.priority = Some("critical".to_string());
        assert!(validate_create_task(&input).is_err());
    }

    #[test]
    fn agent_ids_must_be_uuids_but_null_is_allowed() {
        let mut input = valid_create();
        input.assigned_agent_id = Some(None);
        assert!(validate_create_task(&input).is_ok());
        input.assigned_agent_id = Some(Some("not-a-uuid".to_string()));
        let issues = validate_create_task(&input).unwrap_err();
        assert_eq!(issues[0].message, "Invalid UUID");
    }

    #[test]
    fn update_uses_the_default_zod_length_messages() {
        let mut input = UpdateTaskInput {
            title: Some(String::new()),
            ..UpdateTaskInput::default()
        };
        let issues = validate_update_task(&input).unwrap_err();
        assert_eq!(
            issues[0].message,
            "Too small: expected string to have >=1 characters"
        );

        input.title = None;
        input.description = Some("d".repeat(10_001));
        let issues = validate_update_task(&input).unwrap_err();
        assert_eq!(
            issues[0].message,
            "Too big: expected string to have <=10000 characters"
        );
    }

    #[test]
    fn uuid_rule_matches_zod_four() {
        assert!(is_uuid("123e4567-e89b-12d3-a456-426614174000"));
        assert!(is_uuid("00000000-0000-0000-0000-000000000000"));
        // Version nibble 0 and variant nibble 0 are rejected by the RFC rule.
        assert!(!is_uuid("123e4567-e89b-02d3-a456-426614174000"));
        assert!(!is_uuid("123e4567-e89b-12d3-c456-426614174000"));
        assert!(!is_uuid("123e4567e89b12d3a456426614174000"));
    }
}
