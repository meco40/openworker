//! Port of `src/server/channels/adapters/capabilities.ts`.
//!
//! `CHANNEL_CAPABILITIES` is a `match` here, so the compiler checks that every
//! channel has an entry. `normalize_channel_key` differs from
//! `normalizeChannelKey` in one point: the TypeScript `in` operator also sees
//! inherited properties, so `constructor` and `toString` were accepted as
//! channel keys. The port accepts the seven real keys only.

use super::types::ChannelCapabilities;
use crate::messages_store::ChannelKey;

const ALL_CHANNEL_KEYS: [ChannelKey; 7] = [
    ChannelKey::Webchat,
    ChannelKey::AgentRoom,
    ChannelKey::Telegram,
    ChannelKey::Whatsapp,
    ChannelKey::Discord,
    ChannelKey::Imessage,
    ChannelKey::Slack,
];

const fn capabilities(
    inbound: bool,
    outbound: bool,
    pairing: bool,
    streaming: bool,
) -> ChannelCapabilities {
    ChannelCapabilities {
        supports_inbound: inbound,
        supports_outbound: outbound,
        supports_pairing: pairing,
        supports_streaming: streaming,
    }
}

/// `CHANNEL_CAPABILITIES[key]`.
pub const fn channel_capabilities(key: ChannelKey) -> ChannelCapabilities {
    match key {
        ChannelKey::Webchat | ChannelKey::AgentRoom => capabilities(true, false, false, true),
        ChannelKey::Telegram
        | ChannelKey::Whatsapp
        | ChannelKey::Discord
        | ChannelKey::Imessage
        | ChannelKey::Slack => capabilities(true, true, true, false),
    }
}

/// `normalizeChannelKey`: trims and lowercases, then accepts a known key only.
pub fn normalize_channel_key(value: &str) -> Option<ChannelKey> {
    let normalized = value.trim().to_lowercase();
    ALL_CHANNEL_KEYS
        .into_iter()
        .find(|key| key.as_str() == normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_case_and_surrounding_whitespace() {
        assert_eq!(
            normalize_channel_key("  Telegram "),
            Some(ChannelKey::Telegram)
        );
        assert_eq!(
            normalize_channel_key("AGENT_ROOM"),
            Some(ChannelKey::AgentRoom)
        );
    }

    #[test]
    fn rejects_unknown_and_inherited_names() {
        assert_eq!(normalize_channel_key("sms"), None);
        assert_eq!(normalize_channel_key("constructor"), None);
        assert_eq!(normalize_channel_key("toString"), None);
    }

    #[test]
    fn only_the_web_channels_stream_and_have_no_outbound() {
        for key in ALL_CHANNEL_KEYS {
            let caps = channel_capabilities(key);
            let web = matches!(key, ChannelKey::Webchat | ChannelKey::AgentRoom);
            assert!(caps.supports_inbound, "{key:?} is inbound");
            assert_eq!(caps.supports_streaming, web, "{key:?} streaming");
            assert_eq!(caps.supports_outbound, !web, "{key:?} outbound");
            assert_eq!(caps.supports_pairing, !web, "{key:?} pairing");
        }
    }
}
