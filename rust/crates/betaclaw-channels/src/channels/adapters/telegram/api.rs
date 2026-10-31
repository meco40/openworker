//! Port of the Telegram Bot API plumbing:
//! - `telegram/allowedUpdates.ts` (the `allowed_updates` list),
//! - `postTelegramApi` in `outbound/telegram.ts` (retry on 429 and 5xx),
//! - `callTelegramApi` in `telegram/nativeCommands.ts` (non-2xx becomes an error),
//! - the direct `fetch` calls of `pairing/telegram*.ts` and `pairing/unpair.ts`.
//!
//! The bot token is part of the URL path, as in the TypeScript code. This module
//! never writes it to a log line. Transport errors pass through unchanged, so the
//! transport must keep the request URL, and with it the token, out of its error
//! text.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::channels::adapters::types::{json_text, response_json, ChannelError};
use crate::model_hub::http::{
    fetch_with_timeout, HttpError, HttpRequest, HttpResponse, HttpTransport,
};

pub const TELEGRAM_API_BASE: &str = "https://api.telegram.org";
/// `TELEGRAM_ALLOWED_UPDATES` in `allowedUpdates.ts`.
pub const TELEGRAM_ALLOWED_UPDATES: [&str; 2] = ["message", "callback_query"];

const MAX_ATTEMPTS: u32 = 3;
const BASE_BACKOFF: Duration = Duration::from_millis(250);

/// `serializeTelegramAllowedUpdates()` as a JSON array, for request bodies.
pub fn allowed_updates() -> Value {
    json!(TELEGRAM_ALLOWED_UPDATES)
}

/// `https://api.telegram.org/bot<token>/<method>`.
pub fn method_url(token: &str, method: &str) -> String {
    format!("{TELEGRAM_API_BASE}/bot{token}/{method}")
}

#[derive(Clone)]
pub struct TelegramApi {
    transport: Arc<dyn HttpTransport>,
    backoff: Duration,
}

impl TelegramApi {
    pub fn new(transport: Arc<dyn HttpTransport>) -> Self {
        Self {
            transport,
            backoff: BASE_BACKOFF,
        }
    }

    /// Shortens the retry back-off, for tests.
    pub fn with_backoff(mut self, backoff: Duration) -> Self {
        self.backoff = backoff;
        self
    }

    /// `fetch(url)` without a body, as `getMe` is called.
    pub async fn get(&self, token: &str, method: &str) -> Result<HttpResponse, HttpError> {
        let request = HttpRequest::get(method_url(token, method));
        fetch_with_timeout(self.transport.as_ref(), request).await
    }

    /// One POST with a JSON body.
    pub async fn post(
        &self,
        token: &str,
        method: &str,
        payload: &Value,
    ) -> Result<HttpResponse, HttpError> {
        let request = HttpRequest::post(method_url(token, method))
            .header("Content-Type", "application/json")
            .json_body(payload);
        fetch_with_timeout(self.transport.as_ref(), request).await
    }

    /// `postTelegramApi`: a 429 or 5xx answer and a transport error are retried
    /// up to three times with doubling back-off. The last answer is returned.
    pub async fn post_with_retry(
        &self,
        token: &str,
        method: &str,
        payload: &Value,
    ) -> Result<HttpResponse, HttpError> {
        let mut attempt: u32 = 1;
        loop {
            let result = self.post(token, method, payload).await;
            let retry = match &result {
                Ok(response) => {
                    !response.is_ok()
                        && is_retryable(response.status.as_u16())
                        && attempt < MAX_ATTEMPTS
                }
                Err(_) => attempt < MAX_ATTEMPTS,
            };
            if !retry {
                return result;
            }
            tokio::time::sleep(self.backoff * 2u32.pow(attempt - 1)).await;
            attempt += 1;
        }
    }

    /// `callTelegramApi`: a non-2xx answer becomes `<method> failed: <body>`.
    pub async fn call_checked(
        &self,
        token: &str,
        method: &str,
        payload: &Value,
    ) -> Result<HttpResponse, ChannelError> {
        let response = self.post(token, method, payload).await?;
        if response.is_ok() {
            return Ok(response);
        }
        Err(ChannelError::new(format!(
            "{method} failed: {}",
            json_text(&response_json(&response))
        )))
    }
}

fn is_retryable(status: u16) -> bool {
    status == 429 || status >= 500
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channels::pairing::test_support::{json_response, ScriptedTransport};

    #[test]
    fn allowed_updates_match_the_typescript_list() {
        assert_eq!(allowed_updates(), json!(["message", "callback_query"]));
    }

    #[tokio::test]
    async fn a_server_error_is_retried_until_it_succeeds() {
        let transport = ScriptedTransport::new();
        transport.then("sendMessage", json_response(500, json!({"ok": false})));
        transport.then("sendMessage", json_response(200, json!({"ok": true})));
        let api = TelegramApi::new(transport.clone()).with_backoff(Duration::ZERO);

        let response = api
            .post_with_retry("1:t", "sendMessage", &json!({}))
            .await
            .expect("transport answers");

        assert!(response.is_ok());
        assert_eq!(transport.calls("sendMessage").len(), 2);
    }

    #[tokio::test]
    async fn a_client_error_is_not_retried() {
        let transport = ScriptedTransport::new();
        transport.then("sendMessage", json_response(400, json!({"ok": false})));
        let api = TelegramApi::new(transport.clone()).with_backoff(Duration::ZERO);

        let response = api
            .post_with_retry("1:t", "sendMessage", &json!({}))
            .await
            .expect("transport answers");

        assert_eq!(response.status.as_u16(), 400);
        assert_eq!(transport.calls("sendMessage").len(), 1);
    }

    #[tokio::test]
    async fn call_checked_names_the_method_and_the_body() {
        let transport = ScriptedTransport::new();
        transport.then(
            "setMyCommands",
            json_response(400, json!({"description": "bad"})),
        );
        let api = TelegramApi::new(transport.clone());

        let error = api
            .call_checked("1:t", "setMyCommands", &json!({}))
            .await
            .expect_err("a 400 is an error");

        assert_eq!(error.0, r#"setMyCommands failed: {"description":"bad"}"#);
    }
}
