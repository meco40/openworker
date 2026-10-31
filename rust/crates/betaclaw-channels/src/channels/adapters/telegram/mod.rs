//! Port of the Telegram channel code that is not bound to a route:
//! `src/server/channels/telegram/` (targets, native commands, allowed updates,
//! group migration) and `src/server/channels/outbound/telegram.ts`.
//!
//! The media, voice, sticker, model-selection and persona-bot modules depend on
//! attachments, the message service and the persona registry. They are reached
//! through `TelegramInboundPort` in `pairing::telegram_inbound`, which the chat
//! dispatch implements.

pub mod api;
pub mod group_migration;
pub mod native_commands;
pub mod outbound;
pub mod targets;
pub mod types;
