//! Port of `src/server/channels/outbound/telegram.ts`, together with the token
//! order of its `resolveTelegramToken`.
//!
//! Token order is the TypeScript order: explicit token, persona bot token,
//! credential store, `TELEGRAM_BOT_TOKEN`. The persona bot registry is not
//! ported here; the caller passes the token it found in `persona_token`.
//!
//! Message length is counted in UTF-16 code units, as JavaScript counts
//! `string.length`. A split never separates the two halves of a surrogate pair,
//! where JavaScript could; the port stops before such a character instead.

use std::sync::Arc;

use serde::Serialize;
use serde_json::{json, Map, Value};
use tracing::{error, warn};

use super::api::TelegramApi;
use super::targets::{parse_telegram_target, ChatType, TelegramTarget};
use crate::channels::adapters::types::{
    json_text, non_empty, response_json, value_as_id, ChannelError,
};
use crate::channels::pairing::credentials::{ChannelCredentialStore, ChannelEnv};

/// `TELEGRAM_MAX_LENGTH`.
pub const TELEGRAM_MAX_LENGTH: usize = 4096;
/// `TELEGRAM_MAX_CALLBACK_DATA_BYTES`.
const TELEGRAM_MAX_CALLBACK_DATA_BYTES: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InlineKeyboardButton {
    pub text: String,
    pub callback_data: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TelegramReplyMarkup {
    pub inline_keyboard: Vec<Vec<InlineKeyboardButton>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParseMode {
    Html,
    MarkdownV2,
}

impl ParseMode {
    fn as_str(self) -> &'static str {
        match self {
            ParseMode::Html => "HTML",
            ParseMode::MarkdownV2 => "MarkdownV2",
        }
    }
}

/// `TelegramTextOptions`.
#[derive(Debug, Clone, Default)]
pub struct TelegramTextOptions {
    pub reply_markup: Option<TelegramReplyMarkup>,
    pub parse_mode: Option<ParseMode>,
    /// `None` and `Some(true)` send `disable_web_page_preview: true`;
    /// `Some(false)` leaves the field out, as the source does.
    pub disable_web_page_preview: Option<bool>,
    /// Explicit bot token. It takes priority over every other source.
    pub token: Option<String>,
    /// Token of a persona-bound bot, looked up by the caller.
    pub persona_token: Option<String>,
}

/// `formatTelegramText`: line endings become `\n` and NUL characters are dropped.
pub fn format_telegram_text(text: &str) -> String {
    text.replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace('\0', "")
}

fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// Byte index of the longest prefix of `text` that fits in `units` UTF-16 code
/// units. The index is always a character boundary.
fn prefix_end(text: &str, units: usize) -> usize {
    let mut used = 0;
    for (index, ch) in text.char_indices() {
        used += ch.len_utf16();
        if used > units {
            return index;
        }
    }
    text.len()
}

/// `splitTelegramMessage`: prefers to cut at the last newline, then at the last
/// space, and cuts hard only when neither occurs in the window.
pub fn split_telegram_message(text: &str, max_len: usize) -> Vec<String> {
    if utf16_len(text) <= max_len {
        return vec![text.to_string()];
    }

    let mut chunks = Vec::new();
    let mut remaining = text;
    while !remaining.is_empty() {
        if utf16_len(remaining) <= max_len {
            chunks.push(remaining.to_string());
            break;
        }

        let mut cut = prefix_end(remaining, max_len);
        if cut == 0 {
            // A single character longer than the window still makes progress.
            cut = remaining.chars().next().map_or(0, char::len_utf8);
        }
        let candidate = &remaining[..cut];
        // A separator at index 0 does not count, as in `splitAt <= 0`.
        let split_at = candidate
            .rfind('\n')
            .filter(|&index| index > 0)
            .or_else(|| candidate.rfind(' ').filter(|&index| index > 0))
            .unwrap_or(cut);

        chunks.push(remaining[..split_at].to_string());
        let rest = &remaining[split_at..];
        remaining = rest.strip_prefix('\n').unwrap_or(rest);
    }
    chunks
}

/// `buildInlineKeyboard`: drops empty buttons and buttons whose callback data is
/// longer than 64 bytes, then drops rows that became empty.
pub fn build_inline_keyboard(rows: Vec<Vec<InlineKeyboardButton>>) -> Option<TelegramReplyMarkup> {
    let inline_keyboard: Vec<Vec<InlineKeyboardButton>> = rows
        .into_iter()
        .map(|row| {
            row.into_iter()
                .map(|button| InlineKeyboardButton {
                    text: button.text.trim().to_string(),
                    callback_data: button.callback_data.trim().to_string(),
                })
                .filter(|button| {
                    !button.text.is_empty()
                        && !button.callback_data.is_empty()
                        && button.callback_data.len() <= TELEGRAM_MAX_CALLBACK_DATA_BYTES
                })
                .collect::<Vec<_>>()
        })
        .filter(|row| !row.is_empty())
        .collect();
    if inline_keyboard.is_empty() {
        None
    } else {
        Some(TelegramReplyMarkup { inline_keyboard })
    }
}

/// The thread id that is sent. Thread 1 of a group is the general topic, which
/// is sent without a thread id.
fn message_thread_for(target: &TelegramTarget) -> Option<i64> {
    match target.message_thread_id {
        Some(1) if target.chat_type == ChatType::Group => None,
        other => other,
    }
}

/// The fields `sendMessage` and `editMessageText` share.
fn add_send_fields(
    payload: &mut Map<String, Value>,
    options: &TelegramTextOptions,
    thread: Option<i64>,
) {
    if let Some(mode) = options.parse_mode {
        payload.insert("parse_mode".into(), json!(mode.as_str()));
    }
    if options.disable_web_page_preview != Some(false) {
        payload.insert("disable_web_page_preview".into(), json!(true));
    }
    if let Some(thread) = thread.filter(|thread| *thread > 0) {
        payload.insert("message_thread_id".into(), json!(thread));
    }
}

/// `deliverTelegram`, `editTelegramMessage` and `answerTelegramCallbackQuery`.
#[derive(Clone)]
pub struct TelegramSender {
    api: TelegramApi,
    store: Arc<dyn ChannelCredentialStore>,
    env: Arc<ChannelEnv>,
}

impl TelegramSender {
    pub fn new(
        api: TelegramApi,
        store: Arc<dyn ChannelCredentialStore>,
        env: Arc<ChannelEnv>,
    ) -> Self {
        Self { api, store, env }
    }

    pub fn api(&self) -> &TelegramApi {
        &self.api
    }

    /// `resolveTelegramToken`.
    pub fn resolve_token(
        &self,
        explicit: Option<&str>,
        persona_token: Option<&str>,
    ) -> Option<String> {
        explicit
            .map(str::trim)
            .filter(|token| !token.is_empty())
            .or_else(|| persona_token.filter(|token| !token.is_empty()))
            .map(str::to_string)
            .or_else(|| non_empty(self.store.get_credential("telegram", "bot_token")))
            .or_else(|| non_empty(self.env.get("TELEGRAM_BOT_TOKEN")))
    }

    /// `deliverTelegram`: sends the text in chunks and returns the id of the
    /// last message. Without a token it logs and returns `None`, as the source
    /// does.
    pub async fn deliver(
        &self,
        target: &str,
        text: &str,
        options: &TelegramTextOptions,
    ) -> Result<Option<String>, ChannelError> {
        let parsed = parse_telegram_target(target);
        let thread = message_thread_for(&parsed);
        let chunks = split_telegram_message(&format_telegram_text(text), TELEGRAM_MAX_LENGTH);
        let Some(token) =
            self.resolve_token(options.token.as_deref(), options.persona_token.as_deref())
        else {
            error!("Telegram bot token not configured (neither in credential store nor env).");
            return Ok(None);
        };

        let mut last_message_id = None;
        for (index, chunk) in chunks.iter().enumerate() {
            let mut payload = Map::new();
            payload.insert("chat_id".into(), json!(parsed.chat_id));
            payload.insert("text".into(), json!(chunk));
            add_send_fields(&mut payload, options, thread);
            if index == 0 {
                if let Some(markup) = &options.reply_markup {
                    payload.insert("reply_markup".into(), json!(markup));
                }
            }

            let response = self
                .api
                .post_with_retry(&token, "sendMessage", &Value::Object(payload))
                .await?;
            let body = response_json(&response);
            if !response.is_ok() {
                return Err(ChannelError::new(format!(
                    "Telegram delivery failed: {}",
                    json_text(&body)
                )));
            }
            if let Some(id) = body.pointer("/result/message_id").and_then(value_as_id) {
                last_message_id = Some(id);
            }
        }
        Ok(last_message_id)
    }

    /// `editTelegramMessage`: one call, no chunking.
    pub async fn edit_message(
        &self,
        target: &str,
        message_id: i64,
        text: &str,
        options: &TelegramTextOptions,
    ) -> Result<(), ChannelError> {
        let parsed = parse_telegram_target(target);
        let Some(token) =
            self.resolve_token(options.token.as_deref(), options.persona_token.as_deref())
        else {
            return Ok(());
        };

        let mut payload = Map::new();
        payload.insert("chat_id".into(), json!(parsed.chat_id));
        payload.insert("message_id".into(), json!(message_id));
        payload.insert("text".into(), json!(format_telegram_text(text)));
        add_send_fields(&mut payload, options, message_thread_for(&parsed));
        if let Some(markup) = &options.reply_markup {
            payload.insert("reply_markup".into(), json!(markup));
        }

        let response = self
            .api
            .post_with_retry(&token, "editMessageText", &Value::Object(payload))
            .await?;
        if !response.is_ok() {
            return Err(ChannelError::new(format!(
                "Telegram edit failed: {}",
                json_text(&response_json(&response))
            )));
        }
        Ok(())
    }

    /// `answerTelegramCallbackQuery`. A non-2xx answer is logged, not returned.
    pub async fn answer_callback_query(
        &self,
        callback_query_id: &str,
        text: Option<&str>,
        show_alert: bool,
    ) -> Result<(), ChannelError> {
        let Some(token) = self.resolve_token(None, None) else {
            return Ok(());
        };

        let mut payload = Map::new();
        payload.insert("callback_query_id".into(), json!(callback_query_id));
        if let Some(text) = text.filter(|text| !text.is_empty()) {
            payload.insert("text".into(), json!(text));
        }
        if show_alert {
            payload.insert("show_alert".into(), json!(true));
        }

        let response = self
            .api
            .post_with_retry(&token, "answerCallbackQuery", &Value::Object(payload))
            .await?;
        if !response.is_ok() {
            warn!(
                "Telegram callback answer failed: {}",
                json_text(&response_json(&response))
            );
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::channels::pairing::test_support::{
        isolated_env, json_response, memory_store, ScriptedTransport,
    };

    fn sender(transport: &Arc<ScriptedTransport>, store_token: Option<&str>) -> TelegramSender {
        let store = memory_store();
        if let Some(token) = store_token {
            store.set_credential("telegram", "bot_token", token);
        }
        let api = TelegramApi::new(transport.clone()).with_backoff(Duration::ZERO);
        TelegramSender::new(api, store, isolated_env())
    }

    #[test]
    fn split_keeps_a_short_text_whole() {
        assert_eq!(split_telegram_message("hello", 10), vec!["hello"]);
    }

    #[test]
    fn split_prefers_a_newline_and_drops_it_from_the_next_chunk() {
        assert_eq!(split_telegram_message("ab\ncdef", 5), vec!["ab", "cdef"]);
    }

    #[test]
    fn split_falls_back_to_a_space_before_a_hard_cut() {
        assert_eq!(
            split_telegram_message("aaaa bbbb", 5),
            vec!["aaaa", " bbbb"]
        );
        assert_eq!(
            split_telegram_message("abcdefgh", 3),
            vec!["abc", "def", "gh"]
        );
    }

    #[test]
    fn split_counts_utf16_units_and_never_cuts_a_character() {
        // Each emoji is two UTF-16 units, so a window of three fits one of them.
        assert_eq!(
            split_telegram_message("\u{1F600}\u{1F600}", 3),
            vec!["\u{1F600}", "\u{1F600}"]
        );
    }

    #[test]
    fn format_normalizes_line_endings_and_drops_nul() {
        assert_eq!(format_telegram_text("a\r\nb\rc\0d"), "a\nb\ncd");
    }

    #[test]
    fn keyboard_drops_empty_and_oversized_buttons() {
        let long = "x".repeat(65);
        let markup = build_inline_keyboard(vec![
            vec![
                InlineKeyboardButton {
                    text: " Yes ".into(),
                    callback_data: " y ".into(),
                },
                InlineKeyboardButton {
                    text: "Too long".into(),
                    callback_data: long,
                },
            ],
            vec![InlineKeyboardButton {
                text: "".into(),
                callback_data: "z".into(),
            }],
        ])
        .expect("one button survives");
        assert_eq!(markup.inline_keyboard.len(), 1);
        assert_eq!(markup.inline_keyboard[0][0].text, "Yes");
        assert_eq!(markup.inline_keyboard[0][0].callback_data, "y");
        assert_eq!(
            build_inline_keyboard(vec![vec![InlineKeyboardButton {
                text: "x".into(),
                callback_data: "y".repeat(65),
            }]]),
            None
        );
    }

    #[tokio::test]
    async fn a_thread_one_group_message_is_sent_without_a_thread() {
        let transport = ScriptedTransport::new();
        transport.then(
            "sendMessage",
            json_response(200, json!({"ok": true, "result": {"message_id": 42}})),
        );
        let sender = sender(&transport, Some("1:t"));

        let id = sender
            .deliver("-1001:topic:1", "hi", &TelegramTextOptions::default())
            .await
            .expect("delivered");

        assert_eq!(id.as_deref(), Some("42"));
        let body = ScriptedTransport::body_of(&transport.calls("sendMessage")[0]);
        assert_eq!(body["chat_id"], "-1001");
        assert_eq!(body["disable_web_page_preview"], true);
        assert!(body.get("message_thread_id").is_none());
    }

    #[tokio::test]
    async fn the_markup_goes_on_the_first_chunk_only() {
        let transport = ScriptedTransport::new();
        transport.then("sendMessage", json_response(200, json!({"ok": true})));
        transport.then("sendMessage", json_response(200, json!({"ok": true})));
        let sender = sender(&transport, Some("1:t"));
        let options = TelegramTextOptions {
            reply_markup: Some(TelegramReplyMarkup {
                inline_keyboard: vec![vec![InlineKeyboardButton {
                    text: "A".into(),
                    callback_data: "a".into(),
                }]],
            }),
            ..TelegramTextOptions::default()
        };

        sender
            .deliver("42", &"a".repeat(4097), &options)
            .await
            .expect("delivered");

        let calls = transport.calls("sendMessage");
        assert_eq!(calls.len(), 2);
        assert!(ScriptedTransport::body_of(&calls[0])
            .get("reply_markup")
            .is_some());
        assert!(ScriptedTransport::body_of(&calls[1])
            .get("reply_markup")
            .is_none());
    }

    #[tokio::test]
    async fn without_a_token_nothing_is_sent_and_no_id_is_returned() {
        let transport = ScriptedTransport::new();
        let sender = sender(&transport, None);

        let id = sender
            .deliver("42", "hi", &TelegramTextOptions::default())
            .await
            .expect("not an error");

        assert_eq!(id, None);
        assert!(transport.requests().is_empty());
    }

    #[tokio::test]
    async fn a_rejected_delivery_is_an_error_with_the_provider_body() {
        let transport = ScriptedTransport::new();
        transport.then(
            "sendMessage",
            json_response(400, json!({"description": "chat not found"})),
        );
        let sender = sender(&transport, Some("1:t"));

        let error = sender
            .deliver("42", "hi", &TelegramTextOptions::default())
            .await
            .expect_err("a 400 is an error");

        assert!(error.0.starts_with("Telegram delivery failed: "));
        assert!(error.0.contains("chat not found"));
    }

    #[tokio::test]
    async fn the_explicit_token_wins_over_the_stored_one() {
        let transport = ScriptedTransport::new();
        transport.then("sendMessage", json_response(200, json!({"ok": true})));
        let sender = sender(&transport, Some("stored:t"));
        let options = TelegramTextOptions {
            token: Some("explicit:t".into()),
            ..TelegramTextOptions::default()
        };

        sender
            .deliver("42", "hi", &options)
            .await
            .expect("delivered");

        assert!(transport.calls("explicit:t/sendMessage").len() == 1);
    }

    #[tokio::test]
    async fn callback_answer_carries_text_and_alert_flag() {
        let transport = ScriptedTransport::new();
        transport.then(
            "answerCallbackQuery",
            json_response(200, json!({"ok": true})),
        );
        let sender = sender(&transport, Some("1:t"));

        sender
            .answer_callback_query("cb1", Some("Pairing required."), true)
            .await
            .expect("answered");

        let body = ScriptedTransport::body_of(&transport.calls("answerCallbackQuery")[0]);
        assert_eq!(body["callback_query_id"], "cb1");
        assert_eq!(body["text"], "Pairing required.");
        assert_eq!(body["show_alert"], true);
    }
}
