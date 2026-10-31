//! Port of `src/server/channels/pairing/bridgeAccounts.ts`.
//!
//! WhatsApp and iMessage run through a bridge that can serve several accounts.
//! The account list, each account's secret, status, peer, allow-list and the
//! scoped chat ids (`acct:<base64url account>:<chat>`) are kept as credential
//! rows of the bridge channel. Accounts `default` also mirror their values in
//! the legacy unscoped rows, which earlier releases still read.
//!
//! Functions that read the account list return `Result`. The source throws on a
//! stored account id that no longer validates, and so does the port.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use chrono::{DateTime, Utc};
use serde_json::Value;

use super::credentials::{to_iso, ChannelCredentialStore, ChannelEnv};
use crate::channels::adapters::types::{non_empty, ChannelError};

const BRIDGE_ACCOUNT_IDS_KEY: &str = "bridge_accounts";
const DEFAULT_ACCOUNT_ID: &str = "default";
const SCOPED_CHAT_PREFIX: &str = "acct:";
const ACCOUNT_ID_ERROR: &str =
    "Invalid accountId. Use lowercase letters, digits, \"_\" or \"-\", max 63 chars.";

/// `BridgeChannel`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BridgeChannel {
    WhatsApp,
    IMessage,
}

impl BridgeChannel {
    /// The channel key used for the credential rows.
    pub fn as_str(self) -> &'static str {
        match self {
            BridgeChannel::WhatsApp => "whatsapp",
            BridgeChannel::IMessage => "imessage",
        }
    }

    pub fn bridge_url_env(self) -> &'static str {
        match self {
            BridgeChannel::WhatsApp => "WHATSAPP_BRIDGE_URL",
            BridgeChannel::IMessage => "IMESSAGE_BRIDGE_URL",
        }
    }

    fn webhook_secret_env(self) -> &'static str {
        match self {
            BridgeChannel::WhatsApp => "WHATSAPP_WEBHOOK_SECRET",
            BridgeChannel::IMessage => "IMESSAGE_WEBHOOK_SECRET",
        }
    }
}

/// `BridgeAccountSummary`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgeAccountSummary {
    pub account_id: String,
    pub pairing_status: Option<String>,
    pub peer_name: Option<String>,
    pub last_seen_at: Option<String>,
    pub allow_from: Vec<String>,
}

/// `BridgeAccountUpsertInput`. `None` means the field was not given, which is
/// what `undefined` means in the source.
#[derive(Debug, Clone, Default)]
pub struct BridgeAccountUpsert {
    pub account_id: Option<String>,
    pub pairing_status: Option<String>,
    pub webhook_secret: Option<String>,
    pub peer_name: Option<String>,
    pub touch_last_seen: bool,
}

/// `ParsedScopedChat` from `parseScopedBridgeExternalChatId`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopedBridgeChat {
    pub account_id: String,
    pub external_chat_id: String,
}

fn account_key(account_id: &str, key: &str) -> String {
    format!("account.{account_id}.{key}")
}

fn is_valid_account_id(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 63
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes.iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'_' || *byte == b'-'
        })
}

/// `normalizeBridgeAccountId`: an absent or blank id is `default`.
pub fn normalize_bridge_account_id(account_id: Option<&str>) -> Result<String, ChannelError> {
    let raw = account_id.unwrap_or("").trim().to_lowercase();
    if raw.is_empty() {
        return Ok(DEFAULT_ACCOUNT_ID.to_string());
    }
    if !is_valid_account_id(&raw) {
        return Err(ChannelError::new(ACCOUNT_ID_ERROR));
    }
    Ok(raw)
}

fn normalize_allow_from_value(value: &str) -> String {
    value.trim().to_lowercase().split_whitespace().collect()
}

/// Keeps the first occurrence of each non-empty value.
fn dedupe(values: impl Iterator<Item = String>) -> Vec<String> {
    let mut unique: Vec<String> = Vec::new();
    for value in values {
        if !value.is_empty() && !unique.contains(&value) {
            unique.push(value);
        }
    }
    unique
}

/// `normalizeAccountIds`. A JSON array is read entry by entry. A value that is
/// not a JSON array falls back to a comma-separated list, and so does an array
/// with an invalid entry, as the source's `try` block does.
fn parse_account_ids(raw: Option<&str>) -> Result<Vec<String>, ChannelError> {
    let Some(raw) = raw.filter(|text| !text.trim().is_empty()) else {
        return Ok(Vec::new());
    };
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Array(items)) => {
            let from_array: Result<Vec<String>, ChannelError> = items
                .iter()
                .filter_map(Value::as_str)
                .map(|text| normalize_bridge_account_id(Some(text)))
                .collect();
            from_array.or_else(|_| split_account_ids(raw))
        }
        Ok(_) => Ok(Vec::new()),
        Err(_) => split_account_ids(raw),
    }
}

fn split_account_ids(raw: &str) -> Result<Vec<String>, ChannelError> {
    raw.split(',')
        .map(|part| normalize_bridge_account_id(Some(part)))
        .collect()
}

fn write_account_ids(
    store: &dyn ChannelCredentialStore,
    channel: BridgeChannel,
    ids: &[String],
) -> Result<(), ChannelError> {
    let mut normalized = Vec::new();
    for id in ids {
        normalized.push(normalize_bridge_account_id(Some(id.as_str()))?);
    }
    let unique = dedupe(normalized.into_iter());
    let serialized = serde_json::to_string(&unique).unwrap_or_default();
    store.set_credential(channel.as_str(), BRIDGE_ACCOUNT_IDS_KEY, &serialized);
    Ok(())
}

/// `listBridgeAccountIds`. Without an account list, a pre-multi-account install
/// counts as one `default` account when it has a status or a secret.
pub fn list_bridge_account_ids(
    store: &dyn ChannelCredentialStore,
    channel: BridgeChannel,
) -> Result<Vec<String>, ChannelError> {
    let ids = parse_account_ids(
        store
            .get_credential(channel.as_str(), BRIDGE_ACCOUNT_IDS_KEY)
            .as_deref(),
    )?;
    if !ids.is_empty() {
        return Ok(ids);
    }

    let has_legacy = non_empty(store.get_credential(channel.as_str(), "pairing_status")).is_some()
        || non_empty(store.get_credential(channel.as_str(), "webhook_secret")).is_some();
    Ok(if has_legacy {
        vec![DEFAULT_ACCOUNT_ID.to_string()]
    } else {
        Vec::new()
    })
}

fn trimmed(value: Option<String>) -> Option<String> {
    value
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

/// `resolveBridgeAccountSecret`: the account's own secret, then the legacy
/// secret for `default`, then the environment. The result may be empty.
pub fn resolve_bridge_account_secret(
    store: &dyn ChannelCredentialStore,
    env: &ChannelEnv,
    channel: BridgeChannel,
    account_id: Option<&str>,
) -> Result<String, ChannelError> {
    let normalized = normalize_bridge_account_id(account_id)?;
    if let Some(scoped) = trimmed(store.get_credential(
        channel.as_str(),
        &account_key(&normalized, "webhook_secret"),
    )) {
        return Ok(scoped);
    }
    if normalized == DEFAULT_ACCOUNT_ID {
        if let Some(legacy) = trimmed(store.get_credential(channel.as_str(), "webhook_secret")) {
            return Ok(legacy);
        }
    }
    Ok(env
        .get(channel.webhook_secret_env())
        .map(|value| value.trim().to_string())
        .unwrap_or_default())
}

fn resolve_account_status(
    store: &dyn ChannelCredentialStore,
    channel: BridgeChannel,
    account_id: &str,
) -> Option<String> {
    if let Some(scoped) = non_empty(
        store.get_credential(channel.as_str(), &account_key(account_id, "pairing_status")),
    ) {
        return Some(scoped);
    }
    if account_id == DEFAULT_ACCOUNT_ID {
        return store.get_credential(channel.as_str(), "pairing_status");
    }
    None
}

/// `upsertBridgeAccount`. Returns the normalized account id.
pub fn upsert_bridge_account(
    store: &dyn ChannelCredentialStore,
    channel: BridgeChannel,
    input: &BridgeAccountUpsert,
    now: DateTime<Utc>,
) -> Result<String, ChannelError> {
    let account_id = normalize_bridge_account_id(input.account_id.as_deref())?;
    let now_text = to_iso(now);
    let ids = list_bridge_account_ids(store, channel)?;
    if !ids.contains(&account_id) {
        let mut next = ids;
        next.push(account_id.clone());
        write_account_ids(store, channel, &next)?;
    }

    let name = channel.as_str();
    if let Some(secret) = &input.webhook_secret {
        store.set_credential(name, &account_key(&account_id, "webhook_secret"), secret);
        if account_id == DEFAULT_ACCOUNT_ID {
            store.set_credential(name, "webhook_secret", secret);
        }
    }
    if let Some(status) = &input.pairing_status {
        store.set_credential(name, &account_key(&account_id, "pairing_status"), status);
        if account_id == DEFAULT_ACCOUNT_ID {
            store.set_credential(name, "pairing_status", status);
        }
    }
    if let Some(peer_name) = &input.peer_name {
        store.set_credential(name, &account_key(&account_id, "peer_name"), peer_name);
    }
    if input.touch_last_seen {
        store.set_credential(name, &account_key(&account_id, "last_seen_at"), &now_text);
    }
    store.set_credential(name, &account_key(&account_id, "updated_at"), &now_text);

    Ok(account_id)
}

/// `listBridgeAccounts`.
pub fn list_bridge_accounts(
    store: &dyn ChannelCredentialStore,
    channel: BridgeChannel,
) -> Result<Vec<BridgeAccountSummary>, ChannelError> {
    let ids = list_bridge_account_ids(store, channel)?;
    let mut summaries = Vec::with_capacity(ids.len());
    for account_id in ids {
        summaries.push(BridgeAccountSummary {
            pairing_status: resolve_account_status(store, channel, &account_id),
            peer_name: store
                .get_credential(channel.as_str(), &account_key(&account_id, "peer_name")),
            last_seen_at: store
                .get_credential(channel.as_str(), &account_key(&account_id, "last_seen_at")),
            allow_from: read_bridge_account_allow_from(store, channel, Some(account_id.as_str()))?,
            account_id,
        });
    }
    Ok(summaries)
}

/// `removeBridgeAccount`: drops the account's rows and its id. The legacy rows
/// go too when the account is `default`.
pub fn remove_bridge_account(
    store: &dyn ChannelCredentialStore,
    channel: BridgeChannel,
    account_id: Option<&str>,
) -> Result<(), ChannelError> {
    let normalized = normalize_bridge_account_id(account_id)?;
    let prefix = format!("account.{normalized}.");
    for entry in store.list_credentials(channel.as_str()) {
        if entry.key.starts_with(&prefix) {
            store.delete_credential(channel.as_str(), &entry.key);
        }
    }

    let remaining: Vec<String> = list_bridge_account_ids(store, channel)?
        .into_iter()
        .filter(|id| *id != normalized)
        .collect();
    write_account_ids(store, channel, &remaining)?;

    if normalized == DEFAULT_ACCOUNT_ID {
        store.delete_credential(channel.as_str(), "pairing_status");
        store.delete_credential(channel.as_str(), "webhook_secret");
    }
    Ok(())
}

/// `resolveBridgeAccountIdFromRequest`. The gateway reads the three sources
/// (body, `x-betaclaw-account-id` header, `accountId` query parameter) and
/// passes them in; the first non-empty one wins.
pub fn resolve_bridge_account_id_from_request(
    body_account_id: Option<&str>,
    header_account_id: Option<&str>,
    query_account_id: Option<&str>,
) -> Result<String, ChannelError> {
    let chosen = [body_account_id, header_account_id, query_account_id]
        .into_iter()
        .flatten()
        .find(|value| !value.is_empty());
    normalize_bridge_account_id(chosen)
}

/// `readBridgeAccountAllowFrom`. The default account also reads the legacy row.
pub fn read_bridge_account_allow_from(
    store: &dyn ChannelCredentialStore,
    channel: BridgeChannel,
    account_id: Option<&str>,
) -> Result<Vec<String>, ChannelError> {
    let normalized = normalize_bridge_account_id(account_id)?;
    let raw =
        non_empty(store.get_credential(channel.as_str(), &account_key(&normalized, "allow_from")))
            .or_else(|| {
                if normalized == DEFAULT_ACCOUNT_ID {
                    non_empty(store.get_credential(channel.as_str(), "allow_from"))
                } else {
                    None
                }
            })
            .unwrap_or_default();
    Ok(dedupe(raw.split(',').map(normalize_allow_from_value)))
}

/// `writeBridgeAccountAllowFrom`. Returns the normalized list.
pub fn write_bridge_account_allow_from(
    store: &dyn ChannelCredentialStore,
    channel: BridgeChannel,
    account_id: &str,
    allow_from: &[String],
) -> Result<Vec<String>, ChannelError> {
    let normalized_id = normalize_bridge_account_id(Some(account_id))?;
    let values = dedupe(
        allow_from
            .iter()
            .map(String::as_str)
            .map(normalize_allow_from_value),
    );
    let serialized = values.join(",");
    store.set_credential(
        channel.as_str(),
        &account_key(&normalized_id, "allow_from"),
        &serialized,
    );
    if normalized_id == DEFAULT_ACCOUNT_ID {
        store.set_credential(channel.as_str(), "allow_from", &serialized);
    }
    Ok(values)
}

/// `scopeBridgeExternalChatId`. The default account keeps the bare chat id.
pub fn scope_bridge_external_chat_id(
    account_id: &str,
    external_chat_id: &str,
) -> Result<String, ChannelError> {
    let normalized = normalize_bridge_account_id(Some(account_id))?;
    if normalized == DEFAULT_ACCOUNT_ID {
        return Ok(external_chat_id.to_string());
    }
    let encoded = URL_SAFE_NO_PAD.encode(normalized.as_bytes());
    Ok(format!("{SCOPED_CHAT_PREFIX}{encoded}:{external_chat_id}"))
}

fn decode_account_id(encoded: &str) -> Option<String> {
    let bytes = URL_SAFE_NO_PAD.decode(encoded).ok()?;
    let text = String::from_utf8(bytes).ok()?;
    normalize_bridge_account_id(Some(text.as_str())).ok()
}

/// `parseScopedBridgeExternalChatId`. Anything that does not decode to a valid
/// account is returned as an unscoped `default` chat, as in the source.
pub fn parse_scoped_bridge_external_chat_id(scoped: &str) -> ScopedBridgeChat {
    let normalized = scoped.trim();
    let fallback = || ScopedBridgeChat {
        account_id: DEFAULT_ACCOUNT_ID.to_string(),
        external_chat_id: normalized.to_string(),
    };
    let Some(payload) = normalized.strip_prefix(SCOPED_CHAT_PREFIX) else {
        return fallback();
    };
    let Some(separator) = payload.find(':').filter(|index| *index > 0) else {
        return fallback();
    };
    match decode_account_id(&payload[..separator]) {
        Some(account_id) => ScopedBridgeChat {
            account_id,
            external_chat_id: payload[separator + 1..].to_string(),
        },
        None => fallback(),
    }
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;
    use crate::channels::pairing::test_support::{isolated_env, memory_store};

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 11, 12, 0, 0).unwrap()
    }

    #[test]
    fn account_ids_are_trimmed_lowercased_and_validated() {
        assert_eq!(normalize_bridge_account_id(None).unwrap(), "default");
        assert_eq!(
            normalize_bridge_account_id(Some("  Main_1 ")).unwrap(),
            "main_1"
        );
        assert_eq!(
            normalize_bridge_account_id(Some("bad id!")).unwrap_err().0,
            ACCOUNT_ID_ERROR
        );
        let too_long = "a".repeat(64);
        assert!(normalize_bridge_account_id(Some(too_long.as_str())).is_err());
        assert!(normalize_bridge_account_id(Some("-leading")).is_err());
    }

    #[test]
    fn a_pre_multi_account_install_lists_one_default_account() {
        let store = memory_store();
        store.set_credential("whatsapp", "pairing_status", "connected");

        assert_eq!(
            list_bridge_account_ids(store.as_ref(), BridgeChannel::WhatsApp).unwrap(),
            vec!["default"]
        );
    }

    #[test]
    fn upsert_list_and_remove_round_trip() {
        let store = memory_store();
        let input = BridgeAccountUpsert {
            account_id: Some("work".into()),
            pairing_status: Some("connected".into()),
            webhook_secret: Some("s3cret".into()),
            peer_name: Some("Work phone".into()),
            touch_last_seen: true,
        };
        upsert_bridge_account(store.as_ref(), BridgeChannel::IMessage, &input, now()).unwrap();

        let accounts = list_bridge_accounts(store.as_ref(), BridgeChannel::IMessage).unwrap();
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].account_id, "work");
        assert_eq!(accounts[0].pairing_status.as_deref(), Some("connected"));
        assert_eq!(accounts[0].peer_name.as_deref(), Some("Work phone"));
        assert!(accounts[0].last_seen_at.is_some());

        remove_bridge_account(store.as_ref(), BridgeChannel::IMessage, Some("work")).unwrap();
        assert!(
            list_bridge_account_ids(store.as_ref(), BridgeChannel::IMessage)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn the_secret_falls_back_to_the_environment_last() {
        let store = memory_store();
        let env = isolated_env();
        env.set("WHATSAPP_WEBHOOK_SECRET", " env-secret ");

        assert_eq!(
            resolve_bridge_account_secret(store.as_ref(), &env, BridgeChannel::WhatsApp, None)
                .unwrap(),
            "env-secret"
        );
        store.set_credential("whatsapp", "webhook_secret", "legacy");
        assert_eq!(
            resolve_bridge_account_secret(store.as_ref(), &env, BridgeChannel::WhatsApp, None)
                .unwrap(),
            "legacy"
        );
    }

    #[test]
    fn allow_list_is_normalized_and_deduplicated() {
        let store = memory_store();
        let written = write_bridge_account_allow_from(
            store.as_ref(),
            BridgeChannel::WhatsApp,
            "default",
            &[" +49 123 ".into(), "+49123".into(), "Alice".into()],
        )
        .unwrap();

        assert_eq!(written, vec!["+49123", "alice"]);
        assert_eq!(
            read_bridge_account_allow_from(store.as_ref(), BridgeChannel::WhatsApp, None).unwrap(),
            vec!["+49123", "alice"]
        );
    }

    #[test]
    fn scoped_chat_ids_round_trip_and_default_stays_unscoped() {
        let scoped = scope_bridge_external_chat_id("work", "chat-9").unwrap();
        assert!(scoped.starts_with("acct:"));
        assert_eq!(
            parse_scoped_bridge_external_chat_id(&scoped),
            ScopedBridgeChat {
                account_id: "work".into(),
                external_chat_id: "chat-9".into(),
            }
        );

        assert_eq!(
            scope_bridge_external_chat_id("default", "chat-9").unwrap(),
            "chat-9"
        );
        assert_eq!(
            parse_scoped_bridge_external_chat_id("chat-9"),
            ScopedBridgeChat {
                account_id: "default".into(),
                external_chat_id: "chat-9".into(),
            }
        );
    }

    #[test]
    fn a_corrupt_scope_falls_back_to_the_default_account() {
        assert_eq!(
            parse_scoped_bridge_external_chat_id("acct:!!!:chat"),
            ScopedBridgeChat {
                account_id: "default".into(),
                external_chat_id: "acct:!!!:chat".into(),
            }
        );
    }

    #[test]
    fn request_account_id_takes_the_first_non_empty_source() {
        assert_eq!(
            resolve_bridge_account_id_from_request(Some(""), Some("Work"), Some("other")).unwrap(),
            "work"
        );
        assert_eq!(
            resolve_bridge_account_id_from_request(None, None, None).unwrap(),
            "default"
        );
    }
}
