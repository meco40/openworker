//! Port of `src/server/channels/adapters/` and of the outbound delivery of the
//! Telegram, WhatsApp, iMessage, Slack and Discord channels
//! (`src/server/channels/outbound/{telegram,whatsapp,imessage,slack,discord}.ts`).
//!
//! Network calls go through [`crate::model_hub::http::HttpTransport`]. The
//! channel key is [`crate::messages_store::ChannelKey`]. Not ported here: the
//! outbound router (`outbound/router.ts`) and the adapter registry
//! (`routing/adapterRegistry.ts`); both belong to the message dispatch (S8).

pub mod capabilities;
pub mod discord;
pub mod imessage;
pub mod slack;
pub mod telegram;
pub mod types;
pub mod whatsapp;
