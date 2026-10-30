//! Port of `src/server/memory/api/shared.ts` (`:1-260`) and
//! `src/server/memory/api/types.ts` (`:1-39`): the parsers and validators every
//! `/api/memory` handler shares, and the read-scope resolution of the legacy
//! local user.
//!
//! | TypeScript                                                  | Rust |
//! | ----------------------------------------------------------- | ---- |
//! | `shared.ts:8-9` (`ValidationError`, `MemoryRuntimeUnavailableError`) | [`MemoryApiError`](super::MemoryApiError) |
//! | `shared.ts:11-22` (`ALLOWED_TYPES`)                         | [`MemoryType::parse`] |
//! | `shared.ts:24-36` (`getReadyMemoryService`)                 | `MemoryApi::ready_service` in [`super`] |
//! | `shared.ts:38-55` (`parseStoreArgs`)                        | [`parse_store_args`] |
//! | `shared.ts:57-67` (`parseRecallArgs`)                       | [`parse_recall_args`] |
//! | `shared.ts:69-80` (`parseOptionalWorkspaceId`)              | [`parse_optional_workspace_id`] |
//! | `shared.ts:82-88` (`parsePersonaId`)                        | [`parse_persona_id`] |
//! | `shared.ts:90-96` (`parseMemoryNodeId`)                     | [`parse_memory_node_id`] |
//! | `shared.ts:98-164` (`parseUpdateBody`)                      | [`parse_update_body`] |
//! | `shared.ts:166-171` (`parseFlag`)                           | [`parse_flag`] |
//! | `shared.ts:173-182` (`parseOptionalType`)                   | [`parse_optional_type`] |
//! | `shared.ts:184-216` (`parseBulkBody`)                       | [`parse_bulk_body`] |
//! | `shared.ts:218-224` (`isDeleteAllConfirmed`)                | [`is_delete_all_confirmed`] |
//! | `shared.ts:226-258` (`resolveMemoryReadUserScopes`)         | [`resolve_memory_read_user_scopes`] |
//! | `shared.ts:4-6`, `shared.ts:12-13` (confirm token, text)    | [`DELETE_ALL_CONFIRM_TOKEN`], [`MEMORY_RUNTIME_UNAVAILABLE_MESSAGE`] |
//! | `types.ts:1-37` (`MemoryPostBody`, `Parsed*`)               | the `Parsed*` structs below; the POST body is read in [`super::handlers`] |
//! | `src/server/http/params.ts:17-24` (`parseBoundedIntOrFallback`) | [`parse_bounded_int_or_fallback`] |
//!
//! The parsers take `Option<&Value>`: a JSON body field and a decoded query
//! parameter are both read through the same coercions, and `None` stands for
//! `undefined` (an absent key or an absent query pair).

use std::collections::HashSet;

use serde_json::{Map, Value};

use crate::js::js_number_str;
use crate::memory::service::BulkUpdatePatch;
use crate::memory::types::{js_number, js_string, MemoryType, LEGACY_LOCAL_USER_ID};

use super::{ConversationDirectory, MemoryApiError};

/// `DELETE_ALL_CONFIRM_TOKEN` — `shared.ts:26`.
pub const DELETE_ALL_CONFIRM_TOKEN: &str = "delete-all-memory";

/// `MEMORY_RUNTIME_UNAVAILABLE_MESSAGE` — `shared.ts:27-28`.
///
/// The handlers answer a degraded runtime with this text. It differs from the
/// default message of `runtime.ts:127` (`...: configured provider is not
/// ready.`), and both are kept as the sources spell them.
pub const MEMORY_RUNTIME_UNAVAILABLE_MESSAGE: &str =
    "Memory runtime unavailable: the configured provider is not ready.";

/// `ParsedStoreArgs` — `types.ts:8-14`.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedStoreArgs {
    pub persona_id: String,
    pub workspace_id: Option<String>,
    pub node_type: MemoryType,
    pub content: String,
    /// Already rounded and clamped to `1..=5` (`shared.ts:49-51`).
    pub importance: f64,
}

/// `ParsedRecallArgs` — `types.ts:16-21`.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedRecallArgs {
    pub persona_id: String,
    pub workspace_id: Option<String>,
    pub query: String,
    /// Already floored and clamped to `1..=20` (`shared.ts:64-66`).
    pub limit: i64,
}

/// `ParsedUpdateBody` — `types.ts:23-33`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ParsedUpdateBody {
    pub persona_id: String,
    pub workspace_id: Option<String>,
    pub id: String,
    pub node_type: Option<MemoryType>,
    pub content: Option<String>,
    pub importance: Option<f64>,
    /// `expectedVersion`, floored; `NaN` never reaches this field.
    pub expected_version: Option<f64>,
    /// `restoreIndex`, floored and non-negative.
    pub restore_index: Option<i64>,
}

/// `action: 'update' | 'delete'` of `ParsedBulkBody` — `types.ts:35`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BulkAction {
    Update,
    Delete,
}

/// `ParsedBulkBody` — `types.ts:35-40`.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedBulkBody {
    pub persona_id: String,
    pub workspace_id: Option<String>,
    /// Trimmed, non-empty and de-duplicated, in first-seen order (`shared.ts:194-198`).
    pub ids: Vec<String>,
    pub action: BulkAction,
    pub updates: BulkUpdatePatch,
}

/// `String(value || '')` — the coercion of every `|| ''` read in the handlers.
///
/// The falsy values (`null`, `false`, `0`, `''`) all become `''`, which is the
/// JavaScript behaviour of `||`.
pub(super) fn js_text(raw: Option<&Value>) -> String {
    if is_truthy(raw) {
        js_string(raw)
    } else {
        String::new()
    }
}

/// `String(value ?? '')` — only `null` and `undefined` take the empty string.
/// Used for `workspaceId`, which the source guards with `??`, not `||`.
fn js_text_nullish(raw: Option<&Value>) -> String {
    match raw {
        None | Some(Value::Null) => String::new(),
        other => js_string(other),
    }
}

/// JavaScript truthiness of a JSON value (`NaN` cannot occur in JSON).
fn is_truthy(raw: Option<&Value>) -> bool {
    match raw {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|value| value != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `Number(value)` for a JSON value. Strings take [`js_number_str`], so `'0x10'`
/// and `'Infinity'` read the way JavaScript reads them; every other value takes
/// the coercion of [`js_number`].
fn js_number_of(value: &Value) -> f64 {
    match value {
        Value::String(text) => js_number_str(text),
        other => js_number(Some(other)),
    }
}

/// `Number(value ?? fallback)`: only `null` and `undefined` take the fallback.
fn number_or(raw: Option<&Value>, fallback: f64) -> f64 {
    match raw {
        None | Some(Value::Null) => fallback,
        Some(value) => js_number_of(value),
    }
}

/// `Math.min(max, Math.max(min, Math.round(value)))` when the value is finite,
/// `fallback` otherwise. `Math.round` rounds halves towards `+Infinity`, which
/// is `floor(value + 0.5)`.
fn rounded_in_range(value: f64, min: f64, max: f64, fallback: f64) -> f64 {
    if value.is_finite() {
        (value + 0.5).floor().clamp(min, max)
    } else {
        fallback
    }
}

/// `Math.floor(value)` when the value is finite, `NaN` otherwise.
fn floored(value: f64) -> f64 {
    if value.is_finite() {
        value.floor()
    } else {
        f64::NAN
    }
}

fn invalid_type() -> MemoryApiError {
    MemoryApiError::Validation("Invalid memory type.".to_string())
}

/// `parseBoundedIntOrFallback` — `src/server/http/params.ts:9-24`.
///
/// `undefined`, `null` and `''` take the fallback, a non-finite number takes it
/// too, and anything else is floored and clamped to `min..=max`. A `false` or
/// a non-numeric string therefore clamps to `min` or the fallback, as in the
/// source.
pub fn parse_bounded_int_or_fallback(
    raw: Option<&Value>,
    fallback: i64,
    min: i64,
    max: i64,
) -> i64 {
    match raw {
        None | Some(Value::Null) => fallback,
        Some(Value::String(text)) if text.is_empty() => fallback,
        Some(value) => {
            let parsed = js_number_of(value);
            if parsed.is_finite() {
                (parsed.floor() as i64).clamp(min, max)
            } else {
                fallback
            }
        }
    }
}

/// `parsePersonaId` — `shared.ts:82-88`.
pub fn parse_persona_id(raw: Option<&Value>) -> Result<String, MemoryApiError> {
    let persona_id = js_text(raw).trim().to_string();
    if persona_id.is_empty() {
        return Err(MemoryApiError::Validation(
            "personaId is required.".to_string(),
        ));
    }
    Ok(persona_id)
}

/// `parseMemoryNodeId` — `shared.ts:90-96`.
pub fn parse_memory_node_id(raw: Option<&Value>) -> Result<String, MemoryApiError> {
    let node_id = js_text(raw).trim().to_string();
    if node_id.is_empty() {
        return Err(MemoryApiError::Validation("id is required.".to_string()));
    }
    Ok(node_id)
}

/// `parseOptionalWorkspaceId` — `shared.ts:69-80`.
///
/// The length limit counts UTF-16 code units, like `String.length`, and the
/// control-character test runs per code point, as `[...workspaceId]` does.
pub fn parse_optional_workspace_id(raw: Option<&Value>) -> Result<Option<String>, MemoryApiError> {
    let workspace_id = js_text_nullish(raw).trim().to_string();
    if workspace_id.is_empty() {
        return Ok(None);
    }
    let contains_control = workspace_id
        .chars()
        .any(|character| (character as u32) <= 0x1f || character as u32 == 0x7f);
    if workspace_id.encode_utf16().count() > 255 || contains_control {
        return Err(MemoryApiError::Validation(
            "workspaceId is invalid.".to_string(),
        ));
    }
    Ok(Some(workspace_id))
}

/// `parseFlag` — `shared.ts:166-171`.
pub fn parse_flag(raw: Option<&Value>) -> bool {
    let value = js_text(raw).trim().to_lowercase();
    matches!(value.as_str(), "1" | "true" | "yes" | "on")
}

/// `parseOptionalType` — `shared.ts:173-182`. `''` and `'all'` mean "no filter".
pub fn parse_optional_type(raw: Option<&Value>) -> Result<Option<MemoryType>, MemoryApiError> {
    let value = js_text(raw).trim().to_string();
    if value.is_empty() || value == "all" {
        return Ok(None);
    }
    MemoryType::parse(&value).map(Some).ok_or_else(invalid_type)
}

/// `isDeleteAllConfirmed` — `shared.ts:218-224`.
pub fn is_delete_all_confirmed(raw: Option<&Value>) -> bool {
    js_text(raw).trim().to_lowercase() == DELETE_ALL_CONFIRM_TOKEN
}

/// `parseStoreArgs` — `shared.ts:38-55`.
pub fn parse_store_args(raw: &Map<String, Value>) -> Result<ParsedStoreArgs, MemoryApiError> {
    let persona_id = parse_persona_id(raw.get("personaId"))?;
    let workspace_id = parse_optional_workspace_id(raw.get("workspaceId"))?;
    let type_text = js_text(raw.get("type")).trim().to_string();
    let content = js_text(raw.get("content")).trim().to_string();
    let importance = rounded_in_range(number_or(raw.get("importance"), 3.0), 1.0, 5.0, 3.0);

    let node_type = MemoryType::parse(&type_text).ok_or_else(invalid_type)?;
    if content.is_empty() {
        return Err(MemoryApiError::Validation(
            "content is required.".to_string(),
        ));
    }
    Ok(ParsedStoreArgs {
        persona_id,
        workspace_id,
        node_type,
        content,
        importance,
    })
}

/// `parseRecallArgs` — `shared.ts:57-67`.
pub fn parse_recall_args(raw: &Map<String, Value>) -> Result<ParsedRecallArgs, MemoryApiError> {
    let persona_id = parse_persona_id(raw.get("personaId"))?;
    let workspace_id = parse_optional_workspace_id(raw.get("workspaceId"))?;
    let query = js_text(raw.get("query")).trim().to_string();
    let limit_raw = number_or(raw.get("limit"), 3.0);
    let limit = if limit_raw.is_finite() {
        (limit_raw.floor() as i64).clamp(1, 20)
    } else {
        3
    };
    if query.is_empty() {
        return Err(MemoryApiError::Validation("query is required.".to_string()));
    }
    Ok(ParsedRecallArgs {
        persona_id,
        workspace_id,
        query,
        limit,
    })
}

/// `parseUpdateBody` — `shared.ts:98-164`.
///
/// "Present" means the key exists in the object, so an explicit `null` counts
/// (`raw.type !== undefined` is true for `null`). A `null` `importance` reads as
/// `0` and is then clamped to `1`, as `Number(null)` does in the source.
pub fn parse_update_body(raw: &Map<String, Value>) -> Result<ParsedUpdateBody, MemoryApiError> {
    let persona_id = parse_persona_id(raw.get("personaId"))?;
    let id = parse_memory_node_id(raw.get("id"))?;
    let workspace_id = parse_optional_workspace_id(raw.get("workspaceId"))?;
    let mut next = ParsedUpdateBody {
        persona_id,
        workspace_id,
        id,
        ..ParsedUpdateBody::default()
    };

    if let Some(value) = raw.get("type") {
        let type_text = js_text(Some(value)).trim().to_string();
        next.node_type = Some(MemoryType::parse(&type_text).ok_or_else(invalid_type)?);
    }

    if let Some(value) = raw.get("content") {
        let content = js_text(Some(value)).trim().to_string();
        if content.is_empty() {
            return Err(MemoryApiError::Validation(
                "content must not be empty.".to_string(),
            ));
        }
        next.content = Some(content);
    }

    if let Some(value) = raw.get("importance") {
        let importance = rounded_in_range(js_number_of(value), 1.0, 5.0, f64::NAN);
        if !importance.is_finite() {
            return Err(MemoryApiError::Validation(
                "importance must be numeric.".to_string(),
            ));
        }
        next.importance = Some(importance);
    }

    if let Some(value) = raw.get("expectedVersion") {
        let expected = floored(js_number_of(value));
        if !expected.is_finite() || expected < 1.0 {
            return Err(MemoryApiError::Validation(
                "expectedVersion must be a positive integer.".to_string(),
            ));
        }
        next.expected_version = Some(expected);
    }

    if let Some(value) = raw.get("restoreIndex") {
        let restore = floored(js_number_of(value));
        if !restore.is_finite() || restore < 0.0 {
            return Err(MemoryApiError::Validation(
                "restoreIndex must be a non-negative integer.".to_string(),
            ));
        }
        next.restore_index = Some(restore as i64);
    }

    let has_edit = next.node_type.is_some() || next.content.is_some() || next.importance.is_some();
    if next.restore_index.is_some() {
        if has_edit {
            return Err(MemoryApiError::Validation(
                "restoreIndex cannot be combined with type/content/importance updates.".to_string(),
            ));
        }
        return Ok(next);
    }
    if !has_edit {
        return Err(MemoryApiError::Validation(
            "No fields to update.".to_string(),
        ));
    }
    Ok(next)
}

/// `parseBulkBody` — `shared.ts:184-216`.
pub fn parse_bulk_body(raw: &Map<String, Value>) -> Result<ParsedBulkBody, MemoryApiError> {
    let persona_id = parse_persona_id(raw.get("personaId"))?;
    let workspace_id = parse_optional_workspace_id(raw.get("workspaceId"))?;

    let mut ids: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    if let Some(Value::Array(items)) = raw.get("ids") {
        for item in items {
            let id = js_text(Some(item)).trim().to_string();
            if !id.is_empty() && seen.insert(id.clone()) {
                ids.push(id);
            }
        }
    }
    if ids.is_empty() {
        return Err(MemoryApiError::Validation(
            "ids must be a non-empty array.".to_string(),
        ));
    }

    let action = match js_text(raw.get("action")).trim().to_lowercase().as_str() {
        "update" => BulkAction::Update,
        "delete" => BulkAction::Delete,
        _ => {
            return Err(MemoryApiError::Validation(
                "action must be either \"update\" or \"delete\".".to_string(),
            ))
        }
    };

    let mut updates = BulkUpdatePatch::default();
    if let Some(value) = raw.get("type") {
        updates.node_type = parse_optional_type(Some(value))?;
    }
    if let Some(value) = raw.get("importance") {
        updates.importance = Some(parse_bounded_int_or_fallback(Some(value), 3, 1, 5) as f64);
    }

    if action == BulkAction::Update && updates.node_type.is_none() && updates.importance.is_none() {
        return Err(MemoryApiError::Validation(
            "Bulk update requires at least one update field.".to_string(),
        ));
    }
    Ok(ParsedBulkBody {
        persona_id,
        workspace_id,
        ids,
        action,
        updates,
    })
}

/// `resolveMemoryReadUserScopes` — `shared.ts:226-258`.
///
/// Any user other than the legacy local user reads only its own scope. The
/// legacy user also reads the scope of every non-webchat conversation that
/// belongs to this persona (or to no persona). A failed conversation lookup is
/// logged and leaves the legacy scope alone, as `console.warn` does.
pub fn resolve_memory_read_user_scopes(
    base_user_id: &str,
    persona_id: &str,
    conversations: &dyn ConversationDirectory,
) -> Vec<String> {
    let normalized = base_user_id.trim();
    if normalized.is_empty() {
        return Vec::new();
    }
    if normalized != LEGACY_LOCAL_USER_ID {
        return vec![normalized.to_string()];
    }

    let mut scopes = vec![normalized.to_string()];
    match conversations.list_user_conversations(500, normalized) {
        Ok(rows) => {
            for conversation in rows {
                let channel = conversation.channel_type.trim().to_lowercase();
                let external_chat_id = conversation
                    .external_chat_id
                    .unwrap_or_default()
                    .trim()
                    .to_string();
                let conversation_persona = conversation
                    .persona_id
                    .unwrap_or_default()
                    .trim()
                    .to_string();
                if channel.is_empty() || external_chat_id.is_empty() || channel == "webchat" {
                    continue;
                }
                if !conversation_persona.is_empty() && conversation_persona != persona_id {
                    continue;
                }
                let scope = format!("channel:{channel}:{external_chat_id}");
                if !scopes.contains(&scope) {
                    scopes.push(scope);
                }
            }
        }
        Err(error) => tracing::warn!("Memory scope discovery failed: {error}"),
    }
    scopes
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn object(value: Value) -> Map<String, Value> {
        match value {
            Value::Object(map) => map,
            other => panic!("test fixture must be an object, got {other}"),
        }
    }

    fn message(result: Result<impl std::fmt::Debug, MemoryApiError>) -> String {
        result.expect_err("rejected").message()
    }

    #[test]
    fn the_bounded_parser_falls_back_and_clamps_like_the_source() {
        let bounded = |value: Value| parse_bounded_int_or_fallback(Some(&value), 3, 1, 5);
        assert_eq!(parse_bounded_int_or_fallback(None, 3, 1, 5), 3);
        assert_eq!(bounded(json!("")), 3, "the empty string takes the fallback");
        assert_eq!(bounded(json!("abc")), 3, "NaN takes the fallback");
        assert_eq!(bounded(json!("Infinity")), 3, "Infinity is not finite");
        assert_eq!(bounded(json!(false)), 1, "Number(false) is 0, clamped up");
        assert_eq!(bounded(json!("7.9")), 5, "floor, then clamp to the maximum");
        assert_eq!(bounded(json!(2.99)), 2, "floor, not round");
    }

    #[test]
    fn a_missing_persona_or_node_id_is_rejected_with_the_source_text() {
        assert_eq!(
            message(parse_persona_id(Some(&json!("   ")))),
            "personaId is required."
        );
        assert_eq!(
            message(parse_memory_node_id(Some(&json!(0)))),
            "id is required."
        );
        assert_eq!(parse_persona_id(Some(&json!(" p1 "))).unwrap(), "p1");
    }

    #[test]
    fn the_workspace_id_rejects_control_characters_and_long_values() {
        assert_eq!(parse_optional_workspace_id(None).unwrap(), None);
        assert_eq!(
            parse_optional_workspace_id(Some(&json!("ws-1"))).unwrap(),
            Some("ws-1".to_string())
        );
        assert_eq!(
            message(parse_optional_workspace_id(Some(&json!("a\u{7f}b")))),
            "workspaceId is invalid."
        );
        let long = "x".repeat(256);
        assert_eq!(
            message(parse_optional_workspace_id(Some(&json!(long)))),
            "workspaceId is invalid."
        );
    }

    #[test]
    fn store_args_round_the_importance_and_check_the_type_before_the_content() {
        let parsed = parse_store_args(&object(json!({
            "personaId": "p1",
            "type": "fact",
            "content": " Ich mag Tee ",
            "importance": 4.6,
        })))
        .expect("valid");
        assert_eq!(parsed.node_type, MemoryType::Fact);
        assert_eq!(parsed.content, "Ich mag Tee");
        assert_eq!(parsed.importance, 5.0);

        let no_default = parse_store_args(&object(json!({
            "personaId": "p1",
            "type": "fact",
            "content": "x",
            "importance": "abc",
        })))
        .expect("valid");
        assert_eq!(no_default.importance, 3.0, "a non-numeric importance is 3");

        assert_eq!(
            message(parse_store_args(&object(json!({
                "personaId": "p1",
                "type": "nope",
                "content": "",
            })))),
            "Invalid memory type."
        );
        assert_eq!(
            message(parse_store_args(&object(json!({
                "personaId": "p1",
                "type": "fact",
                "content": "   ",
            })))),
            "content is required."
        );
    }

    #[test]
    fn a_null_importance_on_update_reads_as_zero_and_clamps_to_one() {
        let parsed = parse_update_body(&object(json!({
            "personaId": "p1",
            "id": "n1",
            "importance": null,
        })))
        .expect("valid");
        assert_eq!(parsed.importance, Some(1.0));
    }

    #[test]
    fn update_rejects_a_restore_combined_with_an_edit_and_an_empty_patch() {
        assert_eq!(
            message(parse_update_body(&object(json!({
                "personaId": "p1",
                "id": "n1",
                "restoreIndex": 0,
                "content": "x",
            })))),
            "restoreIndex cannot be combined with type/content/importance updates."
        );
        assert_eq!(
            message(parse_update_body(&object(json!({
                "personaId": "p1",
                "id": "n1",
                "expectedVersion": 2,
            })))),
            "No fields to update."
        );
        assert_eq!(
            message(parse_update_body(&object(json!({
                "personaId": "p1",
                "id": "n1",
                "expectedVersion": 0,
                "content": "x",
            })))),
            "expectedVersion must be a positive integer."
        );
    }

    #[test]
    fn bulk_body_dedupes_ids_and_requires_an_update_field() {
        let parsed = parse_bulk_body(&object(json!({
            "personaId": "p1",
            "ids": ["a", " a ", "", "b"],
            "action": "DELETE",
        })))
        .expect("valid");
        assert_eq!(parsed.ids, vec!["a".to_string(), "b".to_string()]);
        assert_eq!(parsed.action, BulkAction::Delete);

        assert_eq!(
            message(parse_bulk_body(&object(json!({
                "personaId": "p1",
                "ids": ["a"],
                "action": "update",
                "type": "all",
            })))),
            "Bulk update requires at least one update field."
        );
        assert_eq!(
            message(parse_bulk_body(&object(json!({
                "personaId": "p1",
                "ids": ["a"],
                "action": "archive",
            })))),
            "action must be either \"update\" or \"delete\"."
        );
    }

    /// A directory that answers with fixed rows, so the scope rules are tested
    /// without a message store.
    struct FixedConversations(Vec<crate::messages_store::types::Conversation>);

    impl ConversationDirectory for FixedConversations {
        fn list_user_conversations(
            &self,
            _limit: i64,
            _user_id: &str,
        ) -> Result<Vec<crate::messages_store::types::Conversation>, String> {
            Ok(self.0.clone())
        }
    }

    fn conversation(
        channel: &str,
        external: Option<&str>,
        persona: Option<&str>,
    ) -> crate::messages_store::types::Conversation {
        crate::messages_store::types::Conversation {
            id: "c".to_string(),
            channel_type: channel.to_string(),
            external_chat_id: external.map(str::to_string),
            user_id: LEGACY_LOCAL_USER_ID.to_string(),
            workspace_id: None,
            title: String::new(),
            model_override: None,
            persona_id: persona.map(str::to_string),
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn the_legacy_user_reads_the_channel_scopes_of_its_persona_only() {
        let directory = FixedConversations(vec![
            conversation("Telegram", Some("123"), Some("p1")),
            conversation("webchat", Some("abc"), Some("p1")),
            conversation("whatsapp", Some("555"), Some("p2")),
            conversation("slack", Some("  "), Some("p1")),
            conversation("discord", Some("999"), None),
        ]);
        assert_eq!(
            resolve_memory_read_user_scopes(LEGACY_LOCAL_USER_ID, "p1", &directory),
            vec![
                LEGACY_LOCAL_USER_ID.to_string(),
                "channel:telegram:123".to_string(),
                "channel:discord:999".to_string(),
            ]
        );
        assert_eq!(
            resolve_memory_read_user_scopes("user-1", "p1", &directory),
            vec!["user-1".to_string()],
            "an authenticated user reads its own scope only"
        );
    }
}
