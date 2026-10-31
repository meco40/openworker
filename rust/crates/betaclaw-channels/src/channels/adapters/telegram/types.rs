//! Port of the Telegram update shapes declared in `pairing/telegramInbound.ts`
//! and `pairing/telegramPolling.ts`.
//!
//! Only the fields the channel code reads are typed. Serde ignores the rest, so
//! a field Telegram adds later cannot make a whole update fail to parse.

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct TelegramUser {
    pub id: i64,
    pub first_name: Option<String>,
    pub username: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TelegramChat {
    pub id: i64,
    #[serde(rename = "type")]
    pub kind: String,
    pub is_forum: Option<bool>,
}

/// Document, audio, voice, video, animation, sticker and photo size share one
/// struct: it is the superset of the fields the media code reads.
#[derive(Debug, Clone, Deserialize)]
pub struct TelegramFile {
    pub file_id: String,
    pub file_unique_id: Option<String>,
    pub file_name: Option<String>,
    pub mime_type: Option<String>,
    pub file_size: Option<u64>,
    pub duration: Option<u64>,
    pub title: Option<String>,
    pub performer: Option<String>,
    pub emoji: Option<String>,
    pub set_name: Option<String>,
    pub is_animated: Option<bool>,
    pub is_video: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TelegramMessage {
    pub message_id: i64,
    pub from: Option<TelegramUser>,
    pub chat: TelegramChat,
    pub text: Option<String>,
    pub caption: Option<String>,
    pub message_thread_id: Option<i64>,
    pub migrate_to_chat_id: Option<i64>,
    pub migrate_from_chat_id: Option<i64>,
    pub photo: Option<Vec<TelegramFile>>,
    pub document: Option<TelegramFile>,
    pub audio: Option<TelegramFile>,
    pub voice: Option<TelegramFile>,
    pub video: Option<TelegramFile>,
    pub animation: Option<TelegramFile>,
    pub sticker: Option<TelegramFile>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TelegramCallbackMessage {
    pub message_id: Option<i64>,
    pub message_thread_id: Option<i64>,
    pub chat: Option<TelegramChat>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TelegramCallbackQuery {
    pub id: String,
    pub data: Option<String>,
    pub message: Option<TelegramCallbackMessage>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TelegramUpdate {
    pub update_id: i64,
    pub message: Option<TelegramMessage>,
    pub callback_query: Option<TelegramCallbackQuery>,
}
