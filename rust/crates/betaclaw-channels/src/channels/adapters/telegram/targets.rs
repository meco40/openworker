//! Port of `src/server/channels/telegram/targets.ts`.
//!
//! The regular expressions use `[0-9]` where JavaScript's `\d` matches ASCII
//! digits only. Rust's `\d` would also match other Unicode digits.

use std::sync::LazyLock;

use regex::Regex;

/// `TelegramTarget['chatType']`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatType {
    Direct,
    Group,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TelegramTarget {
    pub chat_id: String,
    pub message_thread_id: Option<i64>,
    pub chat_type: ChatType,
}

static TELEGRAM_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(telegram|tg):").expect("static pattern"));
static GROUP_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^group:").expect("static pattern"));
static TOPIC_TARGET: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(.+?):topic:([0-9]+)$").expect("static pattern"));
static COMPACT_TOPIC_TARGET: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(.+):([0-9]+)$").expect("static pattern"));
static NUMERIC_CHAT_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^-?[0-9]+$").expect("static pattern"));

/// `stripTelegramInternalPrefixes`: removes `telegram:` or `tg:` as often as it
/// appears, and a `group:` directly after one of them.
pub fn strip_telegram_internal_prefixes(target: &str) -> String {
    let mut current = target.trim().to_string();
    let mut stripped_telegram_prefix = false;
    loop {
        let next = if TELEGRAM_PREFIX.is_match(&current) {
            stripped_telegram_prefix = true;
            TELEGRAM_PREFIX.replace(&current, "").trim().to_string()
        } else if stripped_telegram_prefix && GROUP_PREFIX.is_match(&current) {
            GROUP_PREFIX.replace(&current, "").trim().to_string()
        } else {
            current.clone()
        };
        if next == current {
            return current;
        }
        current = next;
    }
}

/// `resolveTelegramChatType`: a negative numeric id is a group, a positive one
/// a direct chat, anything else unknown.
pub fn resolve_chat_type(chat_id: &str) -> ChatType {
    let trimmed = chat_id.trim();
    if trimmed.is_empty() {
        return ChatType::Unknown;
    }
    if NUMERIC_CHAT_ID.is_match(trimmed) {
        return if trimmed.starts_with('-') {
            ChatType::Group
        } else {
            ChatType::Direct
        };
    }
    ChatType::Unknown
}

/// `parseTelegramTarget`: accepts `<chat>:topic:<thread>`, `<chat>:<thread>` and
/// a bare chat id, each optionally prefixed.
pub fn parse_telegram_target(target: &str) -> TelegramTarget {
    let normalized = strip_telegram_internal_prefixes(target);
    let caps = TOPIC_TARGET
        .captures(&normalized)
        .or_else(|| COMPACT_TOPIC_TARGET.captures(&normalized));
    if let Some(caps) = caps {
        let chat_id = caps[1].to_string();
        return TelegramTarget {
            chat_type: resolve_chat_type(&chat_id),
            message_thread_id: caps[2].parse::<i64>().ok(),
            chat_id,
        };
    }
    TelegramTarget {
        chat_type: resolve_chat_type(&normalized),
        message_thread_id: None,
        chat_id: normalized,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_topic_target_in_a_group() {
        let target = parse_telegram_target("tg:-100123:topic:7");
        assert_eq!(target.chat_id, "-100123");
        assert_eq!(target.message_thread_id, Some(7));
        assert_eq!(target.chat_type, ChatType::Group);
    }

    #[test]
    fn parses_the_compact_topic_form() {
        let target = parse_telegram_target("-100123:45");
        assert_eq!(target.chat_id, "-100123");
        assert_eq!(target.message_thread_id, Some(45));
    }

    #[test]
    fn the_group_prefix_is_only_stripped_after_a_telegram_prefix() {
        assert_eq!(
            parse_telegram_target("telegram:group:-5").chat_type,
            ChatType::Group
        );
        assert_eq!(strip_telegram_internal_prefixes("group:-5"), "group:-5");
    }

    #[test]
    fn a_positive_id_is_direct_and_a_handle_is_unknown() {
        assert_eq!(parse_telegram_target("123").chat_type, ChatType::Direct);
        assert_eq!(
            parse_telegram_target("@channel").chat_type,
            ChatType::Unknown
        );
        assert_eq!(parse_telegram_target("@channel").message_thread_id, None);
    }
}
