//! Port of `src/server/skills/handlers/notifications.ts`.
//!
//! `webhook_send` POSTs JSON to a URL through the SSRF guard, without redirects. `email_send`
//! hands the message to a [`MailTransport`]. Both actions need
//! `BETACLAW_NOTIFICATIONS_ENABLED=true`. The caller performs that check, as the exact string
//! comparison TypeScript uses, and passes the result in `NotificationsConfig::enabled`.
//!
//! Not ported: the SMTP client (nodemailer). The crate has no SMTP library, and new crates are
//! outside this slice. [`MailTransport`] is the trait port. A production implementation is a
//! follow-up.
//!
//! Deviations:
//! - TypeScript sets no timeout on the webhook. This port uses
//!   [`UNBOUNDED_FETCH_CAP_MS`], which matches undici's default headers timeout.
//! - A `SMTP_PORT` that does not start with digits falls back to 587. Nodemailer would fail on
//!   `NaN` instead.

use http::header::{HeaderName, HeaderValue};
use serde_json::{json, Map, Value};

use super::http_text::js_slice_to;
use super::types::{arg_string, js_string_or_empty, js_to_string, SkillError};
use crate::model_hub::http::{BoxFuture, HttpRequest, HttpTransport};
use crate::net_guard::ssrf_guard::{
    check_body_limit, fetch_with_ssrf_guard, Resolver, UNBOUNDED_FETCH_CAP_MS,
};

const WEBHOOK_BODY_LIMIT_BYTES: usize = 64_000;
const WEBHOOK_BODY_EXCERPT_CHARS: usize = 2_000;
const DEFAULT_SMTP_PORT: u16 = 587;
const WEBHOOK_DISABLED: &str =
    "Webhook skill disabled. Set BETACLAW_NOTIFICATIONS_ENABLED=true to enable.";
const EMAIL_DISABLED: &str =
    "Email skill disabled. Set BETACLAW_NOTIFICATIONS_ENABLED=true to enable.";
const SMTP_MISSING: &str = "SMTP not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS (and optionally SMTP_PORT, SMTP_FROM) environment variables.";

/// The `SMTP_*` settings `sendEmail` reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SmtpSettings {
    pub host: String,
    pub port: u16,
    /// `SMTP_PORT === '465'`.
    pub secure: bool,
    pub user: String,
    pub pass: String,
    pub from: Option<String>,
}

impl SmtpSettings {
    /// Builds the settings from the raw variable values. `None` when the host, the user or
    /// the password is missing or empty, which is the TypeScript check.
    pub fn from_env(
        host: Option<&str>,
        port: Option<&str>,
        user: Option<&str>,
        pass: Option<&str>,
        from: Option<&str>,
    ) -> Option<Self> {
        let host = non_empty(host)?;
        let user = non_empty(user)?;
        let pass = non_empty(pass)?;
        let port_text = port.unwrap_or("");
        let port = if port_text.is_empty() {
            DEFAULT_SMTP_PORT
        } else {
            let digits: String = port_text
                .trim_start()
                .chars()
                .take_while(char::is_ascii_digit)
                .collect();
            digits.parse::<u16>().unwrap_or(DEFAULT_SMTP_PORT)
        };
        Some(Self {
            host: host.to_string(),
            port,
            secure: port_text == "465",
            user: user.to_string(),
            pass: pass.to_string(),
            from: non_empty(from).map(str::to_string),
        })
    }
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.filter(|text| !text.is_empty())
}

/// What `sendMail` is given.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MailMessage {
    pub from: String,
    pub to: String,
    pub subject: String,
    pub text: String,
}

/// What `sendMail` answers with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MailReceipt {
    pub message_id: String,
    pub accepted: Vec<String>,
    pub rejected: Vec<String>,
}

/// The SMTP seam. The production client is a follow-up (see the module note).
pub trait MailTransport: Send + Sync {
    fn send<'a>(
        &'a self,
        settings: &'a SmtpSettings,
        message: MailMessage,
    ) -> BoxFuture<'a, Result<MailReceipt, SkillError>>;
}

/// The two inputs the handler reads from the environment, passed in by the caller.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NotificationsConfig {
    /// `BETACLAW_NOTIFICATIONS_ENABLED === 'true'`.
    pub enabled: bool,
    pub smtp: Option<SmtpSettings>,
}

/// `notificationsHandler`.
pub async fn notifications(
    transport: &dyn HttpTransport,
    resolver: &dyn Resolver,
    mail: &dyn MailTransport,
    config: &NotificationsConfig,
    args: &Map<String, Value>,
) -> Result<Value, SkillError> {
    let action = args
        .get("action")
        .map(js_to_string)
        .unwrap_or_else(|| "undefined".to_string());

    match action.as_str() {
        "webhook_send" => {
            let url = arg_string(args, "url");
            if url.is_empty() {
                return Ok(json!({ "error": "url is required for webhook_send" }));
            }
            let payload = match args.get("payload") {
                None | Some(Value::Null) => json!({}),
                Some(value) => value.clone(),
            };
            send_webhook(
                transport,
                resolver,
                config.enabled,
                &url,
                &payload,
                args.get("headers"),
            )
            .await
        }
        "email_send" => {
            let to = recipients(args.get("to"));
            if to.is_empty() {
                return Ok(json!({ "error": "to is required for email_send" }));
            }
            let subject = arg_string(args, "subject");
            if subject.is_empty() {
                return Ok(json!({ "error": "subject is required for email_send" }));
            }
            let body = arg_string(args, "body");
            if body.is_empty() {
                return Ok(json!({ "error": "body is required for email_send" }));
            }
            let from = arg_string(args, "from");
            send_email(
                mail,
                config,
                &EmailParts {
                    to,
                    subject,
                    body,
                    from,
                },
            )
            .await
        }
        _ => Ok(json!({
            "error": format!("Unknown action: {action}. Valid: webhook_send, email_send")
        })),
    }
}

async fn send_webhook(
    transport: &dyn HttpTransport,
    resolver: &dyn Resolver,
    enabled: bool,
    url: &str,
    payload: &Value,
    headers: Option<&Value>,
) -> Result<Value, SkillError> {
    if !enabled {
        return Ok(json!({ "error": WEBHOOK_DISABLED }));
    }
    let body = serde_json::to_string(payload).unwrap_or_default();
    let mut request = HttpRequest::post(url)
        .header("Content-Type", "application/json")
        .timeout_ms(UNBOUNDED_FETCH_CAP_MS)
        .body(body);
    // `{ 'Content-Type': 'application/json', ...headers }`: custom headers win.
    if let Some(Value::Object(custom)) = headers {
        for (name, value) in custom {
            insert_header(&mut request, name, &js_to_string(value))?;
        }
    }

    let guarded = fetch_with_ssrf_guard(transport, resolver, request, 0)
        .await
        .map_err(|error| SkillError(error.to_string()))?;
    // `readResponseTextLimited(...).catch(() => '')`: an over-limit body reads as empty.
    let text = match check_body_limit(&guarded.response, WEBHOOK_BODY_LIMIT_BYTES) {
        Ok(()) => guarded.response.body.as_str(),
        Err(_) => "",
    };
    Ok(json!({
        "status": guarded.response.status.as_u16(),
        "statusText": guarded.response.status_text,
        "body": js_slice_to(text, WEBHOOK_BODY_EXCERPT_CHARS as i64),
    }))
}

fn insert_header(request: &mut HttpRequest, name: &str, value: &str) -> Result<(), SkillError> {
    let header_name = HeaderName::from_bytes(name.as_bytes()).map_err(|_| {
        SkillError(format!(
            "Headers.append: \"{name}\" is an invalid header name."
        ))
    })?;
    let header_value = HeaderValue::from_str(value).map_err(|_| {
        SkillError(format!(
            "Headers.append: \"{value}\" is an invalid header value."
        ))
    })?;
    request.headers.insert(header_name, header_value);
    Ok(())
}

struct EmailParts {
    to: String,
    subject: String,
    body: String,
    from: String,
}

async fn send_email(
    mail: &dyn MailTransport,
    config: &NotificationsConfig,
    parts: &EmailParts,
) -> Result<Value, SkillError> {
    if !config.enabled {
        return Ok(json!({ "error": EMAIL_DISABLED }));
    }
    let Some(smtp) = config.smtp.as_ref() else {
        return Ok(json!({ "error": SMTP_MISSING }));
    };
    // `from || SMTP_FROM || SMTP_USER`
    let from = if !parts.from.is_empty() {
        parts.from.clone()
    } else if let Some(configured) = smtp.from.as_deref() {
        configured.to_string()
    } else {
        smtp.user.clone()
    };
    let receipt = mail
        .send(
            smtp,
            MailMessage {
                from,
                to: parts.to.clone(),
                subject: parts.subject.clone(),
                text: parts.body.clone(),
            },
        )
        .await?;
    Ok(json!({
        "messageId": receipt.message_id,
        "accepted": receipt.accepted,
        "rejected": receipt.rejected,
    }))
}

/// `Array.isArray(to) ? to.join(', ') : to`. A null element joins as an empty string.
fn recipients(value: Option<&Value>) -> String {
    match value {
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_to_string(other),
            })
            .collect::<Vec<_>>()
            .join(", "),
        Some(other) => js_string_or_empty(other),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::net_guard::test_support::{response_with, FakeResolver, FakeTransport};

    #[derive(Default)]
    struct FakeMail {
        sent: Mutex<Vec<MailMessage>>,
    }

    impl MailTransport for FakeMail {
        fn send<'a>(
            &'a self,
            _settings: &'a SmtpSettings,
            message: MailMessage,
        ) -> BoxFuture<'a, Result<MailReceipt, SkillError>> {
            Box::pin(async move {
                let receipt = MailReceipt {
                    message_id: "<m1@test>".to_string(),
                    accepted: vec![message.to.clone()],
                    rejected: Vec::new(),
                };
                self.sent.lock().expect("sent lock").push(message);
                Ok(receipt)
            })
        }
    }

    fn resolver() -> FakeResolver {
        FakeResolver::with(vec![("hooks.test", vec!["93.184.216.34"])])
    }

    fn args(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    fn smtp() -> SmtpSettings {
        SmtpSettings::from_env(Some("smtp.test"), None, Some("bot"), Some("pw"), None)
            .expect("complete settings")
    }

    fn enabled() -> NotificationsConfig {
        NotificationsConfig {
            enabled: true,
            smtp: Some(smtp()),
        }
    }

    #[test]
    fn smtp_settings_follow_the_environment_rules() {
        let defaults = smtp();
        assert_eq!(defaults.port, 587);
        assert!(!defaults.secure);
        assert_eq!(defaults.from, None);
        let implicit = SmtpSettings::from_env(
            Some("h"),
            Some("465"),
            Some("u"),
            Some("p"),
            Some("f@x.test"),
        )
        .expect("settings");
        assert_eq!(implicit.port, 465);
        assert!(implicit.secure);
        assert_eq!(implicit.from.as_deref(), Some("f@x.test"));
        assert_eq!(
            SmtpSettings::from_env(Some("h"), None, Some("u"), None, None),
            None
        );
        assert_eq!(
            SmtpSettings::from_env(Some("h"), Some("abc"), Some("u"), Some("p"), None)
                .map(|s| s.port),
            Some(587)
        );
    }

    #[tokio::test]
    async fn the_webhook_needs_the_flag_and_a_url() {
        let transport = FakeTransport::with(vec![]);
        let disabled = NotificationsConfig::default();
        let out = notifications(
            &transport,
            &resolver(),
            &FakeMail::default(),
            &disabled,
            &args(json!({"action": "webhook_send", "url": "https://hooks.test/"})),
        )
        .await
        .expect("ok");
        assert_eq!(out["error"], WEBHOOK_DISABLED);
        let out = notifications(
            &transport,
            &resolver(),
            &FakeMail::default(),
            &enabled(),
            &args(json!({"action": "webhook_send"})),
        )
        .await
        .expect("ok");
        assert_eq!(out, json!({ "error": "url is required for webhook_send" }));
        assert!(transport.requests().is_empty());
    }

    #[tokio::test]
    async fn a_webhook_post_carries_the_payload_and_custom_headers_and_trims_the_reply() {
        let long = "b".repeat(3_000);
        let transport = FakeTransport::with(vec![Ok(response_with(200, &[], &long))]);
        let out = notifications(
            &transport,
            &resolver(),
            &FakeMail::default(),
            &enabled(),
            &args(json!({
                "action": "webhook_send",
                "url": "https://hooks.test/in",
                "payload": {"event": "x"},
                "headers": {"Content-Type": "text/plain", "X-Sig": "abc"}
            })),
        )
        .await
        .expect("ok");
        assert_eq!(out["status"], 200);
        assert_eq!(
            out["body"].as_str().map(str::len),
            Some(WEBHOOK_BODY_EXCERPT_CHARS)
        );
        let sent = &transport.requests()[0];
        assert_eq!(sent.body.as_deref(), Some("{\"event\":\"x\"}"));
        assert_eq!(
            sent.headers.get("content-type").expect("content type"),
            "text/plain"
        );
        assert_eq!(sent.headers.get("x-sig").expect("signature"), "abc");
    }

    #[tokio::test]
    async fn a_webhook_to_a_private_address_is_refused() {
        let transport = FakeTransport::with(vec![]);
        let error = notifications(
            &transport,
            &resolver(),
            &FakeMail::default(),
            &enabled(),
            &args(json!({"action": "webhook_send", "url": "http://10.0.0.7/hook"})),
        )
        .await
        .unwrap_err();
        assert_eq!(
            error.0,
            "SSRF guard: blocked private/loopback address \"10.0.0.7\""
        );
        assert!(transport.requests().is_empty());
    }

    #[tokio::test]
    async fn email_is_sent_through_the_mail_seam_with_the_configured_sender() {
        let mail = FakeMail::default();
        let out = notifications(
            &FakeTransport::with(vec![]),
            &resolver(),
            &mail,
            &enabled(),
            &args(json!({
                "action": "email_send",
                "to": ["a@x.test", "b@x.test"],
                "subject": "Hi",
                "body": "Text"
            })),
        )
        .await
        .expect("ok");
        assert_eq!(out["messageId"], "<m1@test>");
        assert_eq!(out["accepted"], json!(["a@x.test, b@x.test"]));
        let sent = mail.sent.lock().expect("sent").clone();
        assert_eq!(sent.len(), 1);
        assert_eq!(
            sent[0].from, "bot",
            "SMTP_USER is the last fallback for the sender"
        );
        assert_eq!(sent[0].to, "a@x.test, b@x.test");
        assert_eq!(sent[0].text, "Text");
    }

    #[tokio::test]
    async fn email_reports_missing_settings_and_missing_fields() {
        let out = notifications(
            &FakeTransport::with(vec![]),
            &resolver(),
            &FakeMail::default(),
            &NotificationsConfig {
                enabled: true,
                smtp: None,
            },
            &args(json!({"action": "email_send", "to": "a@x.test", "subject": "s", "body": "b"})),
        )
        .await
        .expect("ok");
        assert_eq!(out["error"], SMTP_MISSING);
        let out = notifications(
            &FakeTransport::with(vec![]),
            &resolver(),
            &FakeMail::default(),
            &enabled(),
            &args(json!({"action": "email_send", "subject": "s", "body": "b"})),
        )
        .await
        .expect("ok");
        assert_eq!(out, json!({ "error": "to is required for email_send" }));
    }

    #[tokio::test]
    async fn an_unknown_action_lists_the_valid_ones() {
        let out = notifications(
            &FakeTransport::with(vec![]),
            &resolver(),
            &FakeMail::default(),
            &enabled(),
            &args(json!({"action": "sms"})),
        )
        .await
        .expect("ok");
        assert_eq!(
            out,
            json!({ "error": "Unknown action: sms. Valid: webhook_send, email_send" })
        );
    }
}
