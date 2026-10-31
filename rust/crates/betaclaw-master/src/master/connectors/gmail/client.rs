//! Port of `src/server/master/connectors/gmail/client.ts:1-287`.
//!
//! The Gmail client: a mock mode (a process-wide in-memory mailbox) and a real
//! mode that speaks the Gmail REST API. The API calls go through the S4
//! [`HttpTransport`] seam (OP-16) — this crate owns no HTTP client.
//!
//! # Process-wide mock mailbox (OP-S9-19)
//!
//! `client.ts:4` keeps `const mailbox = new Map(...)` at module scope, shared by
//! every `GmailClient` and cleared by `resetGmailClientState`. The port keeps a
//! process-wide [`OnceLock`] + `Mutex` map and exposes
//! [`reset_gmail_client_state`] for the same reason.
//!
//! # Real HTTP is the S4 transport (OP-16)
//!
//! `gmailApiFetch` (`:35-53`) calls the global `fetch`; the port takes an
//! `Arc<dyn HttpTransport>` and builds an [`HttpRequest`] per call. The API
//! error text is `` `Gmail API ${status}: ${text.slice(0, 300)}` ``.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use base64::Engine as _;
use http::Method;
use regex::Regex;
use serde::Deserialize;

use crate::master::connectors::gmail::types::{GmailDraftInput, GmailMessage};
use crate::master::feature_flags::MasterEnv;
use crate::master::repository::helpers::now_iso;
use crate::model_hub::http::{HttpError, HttpRequest, HttpTransport};

/// `MAX_BODY_CHARS` from `client.ts:5`.
const MAX_BODY_CHARS: usize = 4000;

/// The process-wide `mailbox` map of `client.ts:4` (OP-S9-19).
fn mock_mailbox() -> &'static Mutex<HashMap<String, Vec<GmailMessage>>> {
    static MAILBOX: OnceLock<Mutex<HashMap<String, Vec<GmailMessage>>>> = OnceLock::new();
    MAILBOX.get_or_init(|| Mutex::new(HashMap::new()))
}

/// `resetGmailClientState` — `client.ts:285-287`.
pub fn reset_gmail_client_state() {
    mock_mailbox().lock().unwrap().clear();
}

/// The `throw`s of the client plus the wrapped transport error.
#[derive(Debug, thiserror::Error)]
pub enum GmailClientError {
    #[error("Missing Gmail access token.")]
    MissingAccessToken,
    #[error("Gmail API {status}: {body}")]
    Api { status: u16, body: String },
    #[error(transparent)]
    Transport(#[from] HttpError),
    #[error("invalid response body: {0}")]
    InvalidBody(String),
}

/// `isMockMode` — `client.ts:7-14`.
fn is_mock_mode(access_token: &str, env: &MasterEnv) -> bool {
    let mode = env
        .get("BETACLAW_MASTER_GMAIL_MODE")
        .map(String::as_str)
        .unwrap_or("auto")
        .to_lowercase();
    if mode == "mock" {
        return true;
    }
    if mode == "real" {
        return false;
    }
    if access_token.starts_with("mock:") {
        return true;
    }
    if access_token == "access-token" {
        return true;
    }
    access_token.starts_with("test-")
}

/// `isDetailFetchEnabled` — `client.ts:16-22`.
fn is_detail_fetch_enabled(env: &MasterEnv) -> bool {
    let normalized = env
        .get("MASTER_GMAIL_FETCH_DETAILS")
        .map(String::as_str)
        .unwrap_or("1")
        .trim()
        .to_lowercase();
    if normalized.is_empty() {
        return true;
    }
    !matches!(normalized.as_str(), "0" | "false" | "off")
}

/// `encodeURIComponent` for the search query.
fn encode_uri_component(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        let character = byte as char;
        if character.is_ascii_alphanumeric()
            || matches!(
                character,
                '-' | '_' | '.' | '!' | '~' | '*' | '\'' | '(' | ')'
            )
        {
            out.push(character);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// `toRawMime` — `client.ts:24-33`.
fn to_raw_mime(draft: &GmailDraftInput) -> String {
    let payload = format!(
        "To: {}\r\nSubject: {}\r\nContent-Type: text/plain; charset=\"UTF-8\"\r\n\r\n{}",
        draft.to, draft.subject, draft.body
    );
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload.as_bytes())
}

/// `decodeBase64Url` — `client.ts:55-62`.
fn decode_base64url(value: &str) -> String {
    if value.is_empty() {
        return String::new();
    }
    let data: Vec<u8> = value
        .bytes()
        .filter(|byte| byte.is_ascii_alphanumeric() || *byte == b'-' || *byte == b'_')
        .collect();
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(&data)
        .unwrap_or_default();
    String::from_utf8_lossy(&decoded).into_owned()
}

/// `stripHtml` — `client.ts:64-71`.
fn strip_html(value: &str) -> String {
    static STYLE: OnceLock<Regex> = OnceLock::new();
    static SCRIPT: OnceLock<Regex> = OnceLock::new();
    static TAGS: OnceLock<Regex> = OnceLock::new();
    static SPACE: OnceLock<Regex> = OnceLock::new();
    let style = STYLE.get_or_init(|| Regex::new(r"(?is)<style[\s\S]*?</style>").unwrap());
    let script = SCRIPT.get_or_init(|| Regex::new(r"(?is)<script[\s\S]*?</script>").unwrap());
    let tags = TAGS.get_or_init(|| Regex::new(r"<[^>]+>").unwrap());
    let space = SPACE.get_or_init(|| Regex::new(r"\s+").unwrap());
    let stripped = style.replace_all(value, " ").into_owned();
    let stripped = script.replace_all(&stripped, " ").into_owned();
    let stripped = tags.replace_all(&stripped, " ").into_owned();
    space.replace_all(&stripped, " ").trim().to_string()
}

/// `GmailHeaderRow` — `client.ts:73-76`.
#[derive(Debug, Clone, Deserialize)]
struct GmailHeaderRow {
    name: Option<String>,
    value: Option<String>,
}

/// `GmailPayload` — `client.ts:78-84`.
#[derive(Debug, Clone, Deserialize)]
struct GmailPayload {
    #[serde(rename = "mimeType")]
    mime_type: Option<String>,
    /// Part of the Gmail payload shape (`client.ts:80`); not read here.
    #[serde(default)]
    #[allow(dead_code)]
    filename: Option<String>,
    body: Option<GmailBody>,
    headers: Option<Vec<GmailHeaderRow>>,
    parts: Option<Vec<GmailPayload>>,
}

/// `payload.body` — `client.ts:81`.
#[derive(Debug, Clone, Deserialize)]
struct GmailBody {
    data: Option<String>,
    /// Part of the Gmail body shape (`client.ts:81`); not read here.
    #[serde(default)]
    #[allow(dead_code)]
    size: Option<i64>,
}

/// `GmailMessageApi` — `client.ts:86-91`.
#[derive(Debug, Clone, Deserialize)]
struct GmailMessageApi {
    id: String,
    snippet: Option<String>,
    #[serde(rename = "internalDate")]
    internal_date: Option<String>,
    payload: Option<GmailPayload>,
}

/// `{ id: string }` list/draft rows.
#[derive(Debug, Clone, Deserialize)]
struct GmailIdRow {
    id: String,
}

/// `{ messages?: Array<{ id: string }> }`.
#[derive(Debug, Clone, Deserialize)]
struct GmailMessageList {
    messages: Option<Vec<GmailIdRow>>,
}

/// `headerValue` — `client.ts:93-96`.
fn header_value(headers: &[GmailHeaderRow], name: &str) -> String {
    headers
        .iter()
        .find(|row| row.name.as_deref().unwrap_or("").to_lowercase() == name)
        .and_then(|row| row.value.as_deref())
        .unwrap_or("")
        .trim()
        .to_string()
}

/// `firstBodyText` — `client.ts:98-113`.
fn first_body_text(payload: Option<&GmailPayload>) -> String {
    let Some(payload) = payload else {
        return String::new();
    };
    let mime = payload.mime_type.as_deref().unwrap_or("").to_lowercase();
    let body_data = decode_base64url(
        payload
            .body
            .as_ref()
            .and_then(|b| b.data.as_deref())
            .unwrap_or(""),
    );
    if mime.contains("text/plain") && !body_data.is_empty() {
        return body_data;
    }
    if mime.contains("text/html") && !body_data.is_empty() {
        return strip_html(&body_data);
    }
    if let Some(parts) = &payload.parts {
        for part in parts {
            let nested = first_body_text(Some(part));
            if !nested.is_empty() {
                return nested;
            }
        }
    }
    String::new()
}

/// `mapGmailApiMessageToDomain` — `client.ts:115-133`.
fn map_gmail_api_message_to_domain(input: &GmailMessageApi, warning: Option<&str>) -> GmailMessage {
    let headers = input
        .payload
        .as_ref()
        .and_then(|payload| payload.headers.clone())
        .unwrap_or_default();
    let body_text: String = first_body_text(input.payload.as_ref())
        .chars()
        .take(MAX_BODY_CHARS)
        .collect();
    let parsed_date = input
        .internal_date
        .as_deref()
        .unwrap_or("")
        .trim()
        .parse::<f64>()
        .unwrap_or(f64::NAN);
    let created_at = if parsed_date.is_finite() && parsed_date > 0.0 {
        chrono::DateTime::from_timestamp_millis(parsed_date as i64)
            .map(|stamp| stamp.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
            .unwrap_or_else(now_iso)
    } else {
        now_iso()
    };
    GmailMessage {
        id: input.id.clone(),
        from: non_empty_or(header_value(&headers, "from"), "unknown"),
        to: non_empty_or(header_value(&headers, "to"), "me"),
        subject: non_empty_or(header_value(&headers, "subject"), "(metadata unavailable)"),
        body: body_text.clone(),
        body_text: Some(body_text),
        snippet: Some(input.snippet.as_deref().unwrap_or("").trim().to_string()),
        warnings: warning.map(|value| vec![value.to_string()]),
        created_at,
    }
}

/// `headerValue(...) || fallback` — an empty header falls back.
fn non_empty_or(value: String, fallback: &str) -> String {
    if value.is_empty() {
        fallback.to_string()
    } else {
        value
    }
}

/// `mapMetadataMessage` — `client.ts:160-171`.
fn map_metadata_message(id: &str) -> GmailMessage {
    GmailMessage {
        id: id.to_string(),
        from: "unknown".to_string(),
        to: "me".to_string(),
        subject: "(metadata unavailable)".to_string(),
        body: String::new(),
        body_text: Some(String::new()),
        snippet: Some(String::new()),
        warnings: None,
        created_at: now_iso(),
    }
}

/// `fromMockDraft` — `client.ts:173-182`.
fn from_mock_draft(prefix: &str, input: &GmailDraftInput) -> GmailMessage {
    GmailMessage {
        id: format!("{prefix}-{}", uuid::Uuid::new_v4()),
        from: "me@gmail.local".to_string(),
        to: input.to.clone(),
        subject: input.subject.clone(),
        body: input.body.clone(),
        body_text: None,
        snippet: None,
        warnings: None,
        created_at: now_iso(),
    }
}

/// `{ message, warning? }` — the return of `fetchMessageDetails`.
struct MessageDetails {
    message: GmailMessage,
    #[allow(dead_code)]
    warning: Option<String>,
}

/// `fetchMessageDetails` — `client.ts:135-158`.
async fn fetch_message_details(
    transport: &dyn HttpTransport,
    access_token: &str,
    id: &str,
) -> MessageDetails {
    let path = format!("messages/{id}?format=full");
    match gmail_api_fetch::<GmailMessageApi>(transport, access_token, &path, Method::GET, None)
        .await
    {
        Ok(detail) => MessageDetails {
            message: map_gmail_api_message_to_domain(&detail, None),
            warning: None,
        },
        Err(_) => MessageDetails {
            message: GmailMessage {
                id: id.to_string(),
                from: "unknown".to_string(),
                to: "me".to_string(),
                subject: "(metadata unavailable)".to_string(),
                body: String::new(),
                body_text: Some(String::new()),
                snippet: Some(String::new()),
                warnings: Some(vec!["Failed to fetch full message payload.".to_string()]),
                created_at: now_iso(),
            },
            warning: Some(id.to_string()),
        },
    }
}

/// `gmailApiFetch` — `client.ts:35-53`.
async fn gmail_api_fetch<T: for<'de> Deserialize<'de>>(
    transport: &dyn HttpTransport,
    access_token: &str,
    path: &str,
    method: Method,
    body: Option<String>,
) -> Result<T, GmailClientError> {
    let url = format!("https://gmail.googleapis.com/gmail/v1/users/me/{path}");
    let mut request = HttpRequest::new(method, url)
        .header("Authorization", &format!("Bearer {access_token}"))
        .header("Content-Type", "application/json");
    if let Some(body) = body {
        request = request.body(body);
    }
    let response = transport.send(request).await?;
    if !response.is_ok() {
        let truncated: String = response.body.chars().take(300).collect();
        return Err(GmailClientError::Api {
            status: response.status.as_u16(),
            body: truncated,
        });
    }
    serde_json::from_str::<T>(&response.body)
        .map_err(|error| GmailClientError::InvalidBody(error.to_string()))
}

/// The Gmail client — `client.ts:184-283`.
pub struct GmailClient {
    access_token: String,
    mock: bool,
    transport: Arc<dyn HttpTransport>,
    env: MasterEnv,
}

impl GmailClient {
    /// `new GmailClient(accessToken)` — `client.ts:187-192`.
    ///
    /// The empty-token `throw` is [`GmailClientError::MissingAccessToken`]; the
    /// mock decision reads `BETACLAW_MASTER_GMAIL_MODE` from `env`.
    pub fn new(
        access_token: impl Into<String>,
        transport: Arc<dyn HttpTransport>,
        env: MasterEnv,
    ) -> Result<Self, GmailClientError> {
        let access_token = access_token.into();
        if access_token.is_empty() {
            return Err(GmailClientError::MissingAccessToken);
        }
        let mock = is_mock_mode(&access_token, &env);
        Ok(Self {
            access_token,
            mock,
            transport,
            env,
        })
    }

    /// `listMessages` — `client.ts:194-210`.
    pub async fn list_messages(&self, key: &str) -> Result<Vec<GmailMessage>, GmailClientError> {
        if self.mock {
            return Ok(mock_mailbox()
                .lock()
                .unwrap()
                .get(key)
                .cloned()
                .unwrap_or_default());
        }
        let data: GmailMessageList = gmail_api_fetch(
            self.transport.as_ref(),
            &self.access_token,
            "messages?maxResults=20",
            Method::GET,
            None,
        )
        .await?;
        let messages = data.messages.unwrap_or_default();
        if !is_detail_fetch_enabled(&self.env) {
            return Ok(messages
                .iter()
                .map(|entry| map_metadata_message(&entry.id))
                .collect());
        }
        let mut results = Vec::new();
        for entry in messages {
            results.push(
                fetch_message_details(self.transport.as_ref(), &self.access_token, &entry.id)
                    .await
                    .message,
            );
        }
        Ok(results)
    }

    /// `searchMessages` — `client.ts:212-234`.
    pub async fn search_messages(
        &self,
        key: &str,
        query: &str,
    ) -> Result<Vec<GmailMessage>, GmailClientError> {
        if self.mock {
            let normalized = query.to_lowercase();
            let entries = mock_mailbox()
                .lock()
                .unwrap()
                .get(key)
                .cloned()
                .unwrap_or_default();
            return Ok(entries
                .into_iter()
                .filter(|entry| {
                    format!("{}\n{}\n{}", entry.subject, entry.body, entry.to)
                        .to_lowercase()
                        .contains(&normalized)
                })
                .collect());
        }
        let path = format!("messages?maxResults=20&q={}", encode_uri_component(query));
        let data: GmailMessageList = gmail_api_fetch(
            self.transport.as_ref(),
            &self.access_token,
            &path,
            Method::GET,
            None,
        )
        .await?;
        let messages = data.messages.unwrap_or_default();
        if !is_detail_fetch_enabled(&self.env) {
            return Ok(messages
                .iter()
                .map(|entry| map_metadata_message(&entry.id))
                .collect());
        }
        let mut results = Vec::new();
        for entry in messages {
            let mut message =
                fetch_message_details(self.transport.as_ref(), &self.access_token, &entry.id)
                    .await
                    .message;
            if message.subject.is_empty() {
                message.subject = format!("Search match for: {query}");
            }
            results.push(message);
        }
        Ok(results)
    }

    /// `createDraft` — `client.ts:236-257`.
    pub async fn create_draft(
        &self,
        input: &GmailDraftInput,
    ) -> Result<GmailMessage, GmailClientError> {
        if self.mock {
            return Ok(from_mock_draft("draft", input));
        }
        let payload = serde_json::json!({ "message": { "raw": to_raw_mime(input) } });
        let data: GmailIdRow = gmail_api_fetch(
            self.transport.as_ref(),
            &self.access_token,
            "drafts",
            Method::POST,
            Some(payload.to_string()),
        )
        .await?;
        Ok(real_draft_message(data.id, input))
    }

    /// `sendMessage` — `client.ts:259-282`.
    pub async fn send_message(
        &self,
        key: &str,
        input: &GmailDraftInput,
    ) -> Result<GmailMessage, GmailClientError> {
        if self.mock {
            let sent = from_mock_draft("sent", input);
            mock_mailbox()
                .lock()
                .unwrap()
                .entry(key.to_string())
                .or_default()
                .push(sent.clone());
            return Ok(sent);
        }
        let payload = serde_json::json!({ "raw": to_raw_mime(input) });
        let data: GmailIdRow = gmail_api_fetch(
            self.transport.as_ref(),
            &self.access_token,
            "messages/send",
            Method::POST,
            Some(payload.to_string()),
        )
        .await?;
        Ok(real_draft_message(data.id, input))
    }
}

/// The real-mode `createDraft`/`sendMessage` result literal (`from: 'me'`).
fn real_draft_message(id: String, input: &GmailDraftInput) -> GmailMessage {
    GmailMessage {
        id,
        from: "me".to_string(),
        to: input.to.clone(),
        subject: input.subject.clone(),
        body: input.body.clone(),
        body_text: None,
        snippet: None,
        warnings: None,
        created_at: now_iso(),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use http::StatusCode;

    use super::*;
    use crate::model_hub::http::{BoxFuture, HttpResponse};

    struct StubTransport {
        responses: Mutex<VecDeque<(StatusCode, String)>>,
        requests: Mutex<Vec<HttpRequest>>,
    }

    impl StubTransport {
        fn new(responses: Vec<(StatusCode, String)>) -> Arc<Self> {
            Arc::new(Self {
                responses: Mutex::new(responses.into()),
                requests: Mutex::new(Vec::new()),
            })
        }
    }

    impl HttpTransport for StubTransport {
        fn send<'a>(
            &'a self,
            request: HttpRequest,
        ) -> BoxFuture<'a, Result<HttpResponse, HttpError>> {
            Box::pin(async move {
                self.requests.lock().unwrap().push(request);
                let (status, body) = self
                    .responses
                    .lock()
                    .unwrap()
                    .pop_front()
                    .expect("scripted response");
                Ok(HttpResponse::text(status, body))
            })
        }
    }

    fn draft() -> GmailDraftInput {
        GmailDraftInput {
            to: "a@example.com".to_string(),
            subject: "hi".to_string(),
            body: "body".to_string(),
        }
    }

    #[test]
    fn an_empty_token_is_rejected() {
        let transport: Arc<dyn HttpTransport> = StubTransport::new(Vec::new());
        let result = GmailClient::new("", transport, MasterEnv::new());
        assert!(matches!(result, Err(GmailClientError::MissingAccessToken)));
        assert_eq!(
            GmailClientError::MissingAccessToken.to_string(),
            "Missing Gmail access token."
        );
    }

    #[test]
    fn the_raw_mime_is_base64url_of_the_crlf_payload() {
        let expected = "To: a@example.com\r\nSubject: hi\r\nContent-Type: text/plain; charset=\"UTF-8\"\r\n\r\nbody";
        assert_eq!(
            to_raw_mime(&draft()),
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(expected.as_bytes())
        );
    }

    #[test]
    fn detail_fetch_defaults_on_and_reads_the_off_spellings() {
        assert!(is_detail_fetch_enabled(&MasterEnv::new()));
        let mut env = MasterEnv::new();
        env.insert("MASTER_GMAIL_FETCH_DETAILS".to_string(), "0".to_string());
        assert!(!is_detail_fetch_enabled(&env));
        env.insert("MASTER_GMAIL_FETCH_DETAILS".to_string(), "off".to_string());
        assert!(!is_detail_fetch_enabled(&env));
        env.insert("MASTER_GMAIL_FETCH_DETAILS".to_string(), "yes".to_string());
        assert!(is_detail_fetch_enabled(&env));
    }

    #[tokio::test]
    async fn a_mock_token_sends_and_lists() {
        reset_gmail_client_state();
        let transport: Arc<dyn HttpTransport> = StubTransport::new(Vec::new());
        let client = GmailClient::new("mock:abc", transport, MasterEnv::new()).unwrap();
        let sent = client.send_message("s1", &draft()).await.unwrap();
        assert!(sent.id.starts_with("sent-"));
        assert_eq!(sent.from, "me@gmail.local");
        let listed = client.list_messages("s1").await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, sent.id);
    }

    #[tokio::test]
    async fn the_mock_env_flag_forces_mock_mode() {
        let mut env = MasterEnv::new();
        env.insert("BETACLAW_MASTER_GMAIL_MODE".to_string(), "mock".to_string());
        let transport: Arc<dyn HttpTransport> = StubTransport::new(Vec::new());
        let client = GmailClient::new("real-token", transport, env).unwrap();
        let created = client.create_draft(&draft()).await.unwrap();
        assert!(created.id.starts_with("draft-"));
        assert_eq!(created.from, "me@gmail.local");
    }

    #[tokio::test]
    async fn real_mode_lists_metadata_without_details() {
        let mut env = MasterEnv::new();
        env.insert("MASTER_GMAIL_FETCH_DETAILS".to_string(), "0".to_string());
        let transport = StubTransport::new(vec![(
            StatusCode::OK,
            "{\"messages\":[{\"id\":\"m1\"}]}".to_string(),
        )]);
        let client = GmailClient::new("real-token", transport.clone(), env).unwrap();
        let listed = client.list_messages("k").await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "m1");
        assert_eq!(listed[0].subject, "(metadata unavailable)");
        assert_eq!(listed[0].from, "unknown");
        let requests = transport.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert!(requests[0]
            .url
            .ends_with("/users/me/messages?maxResults=20"));
        assert_eq!(
            requests[0]
                .headers
                .get("authorization")
                .unwrap()
                .to_str()
                .unwrap(),
            "Bearer real-token"
        );
    }

    #[tokio::test]
    async fn real_mode_fetches_the_full_detail() {
        let detail = "{\"id\":\"m1\",\"snippet\":\"  snip  \",\"internalDate\":\"1710000000000\",\
                      \"payload\":{\"mimeType\":\"text/plain\",\"headers\":[\
                      {\"name\":\"From\",\"value\":\"a@b\"},{\"name\":\"Subject\",\"value\":\"Hello\"}],\
                      \"body\":{\"data\":\"SGk\"}}}";
        let transport = StubTransport::new(vec![
            (
                StatusCode::OK,
                "{\"messages\":[{\"id\":\"m1\"}]}".to_string(),
            ),
            (StatusCode::OK, detail.to_string()),
        ]);
        let client = GmailClient::new("real-token", transport, MasterEnv::new()).unwrap();
        let listed = client.list_messages("k").await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].from, "a@b");
        assert_eq!(listed[0].subject, "Hello");
        assert_eq!(listed[0].body, "Hi");
        assert_eq!(listed[0].snippet.as_deref(), Some("snip"));
        assert!(listed[0].created_at.starts_with("2024-03-09"));
    }

    #[tokio::test]
    async fn a_failing_detail_fetch_falls_back_to_a_warning() {
        let transport = StubTransport::new(vec![
            (
                StatusCode::OK,
                "{\"messages\":[{\"id\":\"m1\"}]}".to_string(),
            ),
            (StatusCode::INTERNAL_SERVER_ERROR, "boom".to_string()),
        ]);
        let client = GmailClient::new("real-token", transport, MasterEnv::new()).unwrap();
        let listed = client.list_messages("k").await.unwrap();
        assert_eq!(
            listed[0].warnings.as_deref(),
            Some(["Failed to fetch full message payload.".to_string()].as_slice())
        );
    }

    #[tokio::test]
    async fn an_api_error_carries_the_status_and_body() {
        let transport = StubTransport::new(vec![(
            StatusCode::INTERNAL_SERVER_ERROR,
            "boom".to_string(),
        )]);
        let client = GmailClient::new("real-token", transport, MasterEnv::new()).unwrap();
        let error = client.list_messages("k").await.unwrap_err();
        assert_eq!(error.to_string(), "Gmail API 500: boom");
    }

    #[tokio::test]
    async fn search_encodes_the_query() {
        let mut env = MasterEnv::new();
        env.insert("MASTER_GMAIL_FETCH_DETAILS".to_string(), "0".to_string());
        let transport = StubTransport::new(vec![(StatusCode::OK, "{\"messages\":[]}".to_string())]);
        let client = GmailClient::new("real-token", transport.clone(), env).unwrap();
        client.search_messages("k", "a b&c").await.unwrap();
        let requests = transport.requests.lock().unwrap();
        assert!(requests[0].url.ends_with("q=a%20b%26c"));
    }

    #[tokio::test]
    async fn search_filters_the_mock_mailbox() {
        reset_gmail_client_state();
        let transport: Arc<dyn HttpTransport> = StubTransport::new(Vec::new());
        let client = GmailClient::new("test-token", transport, MasterEnv::new()).unwrap();
        let mut alpha = draft();
        alpha.subject = "alpha".to_string();
        let mut beta = draft();
        beta.subject = "beta".to_string();
        client.send_message("f1", &alpha).await.unwrap();
        client.send_message("f1", &beta).await.unwrap();
        let found = client.search_messages("f1", "alph").await.unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].subject, "alpha");
    }

    #[tokio::test]
    async fn reset_clears_the_mailbox() {
        let transport: Arc<dyn HttpTransport> = StubTransport::new(Vec::new());
        let client = GmailClient::new("test-token", transport, MasterEnv::new()).unwrap();
        client.send_message("r1", &draft()).await.unwrap();
        assert_eq!(client.list_messages("r1").await.unwrap().len(), 1);
        reset_gmail_client_state();
        assert!(client.list_messages("r1").await.unwrap().is_empty());
    }
}
