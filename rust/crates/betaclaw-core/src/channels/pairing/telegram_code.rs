//! Port of `src/server/channels/pairing/telegramCodePairing.ts`.
//!
//! A Telegram chat is paired with a six-digit code. The code goes to the first
//! unpaired chat that writes to the bot, is shown in the web UI and is confirmed
//! there. The state lives in the credential store under the `telegram` channel,
//! as in the source.
//!
//! Two changes from the source, both on the security side:
//! - the code is compared in constant time (`subtle`) instead of with `!==`;
//! - the code is drawn with rejection sampling from the OS random source, so no
//!   residue of the modulus is favoured.

use chrono::{DateTime, Utc};
use subtle::ConstantTimeEq;

use super::credentials::{parse_iso, to_iso, ChannelCredentialStore};
use crate::channels::adapters::types::{non_empty, ChannelError};

const CHANNEL: &str = "telegram";
const KEY_PAIRING_STATUS: &str = "pairing_status";
const KEY_PAIRED_CHAT_ID: &str = "paired_chat_id";
const KEY_PENDING_CHAT_ID: &str = "pending_chat_id";
const KEY_PENDING_CODE: &str = "pending_code";
const KEY_PENDING_EXPIRES_AT: &str = "pending_expires_at";

const CODE_TTL_MS: i64 = 10 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TelegramStatus {
    Idle,
    AwaitingCode,
    Connected,
}

/// `TelegramPairingSnapshot`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TelegramPairingSnapshot {
    pub status: TelegramStatus,
    pub pending_chat_id: Option<String>,
    pub pending_expires_at: Option<DateTime<Utc>>,
    pub has_pending: bool,
}

/// `EnsureTelegramPairingCodeResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnsureCode {
    Issued {
        code: String,
        expires_at: DateTime<Utc>,
        reused: bool,
    },
    Blocked {
        pending_chat_id: String,
        expires_at: DateTime<Utc>,
    },
    AlreadyBound {
        paired_chat_id: String,
    },
    AlreadyConnected,
}

/// A pending pairing request that is complete and still valid.
struct ActivePending {
    chat_id: String,
    code: String,
    expires_at: DateTime<Utc>,
}

/// The three pending rows, each present only when non-empty.
struct PendingRows {
    chat_id: Option<String>,
    code: Option<String>,
    expires_at: Option<DateTime<Utc>>,
}

impl PendingRows {
    fn read(store: &dyn ChannelCredentialStore) -> Self {
        Self {
            chat_id: non_empty(store.get_credential(CHANNEL, KEY_PENDING_CHAT_ID)),
            code: non_empty(store.get_credential(CHANNEL, KEY_PENDING_CODE)),
            expires_at: non_empty(store.get_credential(CHANNEL, KEY_PENDING_EXPIRES_AT))
                .and_then(|raw| parse_iso(&raw)),
        }
    }

    fn active(self, now: DateTime<Utc>) -> Option<ActivePending> {
        match (self.chat_id, self.code, self.expires_at) {
            (Some(chat_id), Some(code), Some(expires_at)) if expires_at > now => {
                Some(ActivePending {
                    chat_id,
                    code,
                    expires_at,
                })
            }
            _ => None,
        }
    }
}

fn clear_pending(store: &dyn ChannelCredentialStore) {
    for key in [
        KEY_PENDING_CHAT_ID,
        KEY_PENDING_CODE,
        KEY_PENDING_EXPIRES_AT,
    ] {
        store.set_credential(CHANNEL, key, "");
    }
}

/// `getTelegramPairingSnapshot`.
pub fn telegram_pairing_snapshot(
    store: &dyn ChannelCredentialStore,
    now: DateTime<Utc>,
) -> TelegramPairingSnapshot {
    let status = match store.get_credential(CHANNEL, KEY_PAIRING_STATUS).as_deref() {
        Some("connected") => TelegramStatus::Connected,
        Some("awaiting_code") => TelegramStatus::AwaitingCode,
        _ => TelegramStatus::Idle,
    };
    let active = PendingRows::read(store).active(now);
    TelegramPairingSnapshot {
        status,
        has_pending: active.is_some(),
        pending_chat_id: active.as_ref().map(|pending| pending.chat_id.clone()),
        pending_expires_at: active.map(|pending| pending.expires_at),
    }
}

/// `rejectTelegramPendingPairingRequest`. Returns whether a request was pending.
pub fn reject_telegram_pending_pairing_request(
    store: &dyn ChannelCredentialStore,
    now: DateTime<Utc>,
) -> bool {
    let was_pending = PendingRows::read(store).active(now).is_some();
    clear_pending(store);
    was_pending
}

/// `beginTelegramCodePairing`: the bot is now waiting for a code.
pub fn begin_telegram_code_pairing(store: &dyn ChannelCredentialStore) {
    store.set_credential(CHANNEL, KEY_PAIRING_STATUS, "awaiting_code");
    store.set_credential(CHANNEL, KEY_PAIRED_CHAT_ID, "");
    clear_pending(store);
}

/// `isTelegramChatAuthorized`.
pub fn is_telegram_chat_authorized(store: &dyn ChannelCredentialStore, chat_id: &str) -> bool {
    store.get_credential(CHANNEL, KEY_PAIRING_STATUS).as_deref() == Some("connected")
        && non_empty(store.get_credential(CHANNEL, KEY_PAIRED_CHAT_ID)).as_deref() == Some(chat_id)
}

/// `ensureTelegramPairingCode`: issues a code for `chat_id`, reuses the pending
/// one for the same chat, or reports why no code can be issued.
pub fn ensure_telegram_pairing_code(
    store: &dyn ChannelCredentialStore,
    chat_id: &str,
    now: DateTime<Utc>,
) -> Result<EnsureCode, ChannelError> {
    let status = store.get_credential(CHANNEL, KEY_PAIRING_STATUS);
    if status.as_deref() == Some("connected") {
        if let Some(paired_chat_id) = non_empty(store.get_credential(CHANNEL, KEY_PAIRED_CHAT_ID)) {
            return Ok(if paired_chat_id == chat_id {
                EnsureCode::AlreadyConnected
            } else {
                EnsureCode::AlreadyBound { paired_chat_id }
            });
        }
    }
    if is_telegram_chat_authorized(store, chat_id) {
        return Ok(EnsureCode::AlreadyConnected);
    }

    if let Some(active) = PendingRows::read(store).active(now) {
        if active.chat_id != chat_id {
            return Ok(EnsureCode::Blocked {
                pending_chat_id: active.chat_id,
                expires_at: active.expires_at,
            });
        }
        return Ok(EnsureCode::Issued {
            code: active.code,
            expires_at: active.expires_at,
            reused: true,
        });
    }

    let code = generate_six_digit_code()?;
    let expires_at = now + chrono::Duration::milliseconds(CODE_TTL_MS);
    store.set_credential(CHANNEL, KEY_PAIRING_STATUS, "awaiting_code");
    store.set_credential(CHANNEL, KEY_PENDING_CHAT_ID, chat_id);
    store.set_credential(CHANNEL, KEY_PENDING_CODE, &code);
    store.set_credential(CHANNEL, KEY_PENDING_EXPIRES_AT, &to_iso(expires_at));
    Ok(EnsureCode::Issued {
        code,
        expires_at,
        reused: false,
    })
}

/// `confirmTelegramPairingCode`. On success the pending chat becomes the paired
/// chat, and the id of that chat is returned.
pub fn confirm_telegram_pairing_code(
    store: &dyn ChannelCredentialStore,
    provided_code: &str,
    now: DateTime<Utc>,
) -> Result<String, ChannelError> {
    let normalized = provided_code.trim();
    if normalized.is_empty() {
        return Err(ChannelError::new("Pairing code is required."));
    }

    let pending = PendingRows::read(store);
    let (Some(chat_id), Some(code), Some(expires_at)) =
        (pending.chat_id, pending.code, pending.expires_at)
    else {
        return Err(ChannelError::new("No active Telegram pairing request."));
    };

    if expires_at <= now {
        clear_pending(store);
        return Err(ChannelError::new(
            "Pairing code has expired. Send a new Telegram message to get a fresh code.",
        ));
    }
    if !bool::from(code.as_bytes().ct_eq(normalized.as_bytes())) {
        return Err(ChannelError::new("Invalid pairing code."));
    }

    store.set_credential(CHANNEL, KEY_PAIRING_STATUS, "connected");
    store.set_credential(CHANNEL, KEY_PAIRED_CHAT_ID, &chat_id);
    clear_pending(store);
    Ok(chat_id)
}

/// `migrateTelegramPairedChatId`: follows a group that became a supergroup.
/// Returns whether a stored chat id changed.
pub fn migrate_telegram_paired_chat_id(
    store: &dyn ChannelCredentialStore,
    old_chat_id: &str,
    new_chat_id: &str,
) -> bool {
    let old_chat_id = old_chat_id.trim();
    let new_chat_id = new_chat_id.trim();
    if old_chat_id.is_empty() || new_chat_id.is_empty() || old_chat_id == new_chat_id {
        return false;
    }

    let mut changed = false;
    if store.get_credential(CHANNEL, KEY_PAIRED_CHAT_ID).as_deref() == Some(old_chat_id) {
        store.set_credential(CHANNEL, KEY_PAIRED_CHAT_ID, new_chat_id);
        changed = true;
    }
    if store
        .get_credential(CHANNEL, KEY_PENDING_CHAT_ID)
        .as_deref()
        == Some(old_chat_id)
    {
        store.set_credential(CHANNEL, KEY_PENDING_CHAT_ID, new_chat_id);
        changed = true;
    }
    changed
}

/// `crypto.randomInt(0, 1_000_000)`, zero-padded to six digits. Values at or
/// above the largest multiple of 10^6 that fits in 32 bits are redrawn.
fn generate_six_digit_code() -> Result<String, ChannelError> {
    const RANGE: u32 = 1_000_000;
    const LIMIT: u32 = (u32::MAX / RANGE) * RANGE;
    loop {
        let mut buffer = [0u8; 4];
        getrandom::fill(&mut buffer)
            .map_err(|error| ChannelError::new(format!("random bytes unavailable: {error}")))?;
        let value = u32::from_le_bytes(buffer);
        if value < LIMIT {
            return Ok(format!("{:06}", value % RANGE));
        }
    }
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;
    use crate::channels::pairing::test_support::memory_store;

    fn t0() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 11, 12, 0, 0).unwrap()
    }

    fn issued_code(result: EnsureCode) -> String {
        match result {
            EnsureCode::Issued { code, .. } => code,
            other => panic!("expected a code, got {other:?}"),
        }
    }

    #[test]
    fn a_six_digit_code_is_issued_and_reused_for_the_same_chat() {
        let store = memory_store();
        let first = issued_code(ensure_telegram_pairing_code(store.as_ref(), "111", t0()).unwrap());

        assert_eq!(first.len(), 6);
        assert!(first.chars().all(|ch| ch.is_ascii_digit()));
        let again = ensure_telegram_pairing_code(store.as_ref(), "111", t0()).unwrap();
        assert!(matches!(again, EnsureCode::Issued { reused: true, .. }));
        assert_eq!(issued_code(again), first);
    }

    #[test]
    fn a_second_chat_is_blocked_while_a_code_is_pending() {
        let store = memory_store();
        ensure_telegram_pairing_code(store.as_ref(), "111", t0()).unwrap();

        let blocked = ensure_telegram_pairing_code(store.as_ref(), "222", t0()).unwrap();

        assert!(matches!(
            blocked,
            EnsureCode::Blocked { ref pending_chat_id, .. } if pending_chat_id == "111"
        ));
    }

    #[test]
    fn a_correct_code_pairs_the_chat_and_a_wrong_one_does_not() {
        let store = memory_store();
        let code = issued_code(ensure_telegram_pairing_code(store.as_ref(), "111", t0()).unwrap());

        assert_eq!(
            confirm_telegram_pairing_code(store.as_ref(), "000000x", t0())
                .unwrap_err()
                .0,
            "Invalid pairing code."
        );
        assert!(!is_telegram_chat_authorized(store.as_ref(), "111"));

        assert_eq!(
            confirm_telegram_pairing_code(store.as_ref(), &format!(" {code} "), t0()).unwrap(),
            "111"
        );
        assert!(is_telegram_chat_authorized(store.as_ref(), "111"));
        assert_eq!(
            ensure_telegram_pairing_code(store.as_ref(), "222", t0()).unwrap(),
            EnsureCode::AlreadyBound {
                paired_chat_id: "111".into()
            }
        );
    }

    #[test]
    fn an_expired_code_is_rejected_and_cleared() {
        let store = memory_store();
        let code = issued_code(ensure_telegram_pairing_code(store.as_ref(), "111", t0()).unwrap());
        let later = t0() + chrono::Duration::milliseconds(11 * 60 * 1000);

        assert!(confirm_telegram_pairing_code(store.as_ref(), &code, later)
            .unwrap_err()
            .0
            .starts_with("Pairing code has expired."));
        assert!(!reject_telegram_pending_pairing_request(
            store.as_ref(),
            t0()
        ));
    }

    #[test]
    fn migration_follows_the_paired_and_the_pending_chat() {
        let store = memory_store();
        store.set_credential("telegram", "paired_chat_id", "-100");
        store.set_credential("telegram", "pairing_status", "connected");

        assert!(migrate_telegram_paired_chat_id(
            store.as_ref(),
            "-100",
            "-200"
        ));
        assert!(is_telegram_chat_authorized(store.as_ref(), "-200"));
        assert!(!migrate_telegram_paired_chat_id(
            store.as_ref(),
            "-100",
            "-200"
        ));
    }

    #[test]
    fn the_snapshot_reports_the_pending_chat_only_while_it_is_valid() {
        let store = memory_store();
        ensure_telegram_pairing_code(store.as_ref(), "111", t0()).unwrap();

        let snapshot = telegram_pairing_snapshot(store.as_ref(), t0());
        assert!(snapshot.has_pending);
        assert_eq!(snapshot.pending_chat_id.as_deref(), Some("111"));
        assert_eq!(snapshot.status, TelegramStatus::AwaitingCode);
        let expired = telegram_pairing_snapshot(
            store.as_ref(),
            t0() + chrono::Duration::milliseconds(11 * 60 * 1000),
        );
        assert!(!expired.has_pending);
        assert_eq!(expired.pending_chat_id, None);
    }
}
