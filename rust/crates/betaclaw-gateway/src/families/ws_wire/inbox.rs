//! Port of `inbox.list` in `src/server/gateway/methods/channels.ts`, with the query
//! contract of `src/server/channels/inbox/contract.ts`.
//!
//! The observability calls (`logInboxObservability`, `recordInboxQueryDuration`,
//! the chat-display trace and the resync counter) belong to OP-2 and are not ported
//! here. The `resync` flag therefore has no effect on the wire.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use betaclaw_core::channels::ws::helpers::{non_empty, parse_int_prefix, str_param, HandlerError};
use betaclaw_core::gateway::protocol::ErrorCode;
use betaclaw_core::messages_store::{InboxCursor, InboxListInput, InboxListResult};
use serde_json::{json, Value};

use super::{WsCall, WsServices};

const DEFAULT_LIMIT: i64 = 50;
const MAX_LIMIT: i64 = 100;
/// Rate-limit transport name for the WS path (`consumeInboxRateLimit('ws', ...)`).
const RATE_LIMIT_TRANSPORT: &str = "ws";
/// `SUNSET_AFTER` in `routes/inbox.rs`: 30 days, as `resolveDeprecationHeaders`.
const SUNSET_DAYS: i64 = 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Version {
    V1,
    V2,
}

/// The resolved `inbox.list` request (`ResolvedInboxListInput`).
struct Request {
    version: Version,
    channel: Option<String>,
    query: Option<String>,
    limit: i64,
    cursor: Option<InboxCursor>,
}

/// `inbox.list`: one page of the caller's conversations. `version` 1 keeps the
/// deprecated shape with a `deprecated.sunset` date.
pub fn inbox_list(s: &WsServices, call: &WsCall) -> Result<Value, HandlerError> {
    let request = parse_request(&call.params)?;
    let v2_enabled = inbox_v2_enabled(std::env::var("INBOX_V2_ENABLED").ok().as_deref());
    if request.version == Version::V2 && !v2_enabled {
        return Err(HandlerError::new(
            ErrorCode::Unavailable,
            "Inbox v2 is temporarily disabled.",
        ));
    }

    let key = format!("{}:{}", call.user_id(), call.client.conn_id);
    if !s.inbox_rate_limit.allow(RATE_LIMIT_TRANSPORT, &key) {
        return Err(HandlerError::new(
            ErrorCode::RateLimited,
            "Too many inbox requests.",
        ));
    }

    let result = s.inbox.list_inbox(InboxListInput {
        user_id: call.user_id(),
        channel: request.channel.as_deref(),
        query: request.query.as_deref(),
        limit: Some(request.limit),
        cursor: request.cursor,
    })?;
    Ok(match request.version {
        Version::V2 => v2_response(&result),
        Version::V1 => v1_response(&result),
    })
}

/// `resolveInboxListInput` over the WS params. Strings are read as `safeString` does:
/// a non-string value counts as absent.
fn parse_request(params: &Value) -> Result<Request, HandlerError> {
    let version = resolve_version(params.get("version"))?;
    let limit = resolve_limit(params.get("limit"))?;
    let channel = non_empty(str_param(params, "channel").trim());
    let query = non_empty(str_param(params, "q").trim());
    let cursor = parse_cursor(str_param(params, "cursor"))?;
    Ok(Request {
        version,
        channel,
        query,
        limit,
        cursor,
    })
}

/// `resolveInboxVersion`: empty, `2` or `v2` is v2, and `1` or `v1` is v1.
fn resolve_version(value: Option<&Value>) -> Result<Version, HandlerError> {
    match js_text(value).trim().to_lowercase().as_str() {
        "" | "2" | "v2" => Ok(Version::V2),
        "1" | "v1" => Ok(Version::V1),
        _ => Err(HandlerError::invalid("version must be 1 or 2")),
    }
}

/// `resolveLimit`: a missing value gives 50, and other values must be a positive
/// integer. The result is capped at 100.
fn resolve_limit(value: Option<&Value>) -> Result<i64, HandlerError> {
    let text = js_text(value);
    if text.trim().is_empty() {
        return Ok(DEFAULT_LIMIT);
    }
    match parse_int_prefix(&text) {
        Some(parsed) if parsed.is_finite() && parsed >= 1.0 => Ok((parsed as i64).min(MAX_LIMIT)),
        _ => Err(HandlerError::invalid("limit must be a positive integer")),
    }
}

/// `parseCursor`: base64url JSON with a non-empty `updatedAt` and `conversationId`.
fn parse_cursor(raw: &str) -> Result<Option<InboxCursor>, HandlerError> {
    let normalized = raw.trim();
    if normalized.is_empty() {
        return Ok(None);
    }
    let invalid = || HandlerError::invalid("cursor is invalid");
    let bytes = URL_SAFE_NO_PAD
        .decode(normalized.trim_end_matches('='))
        .map_err(|_| invalid())?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    let field = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string()
    };
    let updated_at = field("updatedAt");
    let conversation_id = field("conversationId");
    if updated_at.is_empty() || conversation_id.is_empty() {
        return Err(invalid());
    }
    Ok(Some(InboxCursor {
        updated_at,
        conversation_id,
    }))
}

/// `encodeCursor`: base64url of `{"updatedAt":...,"conversationId":...}`, in that key
/// order as `JSON.stringify` writes it. `null` when there is no cursor.
fn encode_cursor(cursor: Option<&InboxCursor>) -> Value {
    match cursor {
        None => Value::Null,
        Some(cursor) => {
            let updated_at = json_string(&cursor.updated_at);
            let conversation_id = json_string(&cursor.conversation_id);
            let body =
                format!(r#"{{"updatedAt":{updated_at},"conversationId":{conversation_id}}}"#);
            Value::String(URL_SAFE_NO_PAD.encode(body))
        }
    }
}

fn json_string(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_default()
}

/// `toInboxV2Response`.
fn v2_response(result: &InboxListResult) -> Value {
    json!({
        "ok": true,
        "items": items(result),
        "page": {
            "limit": result.limit,
            "returned": result.items.len(),
            "hasMore": result.has_more,
            "nextCursor": encode_cursor(result.next_cursor.as_ref()),
            "totalMatched": result.total_matched,
        },
    })
}

/// `toInboxV1Response`, plus the `deprecated` block that the WS handler adds.
fn v1_response(result: &InboxListResult) -> Value {
    json!({
        "ok": true,
        "items": items(result),
        "total": result.total_matched,
        "nextCursor": encode_cursor(result.next_cursor.as_ref()),
        "deprecated": { "sunset": sunset_iso() },
    })
}

fn items(result: &InboxListResult) -> Value {
    serde_json::to_value(&result.items).unwrap_or(Value::Array(Vec::new()))
}

/// `new Date(Date.now() + 30 days).toISOString()`.
fn sunset_iso() -> String {
    (chrono::Utc::now() + chrono::TimeDelta::days(SUNSET_DAYS))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// `isInboxV2Enabled()`: on unless the value is `false` in any case.
fn inbox_v2_enabled(raw: Option<&str>) -> bool {
    raw.filter(|value| !value.is_empty())
        .unwrap_or("true")
        .to_lowercase()
        != "false"
}

/// `String(value ?? '')` for a JSON value. Arrays and objects give an empty string.
fn js_text(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(number)) => match number.as_f64() {
            Some(n) if n.fract() == 0.0 && n.abs() < 1e15 => format!("{}", n as i64),
            _ => number.to_string(),
        },
        Some(_) => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use base64::Engine as _;
    use serde_json::json;

    use super::super::test_support::{failure, fixture, invoke, payload, test_client};
    use super::*;

    #[tokio::test]
    async fn inbox_list_pages_v2_by_default_and_rejects_bad_versions() {
        let (fake, services) = fixture();
        let (client, _rx) = test_client();
        let body = payload(invoke(&services, "inbox.list", json!({}), &client).await);
        assert_eq!(body["ok"], true);
        assert_eq!(body["page"]["limit"], 50);
        assert_eq!(body["page"]["nextCursor"], Value::Null);
        assert_eq!(
            fake.state.lock().unwrap().inbox_seen,
            Some(("u1".to_string(), Some(50)))
        );

        let err = failure(invoke(&services, "inbox.list", json!({"version": "3"}), &client).await);
        assert_eq!(err, HandlerError::invalid("version must be 1 or 2"));

        fake.state.lock().unwrap().rate_denied = true;
        let err = failure(invoke(&services, "inbox.list", json!({}), &client).await);
        assert_eq!(
            err,
            HandlerError::new(ErrorCode::RateLimited, "Too many inbox requests.")
        );
    }

    #[test]
    fn inbox_v2_flag_is_on_unless_disabled() {
        assert!(inbox_v2_enabled(None));
        assert!(inbox_v2_enabled(Some("")));
        assert!(!inbox_v2_enabled(Some("FALSE")));
    }

    #[test]
    fn cursor_round_trips_and_garbage_is_invalid() {
        let cursor = InboxCursor {
            updated_at: "2026-01-01T00:00:00.000Z".into(),
            conversation_id: "c1".into(),
        };
        let encoded = encode_cursor(Some(&cursor));
        let decoded = parse_cursor(encoded.as_str().unwrap())
            .unwrap()
            .expect("a cursor");
        assert_eq!(decoded.updated_at, cursor.updated_at);
        assert_eq!(decoded.conversation_id, "c1");

        let not_a_cursor = URL_SAFE_NO_PAD.encode("not json");
        match parse_cursor(&not_a_cursor) {
            Err(error) => assert_eq!(error, HandlerError::invalid("cursor is invalid")),
            Ok(_) => panic!("garbage must be rejected"),
        }
    }

    #[test]
    fn limit_defaults_caps_and_rejects_non_positive_values() {
        assert_eq!(resolve_limit(None).unwrap(), 50);
        assert_eq!(resolve_limit(Some(&json!("250"))).unwrap(), 100);
        assert_eq!(resolve_limit(Some(&json!(3.7))).unwrap(), 3);
        assert_eq!(
            resolve_limit(Some(&json!(0))),
            Err(HandlerError::invalid("limit must be a positive integer"))
        );
    }
}
