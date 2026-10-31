//! Gateway frame protocol.
//!
//! Byte-compatible port of `src/server/gateway/protocol.ts` and the frame types
//! in `src/shared/gatewayTypes.ts`. The browser client parses these shapes, so
//! field names and the `ErrorCode` union must not drift.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The only protocol namespace the server accepts.
pub type MethodNamespace = &'static str;

pub const NAMESPACE_V2: MethodNamespace = "v2";

/// Closed union of error codes. Order matches `src/shared/gatewayTypes.ts:41-48`.
pub const ERROR_CODES: &[&str] = &[
    "INVALID_REQUEST",
    "UNAUTHORIZED",
    "NOT_FOUND",
    "UNAVAILABLE",
    "RATE_LIMITED",
    "BACKPRESSURE",
    "REPLAY_WINDOW_EXPIRED",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    InvalidRequest,
    Unauthorized,
    NotFound,
    Unavailable,
    RateLimited,
    Backpressure,
    ReplayWindowExpired,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::InvalidRequest => "INVALID_REQUEST",
            ErrorCode::Unauthorized => "UNAUTHORIZED",
            ErrorCode::NotFound => "NOT_FOUND",
            ErrorCode::Unavailable => "UNAVAILABLE",
            ErrorCode::RateLimited => "RATE_LIMITED",
            ErrorCode::Backpressure => "BACKPRESSURE",
            ErrorCode::ReplayWindowExpired => "REPLAY_WINDOW_EXPIRED",
        }
    }

    /// Maps a thrown error's `code` property, defaulting to `UNAVAILABLE`.
    ///
    /// Port of `toErrorCode()` in `method-router.ts:70-82`.
    pub fn from_error_code(code: Option<&str>) -> Self {
        match code {
            Some("INVALID_REQUEST") => ErrorCode::InvalidRequest,
            Some("UNAUTHORIZED") => ErrorCode::Unauthorized,
            Some("NOT_FOUND") => ErrorCode::NotFound,
            Some("RATE_LIMITED") => ErrorCode::RateLimited,
            Some("BACKPRESSURE") => ErrorCode::Backpressure,
            Some("REPLAY_WINDOW_EXPIRED") => ErrorCode::ReplayWindowExpired,
            _ => ErrorCode::Unavailable,
        }
    }
}

/// A request correlation id. The client may send a string or a number and the
/// server must echo it back unchanged.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum FrameId {
    Str(String),
    Num(FrameNumber),
}

/// A JSON number that round-trips without gaining a fractional part.
///
/// `serde_json::Value` compares `7.0` and `7` as equal, but the browser client
/// compares ids with `===`, so an id sent as `7` must come back as `7`. Storing
/// the raw number and re-serialising it would emit `7.0`, hence this wrapper.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FrameNumber {
    raw: f64,
    integral: bool,
    as_i64: Option<i64>,
    as_u64: Option<u64>,
}

impl FrameNumber {
    /// Wraps a JSON number so integer values re-serialise without a fraction.
    pub fn new(raw: f64) -> Self {
        Self {
            raw,
            integral: raw.fract() == 0.0 && raw.is_finite(),
            as_i64: if raw.fract() == 0.0
                && raw.is_finite()
                && raw >= i64::MIN as f64
                && raw <= i64::MAX as f64
            {
                Some(raw as i64)
            } else {
                None
            },
            as_u64: if raw.fract() == 0.0 && raw.is_finite() && raw >= 0.0 && raw <= u64::MAX as f64
            {
                Some(raw as u64)
            } else {
                None
            },
        }
    }

    pub fn as_f64(self) -> f64 {
        self.raw
    }

    /// True when the value is an exact integer.
    pub fn is_integral(self) -> bool {
        self.integral
    }
}

impl From<i64> for FrameNumber {
    fn from(value: i64) -> Self {
        Self::new(value as f64)
    }
}

impl From<u64> for FrameNumber {
    fn from(value: u64) -> Self {
        Self::new(value as f64)
    }
}

impl Serialize for FrameNumber {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        if let Some(value) = self.as_i64 {
            return serializer.serialize_i64(value);
        }
        if let Some(value) = self.as_u64 {
            return serializer.serialize_u64(value);
        }
        serializer.serialize_f64(self.raw)
    }
}

impl<'de> Deserialize<'de> for FrameNumber {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = f64::deserialize(deserializer)?;
        Ok(Self::new(raw))
    }
}

impl FrameId {
    /// Builds a numeric id from an integer, which is what tests and internal
    /// call sites use. The value re-serialises as an integer, matching the wire
    /// format the browser client compares with `===`.
    pub fn number(value: i64) -> Self {
        FrameId::Num(FrameNumber::new(value as f64))
    }

    pub fn to_value(&self) -> Value {
        match self {
            FrameId::Str(value) => Value::String(value.clone()),
            FrameId::Num(value) => serde_json::to_value(value).unwrap_or(Value::Null),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ErrorShape {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RequestFrame {
    pub id: FrameId,
    pub method: String,
    pub params: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ResponseFrame {
    pub id: FrameId,
    pub ok: bool,
    pub payload: Option<Value>,
    pub error: Option<ErrorShape>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EventFrame {
    pub event: String,
    pub payload: Option<Value>,
    pub seq: Option<u64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StreamFrame {
    pub id: FrameId,
    pub delta: String,
    pub done: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum GatewayFrame {
    Request(RequestFrame),
    Response(ResponseFrame),
    Event(EventFrame),
    Stream(StreamFrame),
}

/// Parses a raw text frame. Returns `None` for anything unrecognised.
///
/// The validator mirrors `parseFrame()` in `protocol.ts:26-64`: it checks the
/// frame discriminator and only the fields the type requires. Extra properties
/// are tolerated because the client may add metadata.
pub fn parse_frame(raw: &str) -> Option<GatewayFrame> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let object = value.as_object()?;
    let frame_type = object.get("type").and_then(Value::as_str)?;

    match frame_type {
        "req" => {
            let id = parse_id(object.get("id"))?;
            let method = object.get("method")?.as_str()?.to_string();
            let params = object
                .get("params")
                .cloned()
                .unwrap_or_else(|| Value::Object(Default::default()));
            Some(GatewayFrame::Request(RequestFrame { id, method, params }))
        }
        "res" => {
            let id = parse_id(object.get("id"))?;
            let ok = object.get("ok").and_then(Value::as_bool)?;
            let payload = object.get("payload").cloned();
            let error = match object.get("error") {
                Some(Value::Object(map)) => Some(ErrorShape {
                    code: map.get("code")?.as_str()?.to_string(),
                    message: map.get("message")?.as_str()?.to_string(),
                }),
                _ => None,
            };
            Some(GatewayFrame::Response(ResponseFrame {
                id,
                ok,
                payload,
                error,
            }))
        }
        "event" => {
            let event = object.get("event")?.as_str()?.to_string();
            Some(GatewayFrame::Event(EventFrame {
                event,
                payload: object.get("payload").cloned(),
                seq: object.get("seq").and_then(Value::as_u64),
            }))
        }
        "stream" => {
            let id = parse_id(object.get("id"))?;
            let delta = object.get("delta")?.as_str()?.to_string();
            let done = object.get("done").and_then(Value::as_bool).unwrap_or(false);
            Some(GatewayFrame::Stream(StreamFrame { id, delta, done }))
        }
        _ => None,
    }
}

fn parse_id(value: Option<&Value>) -> Option<FrameId> {
    match value? {
        Value::String(text) => Some(FrameId::Str(text.clone())),
        Value::Number(number) => Some(FrameId::Num(FrameNumber::new(number.as_f64()?))),
        _ => None,
    }
}

/// `makeResponse()` from `protocol.ts:68-70`.
pub fn make_response(id: &FrameId, payload: Value) -> Value {
    serde_json::json!({ "type": "res", "id": id.to_value(), "ok": true, "payload": payload })
}

/// `makeError()` from `protocol.ts:72-74`.
pub fn make_error(id: &FrameId, code: ErrorCode, message: &str) -> Value {
    serde_json::json!({
        "type": "res",
        "id": id.to_value(),
        "ok": false,
        "error": { "code": code.as_str(), "message": message },
    })
}

/// `makeEvent()` from `protocol.ts:76-78`.
pub fn make_event(event: &str, payload: Option<Value>, seq: Option<u64>) -> Value {
    serde_json::json!({
        "type": "event",
        "event": event,
        "payload": payload,
        "seq": seq,
    })
}

/// `makeStream()` from `protocol.ts:80-82`.
pub fn make_stream(id: &FrameId, delta: &str, done: bool) -> Value {
    serde_json::json!({
        "type": "stream",
        "id": id.to_value(),
        "delta": delta,
        "done": done,
    })
}

/// Error frame for an unparsable inbound frame.
///
/// The TypeScript server uses the literal id `'unknown'`.
pub fn invalid_frame_error() -> Value {
    make_error(
        &FrameId::Str("unknown".to_string()),
        ErrorCode::InvalidRequest,
        "Invalid frame format",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_request_frame() {
        let frame = parse_frame(r#"{"type":"req","id":1,"method":"presence.list"}"#).unwrap();
        match frame {
            GatewayFrame::Request(request) => {
                assert_eq!(request.id, FrameId::number(1));
                assert_eq!(request.method, "presence.list");
                assert!(request.params.is_object());
            }
            other => panic!("unexpected frame: {other:?}"),
        }
    }

    #[test]
    fn accepts_string_ids() {
        let frame = parse_frame(r#"{"type":"req","id":"abc","method":"m"}"#).unwrap();
        match frame {
            GatewayFrame::Request(request) => assert_eq!(request.id, FrameId::Str("abc".into())),
            other => panic!("unexpected frame: {other:?}"),
        }
    }

    #[test]
    fn rejects_malformed_frames() {
        assert!(parse_frame("not json").is_none());
        assert!(parse_frame("[]").is_none());
        assert!(parse_frame(r#"{"type":"req"}"#).is_none());
        assert!(parse_frame(r#"{"type":"req","id":1}"#).is_none());
        assert!(parse_frame(r#"{"type":"req","id":{},"method":"m"}"#).is_none());
        assert!(parse_frame(r#"{"type":"unknown","id":1}"#).is_none());
        assert!(parse_frame(r#"{"type":"res","id":1}"#).is_none());
        assert!(parse_frame(r#"{"type":"event"}"#).is_none());
        assert!(parse_frame(r#"{"type":"stream","id":1}"#).is_none());
    }

    #[test]
    fn parses_event_and_stream_frames() {
        let frame = parse_frame(r#"{"type":"event","event":"tick","seq":3}"#).unwrap();
        match frame {
            GatewayFrame::Event(event) => {
                assert_eq!(event.event, "tick");
                assert_eq!(event.seq, Some(3));
            }
            other => panic!("unexpected frame: {other:?}"),
        }

        let frame = parse_frame(r#"{"type":"stream","id":1,"delta":"tok"}"#).unwrap();
        match frame {
            GatewayFrame::Stream(stream) => {
                assert_eq!(stream.delta, "tok");
                assert!(!stream.done);
            }
            other => panic!("unexpected frame: {other:?}"),
        }
    }

    #[test]
    fn error_codes_map_like_typescript() {
        assert_eq!(
            ErrorCode::from_error_code(Some("NOT_FOUND")),
            ErrorCode::NotFound
        );
        assert_eq!(
            ErrorCode::from_error_code(Some("SOMETHING")),
            ErrorCode::Unavailable
        );
        assert_eq!(ErrorCode::from_error_code(None), ErrorCode::Unavailable);
    }

    #[test]
    fn builds_frames_with_expected_shape() {
        let response = make_response(&FrameId::Str("a".into()), serde_json::json!({"x":1}));
        assert_eq!(response["type"], "res");
        assert_eq!(response["ok"], true);
        assert_eq!(response["id"], "a");

        let error = make_error(
            &FrameId::number(7),
            ErrorCode::RateLimited,
            "Too many requests",
        );
        assert_eq!(error["error"]["code"], "RATE_LIMITED");
        assert_eq!(error["error"]["message"], "Too many requests");
        assert_eq!(error["id"], 7);

        let event = make_event("tick", Some(serde_json::json!({"ts":1})), Some(2));
        assert_eq!(event["seq"], 2);
        assert_eq!(event["payload"]["ts"], 1);
    }

    #[test]
    fn invalid_frame_error_matches_typescript() {
        let error = invalid_frame_error();
        assert_eq!(error["id"], "unknown");
        assert_eq!(error["error"]["code"], "INVALID_REQUEST");
        assert_eq!(error["error"]["message"], "Invalid frame format");
    }
}
