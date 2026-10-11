//! Port of `src/server/memory/mem0/**` — the HTTP provider of the
//! [`Mem0Client`] contract.
//!
//! | TypeScript                                          | Rust                                        |
//! | --------------------------------------------------- | ------------------------------------------- |
//! | `mem0/constants.ts:6-21`                            | [`DEFAULT_TIMEOUT_MS`], [`TRANSIENT_HTTP_CODES`], [`DEFAULT_MAX_RETRIES`], [`DEFAULT_RETRY_BASE_DELAY_MS`], [`MEM0_RUNTIME_UNCONFIGURED_MARKER`], [`MEM0_MODEL_HUB_SYNC_COOLDOWN_MS`] |
//! | `mem0/types.ts:5-21` (`Mem0ClientConfig`)           | [`Mem0ClientConfig`]                        |
//! | `mem0/types.ts:114-120` (`RequestOptions`)          | [`RequestOptions`]                          |
//! | `mem0/types.ts:123-126` (`RequestInit`)             | `http::Method` + `Option<&Value>` of [`Mem0HttpClient::request`] |
//! | `mem0/client.ts:43-108` (class, constructor)        | [`Mem0HttpClient`], [`Mem0HttpClient::new`] |
//! | `mem0/client.ts:110-118` (`requestV2`)              | [`Mem0HttpClient::request_v2`]              |
//! | `mem0/client.ts:120-129` (`request`)                | [`Mem0HttpClient::request`]                 |
//! | `mem0/client.ts:131-185` (`requestInternal`)        | [`Mem0HttpClient::request_internal`]        |
//! | `mem0/client.ts:187-244` (`requestOnce`)            | [`Mem0HttpClient::request_once`]            |
//! | `mem0/client.ts:247-251` (`createMem0AbortError`)   | [`MEM0_ABORT_MESSAGE`], [`Mem0HttpClient::abort_or_timeout`] |
//! | `mem0/client.ts:256-264` (`createMem0Client`)       | [`Mem0HttpClient::new`]                     |
//! | `mem0/client.ts:269-338` (`createMem0ClientFromEnv`) | [`create_mem0_client_from_env`], [`create_mem0_client_from_process_env`] |
//! | `mem0/operations/store.ts:11-49` (`createStoreOperation`) | [`Mem0HttpClient::add_memory`], [`Mem0HttpClient::add_memory_with_signal`] |
//! | `mem0/operations/store.ts:54-80` (`createUpdateOperation`) | [`Mem0HttpClient::update_memory`] |
//! | `mem0/operations/recall.ts:22-24` (`shouldTryV1Fallback`) | [`should_try_v1_fallback`]             |
//! | `mem0/operations/recall.ts:29-73` (`createSearchOperation`) | [`Mem0HttpClient::search_memories`]   |
//! | `mem0/operations/recall.ts:78-178` (`createListOperation`) | [`Mem0HttpClient::list_memories`], [`Mem0HttpClient::list_via_v1`] |
//! | `mem0/operations/recall.ts:183-194` (`createGetOperation`) | [`Mem0HttpClient::get_memory`]        |
//! | `mem0/operations/recall.ts:199-208` (`createGetHistoryOperation`) | [`Mem0HttpClient::get_memory_history`] |
//! | `mem0/operations/delete.ts:11-30` (`createDeleteOperation`) | [`Mem0HttpClient::delete_memory`]     |
//! | `mem0/operations/delete.ts:35-84` (`createDeleteByFilterOperation`) | [`Mem0HttpClient::delete_memories_by_filter`] |
//! | `mem0/operations/feedback.ts:12-46`                 | [`FeedbackRating`], [`FeedbackInput`], [`FeedbackOutcome`], [`submit_feedback`], [`get_memory_feedback`] |
//! | `mem0/utils/index.ts:10-16` (`pickRecord`)          | [`crate::memory::errors::pick_record`]      |
//! | `mem0/utils/index.ts:19-32` (`pickString`, `pickNumber`) | [`crate::memory::errors::pick_string`], [`crate::memory::errors::pick_number`] |
//! | `mem0/utils/index.ts:36-253` (extractors)           | [`extract_memories`], [`to_memory_record`], [`extract_hits`], [`to_history_entry`], [`extract_history`], [`extract_id`], [`extract_list_meta`], [`extract_deleted_count`], [`extract_error_detail`] |
//! | `mem0/utils/http.ts:10-29`                          | re-exported from [`crate::memory::utils`] (`normalizeBaseUrl`, `normalizeApiPath`, `joinUrl`) |
//! | `mem0/utils/http.ts:34-36` (`normalizeText`)        | [`crate::memory::utils::normalize_text`]    |
//! | `mem0/utils/http.ts:41-107` (classifiers)           | [`is_network_error`], [`is_transient_http_error`], [`is_timeout_error`], [`is_v2_unavailable_error`], [`is_legacy_delete_filter_error`], [`is_mem0_runtime_unconfigured_error`], [`is_mem0_invalid_model_config_error`] |
//! | `mem0/utils/http.ts:112-114` (`sleep`)              | [`sleep_ms`]                                |
//! | `mem0/sync.ts:7-37` (`triggerMem0ModelHubSync`)     | [`Mem0ModelHubSyncState`], [`Mem0ModelHubSyncState::trigger`], [`Mem0ModelHubSync`], [`NoopModelHubSync`] |
//! | `mem0/sync.ts:42-45` (`__resetMem0ModelHubSyncStateForTests`) | [`Mem0ModelHubSyncState::reset_for_tests`] |
//! | `mem0/index.ts:9-86` (re-exports)                   | this module is the crate's `mem0` entry point |
//!
//! # The transport seam
//!
//! `client.ts` calls the global `fetch` and composes an `AbortController` with a
//! `setTimeout` deadline. `betaclaw-core` owns no HTTP client, so the port reuses
//! the seam of `src/server/model-hub/Models/shared/http.ts`
//! ([`HttpTransport`](crate::model_hub::http::HttpTransport)): the deadline and
//! the caller's abort token travel *with* the
//! [`HttpRequest`](crate::model_hub::http::HttpRequest) and the concrete transport
//! (the gateway crate, which owns `reqwest`) applies them. Everything that does
//! not need a socket — the timeout arithmetic, the retry loop, the JSON coercion,
//! the error mapping — is ported here unchanged.
//!
//! # The synchronous contract
//!
//! [`Mem0Client`] is synchronous (see the module header of
//! [`crate::memory::sqlite::client`]); every TypeScript operation is a `Promise`.
//! The port therefore keeps the eight operations as `async` inherent methods
//! — the real port of `operations/**` — and implements the trait on top of them
//! through [`drive_sync`], which needs a multi-threaded tokio runtime (or no
//! runtime at all). Inside a *current-thread* runtime the bridge returns an
//! error instead of dead-locking the driver it was called on; callers on such a
//! runtime must use the `async` methods.
//!
//! # Deviations (each one deliberate)
//!
//! 1. **Transport instead of global `fetch`, deadline instead of `setTimeout`.**
//!    `fetchImpl` is a [`HttpTransport`](crate::model_hub::http::HttpTransport)
//!    and `AbortSignal` is the shared flag of the seam. A request that the
//!    transport reports as [`HttpError::Aborted`](crate::model_hub::http::HttpError::Aborted)
//!    or [`HttpError::Timeout`](crate::model_hub::http::HttpError::Timeout) maps
//!    back to the two messages of `client.ts:234-237`: an aborted caller signal
//!    wins, otherwise the deadline is a timeout.
//! 2. **`AbortError` becomes a message.** `createMem0AbortError()` returns an
//!    `Error` whose `name` is `'AbortError'`; [`MemoryError`] has no `name`
//!    field, so the port throws [`MemoryError::Message`] carrying the identical
//!    text ([`MEM0_ABORT_MESSAGE`]). Every consumer classifies on the text
//!    (`isTimeoutError`, `isV2UnavailableError`, …), which is preserved; what is
//!    lost is `error.name === 'AbortError'`.
//! 3. **`scope` is accepted and ignored.** `client.ts:97-107` binds
//!    `createGetOperation`/`createGetHistoryOperation`/`createUpdateOperation`/
//!    `createDeleteOperation` without a scope argument, so the HTTP provider
//!    never forwards one. The trait methods of the port take the optional
//!    [`Mem0Scope`] for signature parity and drop it, exactly as the
//!    TypeScript does.
//! 4. **`created` on the add result.** `createStoreOperation` resolves
//!    `{ id: extractId(payload) }`; `Mem0AddResult.created` is not optional, so
//!    [`Mem0AddResult::from_id`] reports `true` (the `POST /memories` with
//!    `infer: false` stores a memory). Nothing in the slice reads the flag for
//!    the HTTP provider.
//! 5. **The abort `signal` of `addMemory(input, signal?)`** cannot be expressed
//!    by [`Mem0Client::add_memory`]; the async
//!    [`Mem0HttpClient::add_memory_with_signal`] is the faithful entry point, and
//!    [`Mem0HttpClient::add_memory`] is its `signal: None` case.
//! 6. **The model-hub sync state is explicit.** `sync.ts:7-8` keeps the in-flight
//!    promise and the last attempt stamp in module scope; here they live in an
//!    `Arc<Mem0ModelHubSyncState>` that the caller shares (the gateway wires one
//!    per process). The awaited `import('@/server/memory/mem0EmbedderSync')`
//!    becomes the injected [`Mem0ModelHubSync`] trait, and the `catch { return
//!    false }` branch is [`NoopModelHubSync`], the default.
//! 7. **`encodeURIComponent` and `URLSearchParams` are re-implemented locally.**
//!    The crate has no shared percent-encoder (`gemini.rs` owns a private copy
//!    for its query string), and a cross-slice import from a model-hub adapter
//!    into the memory slice would invert the module layering. Both functions
//!    reproduce the WHATWG behaviour, including `' '` → `'+'` for the
//!    form-urlencoded serialiser.
//! 8. **`Number(...)` coercions.** `client.ts:299-322` coerces environment
//!    strings with `Number`. [`js_number_str`] reproduces the cases that matter
//!    (`''` → `0`, `'Infinity'` → `Infinity`, hex/binary/octal literals, and
//!    `NaN` for everything else a JavaScript `Number` would reject but Rust's
//!    `f64::from_str` accepts, namely `inf`/`infinity`/`nan` in lower case).
//!    `Number` of a JSON value is delegated to the already-ported
//!    [`crate::memory::types::js_number`], with the string case replaced by
//!    [`js_number_str`] so `'Infinity'` does not silently become `NaN`.
//! 9. **`String(metadata.type || '')`** (`recall.ts:107`) uses the shared
//!    [`crate::memory::types::js_string`] coercion, so a non-string falsy
//!    `metadata.type` (`0`, `false`, `null`) renders as `"0"`/`"false"`/`""`
//!    where the TypeScript `||` collapses it to `""`. The comparison only runs
//!    when `input.type` is a non-empty string, so the divergence needs a
//!    non-string `type` in the metadata bag that equals the filter verbatim.
//! 10. **`page`/`pageSize` are already integers.** `Math.max(1, Math.floor(x))`
//!     collapses into `i64::max(1)` because [`Mem0ListInput`] declares `i64`.
//! 11. **Retry arithmetic on `u32`/`u64`.** `maxRetries` is a `u32`, the attempt
//!     counter is widened inside the loop when a model-hub sync succeeded, and
//!     the delay is `retryBaseDelayMs * 2^attempt` in `f64` milliseconds
//!     truncated to whole milliseconds (JavaScript would `setTimeout` a
//!     fractional value; tokio cannot).
//! 12. **`Number.isFinite` guards still run.** A timeout below `100` ms is
//!     raised to `100` and a negative retry count to `0`, so a config that
//!     JavaScript would clamp is clamped here too; a `f64` beyond `u64`/`u32`
//!     is pinned to the maximum instead of wrapping.
//! 13. **Placeholders stay placeholders.** `operations/feedback.ts` has no
//!     endpoint behind it; [`submit_feedback`] returns `success: false` and
//!     [`get_memory_feedback`] returns an empty vector without touching the
//!     transport.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use http::Method;
use serde_json::{json, Map, Value};

use crate::memory::errors::{pick_number, pick_record, pick_string, MemoryError};
use crate::memory::sqlite::client::Mem0Client;
use crate::memory::types::{
    js_number, js_string, Mem0AddResult, Mem0DeleteByFilterInput, Mem0HistoryEntry, Mem0ListInput,
    Mem0ListMemoryResult, Mem0MemoryInput, Mem0MemoryRecord, Mem0Scope, Mem0SearchHit,
    Mem0SearchInput,
};
use crate::model_hub::http::{
    fetch_with_timeout, AbortSignal, BoxFuture, HttpError, HttpRequest, HttpTransport,
};

/// `DEFAULT_TIMEOUT_MS` from `mem0/constants.ts:6`.
pub const DEFAULT_TIMEOUT_MS: u64 = 15_000;
/// `TRANSIENT_HTTP_CODES` from `mem0/constants.ts:9` — a `Set` in TypeScript, an
/// array here so membership stays a plain `contains`.
pub const TRANSIENT_HTTP_CODES: [u16; 4] = [429, 500, 502, 503];
/// `DEFAULT_MAX_RETRIES` from `mem0/constants.ts:12`.
pub const DEFAULT_MAX_RETRIES: u32 = 0;
/// `DEFAULT_RETRY_BASE_DELAY_MS` from `mem0/constants.ts:15`.
pub const DEFAULT_RETRY_BASE_DELAY_MS: u64 = 500;
/// `MEM0_RUNTIME_UNCONFIGURED_MARKER` from `mem0/constants.ts:18`.
pub const MEM0_RUNTIME_UNCONFIGURED_MARKER: &str = "mem0 runtime is not configured";
/// `MEM0_MODEL_HUB_SYNC_COOLDOWN_MS` from `mem0/constants.ts:21`.
pub const MEM0_MODEL_HUB_SYNC_COOLDOWN_MS: i64 = 5_000;

/// `new Error('Mem0 request aborted by caller.')` from `client.ts:248`.
pub const MEM0_ABORT_MESSAGE: &str = "Mem0 request aborted by caller.";
/// The prefix of `` new Error(`Mem0 request timeout after ${timeoutMs}ms.`) ``
/// from `client.ts:237`; [`is_timeout_error`] matches exactly this prefix.
pub const MEM0_TIMEOUT_PREFIX: &str = "Mem0 request timeout after ";
/// `new Error('Mem0 request failed without a response.')` from `client.ts:184`.
pub const MEM0_NO_RESPONSE_MESSAGE: &str = "Mem0 request failed without a response.";
/// `throw new Error('Mem0 baseUrl is required.')` from `client.ts:261`.
pub const MEM0_BASE_URL_REQUIRED: &str = "Mem0 baseUrl is required.";
/// `client.ts:281`: production requires the mem0 provider.
pub const MEM0_PRODUCTION_REQUIRES_MEM0: &str =
    "Invalid memory configuration: production requires MEMORY_PROVIDER=mem0.";
/// `client.ts:289`.
pub const MEM0_ENV_BASE_URL_REQUIRED: &str =
    "Invalid memory configuration: MEM0_BASE_URL is required when MEMORY_PROVIDER=mem0.";
/// `client.ts:294`.
pub const MEM0_ENV_API_KEY_REQUIRED: &str =
    "Invalid memory configuration: MEM0_API_KEY is required when MEMORY_PROVIDER=mem0.";
/// The error [`drive_sync`] reports when the synchronous contract is driven from
/// inside a current-thread runtime (module header, “The synchronous contract”).
pub const MEM0_SYNC_BRIDGE_MESSAGE: &str = "Mem0HttpClient cannot be driven synchronously from \
     inside a current-thread tokio runtime; call the async methods of Mem0HttpClient instead.";

/// `Mem0ClientConfig` from `mem0/types.ts:5-21`.
///
/// Every numeric field keeps the JavaScript optionality (`number | undefined`)
/// as `Option<f64>`, because `createMem0Client` distinguishes "absent" from
/// "non-finite": an absent timeout falls back to [`DEFAULT_TIMEOUT_MS`], a `NaN`
/// timeout does too, and an explicit `0` is clamped up to `100`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Mem0ClientConfig {
    pub base_url: String,
    /// `apiPath?: string` — `/v1` when absent or empty (`client.ts:70`).
    pub api_path: Option<String>,
    /// `apiKey?: string` — trimmed, and `None` when only whitespace.
    pub api_key: Option<String>,
    /// Legacy/shared timeout; the read timeout unless `readTimeoutMs` is set.
    pub timeout_ms: Option<f64>,
    /// Timeout for read/list/search/get requests.
    pub read_timeout_ms: Option<f64>,
    /// Timeout for write/update/delete requests.
    pub write_timeout_ms: Option<f64>,
    /// Retries for transient HTTP errors (500, 502, 503, 429).
    pub max_retries: Option<f64>,
    /// Retries for write operations; defaults to `max_retries`.
    pub write_max_retries: Option<f64>,
    /// Base delay before the first retry, doubling per attempt.
    pub retry_base_delay_ms: Option<f64>,
}

/// `RequestOptions` from `mem0/types.ts:114-120`.
#[derive(Debug, Clone, Default)]
pub struct RequestOptions {
    /// `timeoutMs?: number`.
    pub timeout_ms: Option<f64>,
    /// `maxRetries?: number`.
    pub max_retries: Option<f64>,
    /// `retryOnTimeout?: boolean`.
    pub retry_on_timeout: bool,
    /// `signal?: AbortSignal` — aborting it cancels the in-flight request.
    pub signal: Option<AbortSignal>,
}

impl RequestOptions {
    /// The write options of `store.ts:40-45` and `delete.ts:23-27`: the write
    /// deadline, the write retries, and a timeout that *is* retried.
    pub fn write(write_timeout_ms: u64, write_max_retries: u32) -> Self {
        Self {
            timeout_ms: Some(write_timeout_ms as f64),
            max_retries: Some(write_max_retries as f64),
            retry_on_timeout: true,
            signal: None,
        }
    }

    /// [`Self::write`] plus the caller's `signal`, for `store.ts:26-45`.
    pub fn write_with_signal(
        write_timeout_ms: u64,
        write_max_retries: u32,
        signal: Option<AbortSignal>,
    ) -> Self {
        Self {
            signal,
            ..Self::write(write_timeout_ms, write_max_retries)
        }
    }
}

/// `Number.isFinite(value) ? value : fallback` — the guard every numeric field of
/// `client.ts:72-89` passes through.
fn finite_or(value: Option<f64>, fallback: f64) -> f64 {
    value.filter(|value| value.is_finite()).unwrap_or(fallback)
}

/// `Math.max(100, Math.floor(value))` as a request deadline.
///
/// `NaN` (which the callers filter out beforehand) and every value below `100`
/// clamp up to `100`, exactly like `Math.max` does.
fn clamp_timeout_ms(value: f64) -> u64 {
    let floored = value.floor();
    if floored.is_nan() || floored < 100.0 {
        return 100;
    }
    if floored >= u64::MAX as f64 {
        return u64::MAX;
    }
    floored as u64
}

/// `Math.max(0, Math.floor(value))` as a retry count.
fn clamp_retries(value: f64) -> u32 {
    let floored = value.floor();
    if floored.is_nan() || floored < 1.0 {
        return 0;
    }
    if floored >= u32::MAX as f64 {
        return u32::MAX;
    }
    floored as u32
}

/// `Math.max(0, Math.floor(value))` as a millisecond delay.
fn clamp_delay_ms(value: f64) -> u64 {
    let floored = value.floor();
    if floored.is_nan() || floored < 1.0 {
        return 0;
    }
    if floored >= u64::MAX as f64 {
        return u64::MAX;
    }
    floored as u64
}

/// `Math.floor(value)` narrowed to `i64`; a value beyond `i64::MAX` saturates
/// instead of wrapping (JavaScript keeps the float there).
fn floor_to_i64(value: f64) -> i64 {
    let floored = value.floor();
    if floored >= i64::MAX as f64 {
        i64::MAX
    } else {
        floored as i64
    }
}

/// The first truthy operand of a `||` chain over numbers: `0` and `NaN` are
/// falsy, a negative or infinite value is not.
fn first_truthy_number<const N: usize>(values: [f64; N]) -> Option<f64> {
    values
        .into_iter()
        .find(|value| *value != 0.0 && !value.is_nan())
}

/// `Number(text)` for the environment strings of `client.ts:299-322`.
///
/// Reproduced: surrounding whitespace is trimmed, `''` is `0`,
/// `'Infinity'`/`'-Infinity'` are the infinities (JavaScript matches those
/// spellings case-sensitively), the `0x`/`0b`/`0o` literals parse in their base,
/// and everything else that `f64::from_str` would accept but JavaScript rejects
/// (`inf`, `infinity`, `nan`, any case) is `NaN`.
fn js_number_str(text: &str) -> f64 {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return 0.0;
    }
    match trimmed {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let lowered = trimmed.to_ascii_lowercase();
    for (prefix, radix) in [("0x", 16), ("0b", 2), ("0o", 8)] {
        if let Some(digits) = lowered.strip_prefix(prefix) {
            return u64::from_str_radix(digits, radix)
                .map(|value| value as f64)
                .unwrap_or(f64::NAN);
        }
    }
    match lowered.as_str() {
        // `Number('inf')` is `NaN`; Rust's `f64::from_str` returns infinity.
        "inf" | "+inf" | "infinity" | "+infinity" | "-inf" | "-infinity" | "nan" | "+nan"
        | "-nan" => f64::NAN,
        _ => trimmed.parse::<f64>().unwrap_or(f64::NAN),
    }
}

/// `Number(value)` for a JSON value, with [`js_number_str`] in the string case.
///
/// Every other shape is delegated to
/// [`crate::memory::types::js_number`], which documents the coercions the
/// validators rely on (`null` → `0`, `''` → `0`, `'abc'` → `NaN`, `{}` → `NaN`).
fn js_number_value(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::String(text)) => js_number_str(text),
        other => js_number(other),
    }
}

/// `encodeURIComponent` from JavaScript.
///
/// The same function as `gemini.rs:75-95`, kept local so the memory slice does
/// not import a model-hub provider adapter (module header, deviation 7).
fn encode_uri_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// `new URLSearchParams({...}).toString()` — the `application/x-www-form-urlencoded`
/// serialiser.
///
/// ASCII alphanumerics plus `*`, `-`, `.` and `_` survive; a space becomes `+`;
/// every other byte is `%XX`. That set is *smaller* than the
/// `encodeURIComponent` one, so `~` and `!` are escaped here.
fn form_urlencode(pairs: &[(&str, &str)]) -> String {
    fn encode(value: &str) -> String {
        let mut out = String::with_capacity(value.len());
        for byte in value.bytes() {
            match byte {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                    out.push(byte as char)
                }
                b' ' => out.push('+'),
                _ => out.push_str(&format!("%{byte:02X}")),
            }
        }
        out
    }

    pairs
        .iter()
        .map(|(key, value)| format!("{}={}", encode(key), encode(value)))
        .collect::<Vec<_>>()
        .join("&")
}

/// `sleep(ms)` from `mem0/utils/http.ts:112-114`, on tokio's timer instead of
/// `setTimeout`.
pub async fn sleep_ms(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
}

/// `retryBaseDelayMs * Math.pow(2, attempt)` from `client.ts:177`.
///
/// A fractional millisecond is truncated: `setTimeout` accepts it, tokio does
/// not.
fn retry_delay_ms(retry_base_delay_ms: u64, attempt: u32) -> u64 {
    let factor = 2f64.powi(attempt.min(63) as i32);
    let delay = retry_base_delay_ms as f64 * factor;
    if !delay.is_finite() || delay >= u64::MAX as f64 {
        u64::MAX
    } else {
        delay as u64
    }
}

// ─── `mem0/utils/http.ts:41-107` — the error classifiers ────────────────────

/// `isNetworkError` from `mem0/utils/http.ts:41-46`.
///
/// Matches the transport's own text (`fetch failed`, `ECONNREFUSED`,
/// `ECONNRESET`, `ENOTFOUND`, `socket hang up`), which is why the port keeps the
/// transport error message verbatim in [`MemoryError::Message`].
pub fn is_network_error(error: &MemoryError) -> bool {
    regex::Regex::new(
        r"(?i)\bfetch failed\b|\bECONNREFUSED\b|\bECONNRESET\b|\bENOTFOUND\b|\bsocket hang up\b",
    )
    .expect("static regex")
    .is_match(&error.to_string())
}

/// `isTransientHttpError` from `mem0/utils/http.ts:51-57`.
///
/// Only the *first* `HTTP <code>` of the message is tested, exactly like the
/// single `exec` of the source: `Mem0 request failed with HTTP 404: HTTP 500`
/// is not transient.
pub fn is_transient_http_error(error: &MemoryError) -> bool {
    if is_network_error(error) {
        return true;
    }
    let message = error.to_string();
    let captures = regex::Regex::new(r"(?i)HTTP\s*(\d{3})")
        .expect("static regex")
        .captures(&message);
    let Some(status) = captures.and_then(|captures| captures.get(1)) else {
        return false;
    };
    match status.as_str().parse::<u16>() {
        Ok(status) => TRANSIENT_HTTP_CODES.contains(&status),
        Err(_) => false,
    }
}

/// `isTimeoutError` from `mem0/utils/http.ts:62-65`.
pub fn is_timeout_error(error: &MemoryError) -> bool {
    regex::Regex::new(r"(?i)mem0 request timeout")
        .expect("static regex")
        .is_match(&error.to_string())
}

/// `isV2UnavailableError` from `mem0/utils/http.ts:70-73`.
pub fn is_v2_unavailable_error(error: &MemoryError) -> bool {
    regex::Regex::new(r"(?i)HTTP\s*(404|405)")
        .expect("static regex")
        .is_match(&error.to_string())
}

/// `isLegacyDeleteFilterError` from `mem0/utils/http.ts:78-81`.
pub fn is_legacy_delete_filter_error(error: &MemoryError) -> bool {
    regex::Regex::new(r"(?i)HTTP\s*(400|404|405)")
        .expect("static regex")
        .is_match(&error.to_string())
}

/// `isMem0RuntimeUnconfiguredError` from `mem0/utils/http.ts:86-91`.
pub fn is_mem0_runtime_unconfigured_error(error: &MemoryError) -> bool {
    let message = error.to_string();
    regex::Regex::new(r"(?i)HTTP\s*503")
        .expect("static regex")
        .is_match(&message)
        && message
            .to_lowercase()
            .contains(MEM0_RUNTIME_UNCONFIGURED_MARKER)
}

/// `isMem0InvalidModelConfigError` from `mem0/utils/http.ts:97-107`.
///
/// All three signals are required (`hasHttpStatus && hasModelNotFoundSignal &&
/// hasModelMethodSignal`), so a plain 404 or a plain "model not found" does not
/// trigger a model-hub re-sync.
pub fn is_mem0_invalid_model_config_error(error: &MemoryError) -> bool {
    let message = error.to_string();
    let normalized = message.to_lowercase();
    let has_http_status = regex::Regex::new(r"(?i)HTTP\s*(400|404|422|500|503)")
        .expect("static regex")
        .is_match(&message);
    let has_model_not_found_signal = normalized.contains("is not found for api version")
        || (normalized.contains("not_found") && normalized.contains("model"));
    let has_model_method_signal =
        normalized.contains("embedcontent") || normalized.contains("generatecontent");
    has_http_status && has_model_not_found_signal && has_model_method_signal
}

// ─── `mem0/utils/index.ts:36-253` — the payload extractors ──────────────────

/// `extractMemories` from `mem0/utils/index.ts:36-43`.
///
/// The envelope order is `memories`, `results`, `data`, then the payload itself
/// when it is an array; anything else is an empty vector.
pub fn extract_memories(payload: &Value) -> Vec<Value> {
    let root = pick_record(Some(payload));
    for key in ["memories", "results", "data"] {
        if let Some(Value::Array(rows)) = root.get(key) {
            return rows.clone();
        }
    }
    match payload {
        Value::Array(rows) => rows.clone(),
        _ => Vec::new(),
    }
}

/// `toMemoryRecord` from `mem0/utils/index.ts:48-74`.
///
/// `None` stands for the TypeScript `null`: neither an id nor a content could be
/// read. A `Value::Null` entry behaves like `undefined`, because
/// [`pick_record`] turns both into an empty object.
pub fn to_memory_record(entry: &Value) -> Option<Mem0MemoryRecord> {
    let record = pick_record(Some(entry));
    let nested = pick_record(record.get("memory"));
    let id = pick_string(record.get("id"))
        .or_else(|| pick_string(record.get("memory_id")))
        .or_else(|| pick_string(nested.get("id")));
    let content = pick_string(record.get("memory"))
        .or_else(|| pick_string(record.get("text")))
        .or_else(|| pick_string(record.get("content")))
        .or_else(|| pick_string(nested.get("text")))
        .or_else(|| pick_string(nested.get("content")));
    let (Some(id), Some(content)) = (id, content) else {
        return None;
    };

    Some(Mem0MemoryRecord {
        id,
        content,
        score: pick_number(record.get("score"))
            .or_else(|| pick_number(record.get("similarity")))
            .or_else(|| pick_number(record.get("distance"))),
        metadata: pick_record(record.get("metadata")),
        created_at: pick_string(record.get("created_at"))
            .or_else(|| pick_string(record.get("createdAt"))),
        updated_at: pick_string(record.get("updated_at"))
            .or_else(|| pick_string(record.get("updatedAt"))),
    })
}

/// `extractHits` from `mem0/utils/index.ts:79-89`.
pub fn extract_hits(payload: &Value) -> Vec<Mem0SearchHit> {
    extract_memories(payload)
        .iter()
        .filter_map(to_memory_record)
        .map(|record| Mem0SearchHit {
            id: record.id,
            content: record.content,
            score: record.score,
            metadata: record.metadata,
        })
        .collect()
}

/// `toHistoryEntry` from `mem0/utils/index.ts:94-134`.
///
/// An entry without a single key is `null`; everything else carries the whole
/// record as `raw`, plus the nested lookups (`new_memory`, `old_memory`,
/// `memory`) for the first non-empty content.
pub fn to_history_entry(entry: &Value) -> Option<Mem0HistoryEntry> {
    let record = pick_record(Some(entry));
    if record.is_empty() {
        return None;
    }

    let metadata = pick_record(record.get("metadata"));
    let nested_memory = pick_record(record.get("memory"));
    let nested_old = pick_record(record.get("old_memory"));
    let nested_new = pick_record(record.get("new_memory"));
    let action = pick_string(record.get("action"))
        .or_else(|| pick_string(record.get("event")))
        .or_else(|| pick_string(record.get("operation")))
        .unwrap_or_else(|| "unknown".to_string());
    let timestamp = pick_string(record.get("timestamp"))
        .or_else(|| pick_string(record.get("created_at")))
        .or_else(|| pick_string(record.get("updated_at")))
        .or_else(|| pick_string(record.get("time")));
    let content = pick_string(record.get("new_memory"))
        .or_else(|| pick_string(record.get("old_memory")))
        .or_else(|| pick_string(record.get("content")))
        .or_else(|| pick_string(record.get("text")))
        .or_else(|| pick_string(record.get("memory")))
        .or_else(|| pick_string(nested_memory.get("content")))
        .or_else(|| pick_string(nested_memory.get("text")))
        .or_else(|| pick_string(nested_new.get("content")))
        .or_else(|| pick_string(nested_new.get("text")))
        .or_else(|| pick_string(nested_old.get("content")))
        .or_else(|| pick_string(nested_old.get("text")));

    Some(Mem0HistoryEntry {
        action,
        timestamp,
        content,
        metadata,
        raw: record,
    })
}

/// `extractHistory` from `mem0/utils/index.ts:139-154`.
///
/// Unlike [`extract_memories`], the payload array wins over the `history` key.
pub fn extract_history(payload: &Value) -> Vec<Mem0HistoryEntry> {
    let rows: Vec<Value> = if let Value::Array(rows) = payload {
        rows.clone()
    } else {
        let root = pick_record(Some(payload));
        ["history", "results", "data"]
            .iter()
            .find_map(|key| match root.get(*key) {
                Some(Value::Array(rows)) => Some(rows.clone()),
                _ => None,
            })
            .unwrap_or_default()
    };

    rows.iter().filter_map(to_history_entry).collect()
}

/// `extractId` from `mem0/utils/index.ts:159-177`.
///
/// A non-empty array (or `results` array) is read through [`to_memory_record`],
/// so an entry without content yields no id; then the flat `id`, `memory_id`,
/// `memory.id` and `data.id` keys are tried in that order.
pub fn extract_id(payload: &Value) -> Option<String> {
    if let Value::Array(rows) = payload {
        if let Some(record) = rows.first().and_then(to_memory_record) {
            return Some(record.id);
        }
    }

    let root = pick_record(Some(payload));
    if let Some(Value::Array(results)) = root.get("results") {
        if let Some(record) = results.first().and_then(to_memory_record) {
            return Some(record.id);
        }
    }

    pick_string(root.get("id"))
        .or_else(|| pick_string(root.get("memory_id")))
        .or_else(|| pick_string(pick_record(root.get("memory")).get("id")))
        .or_else(|| pick_string(pick_record(root.get("data")).get("id")))
}

/// `extractListMeta` from `mem0/utils/index.ts:182-213`.
///
/// The returned triple is the module's own `{ total, page, pageSize }`; the
/// caller spreads it into its result. Each field is the first *truthy* member of
/// an implicit `||` chain and then guarded with `Number.isFinite` and a lower
/// bound, so a `0` page falls back to the caller's page and a negative or
/// infinite total becomes `0`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Mem0ListMeta {
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
}

/// `extractListMeta(payload, fallbackPage, fallbackPageSize)` — see
/// [`Mem0ListMeta`].
pub fn extract_list_meta(
    payload: &Value,
    fallback_page: i64,
    fallback_page_size: i64,
) -> Mem0ListMeta {
    let root = pick_record(Some(payload));
    let pagination = pick_record(root.get("pagination"));
    let total = first_truthy_number([
        js_number_value(root.get("total")),
        js_number_value(root.get("count")),
        js_number_value(root.get("total_count")),
        js_number_value(pagination.get("total")),
    ])
    .unwrap_or(0.0);
    let page = first_truthy_number([
        js_number_value(root.get("page")),
        js_number_value(pagination.get("page")),
        js_number_value(root.get("current_page")),
    ])
    .unwrap_or(fallback_page as f64);
    let page_size = first_truthy_number([
        js_number_value(root.get("page_size")),
        js_number_value(root.get("pageSize")),
        js_number_value(pagination.get("page_size")),
        js_number_value(pagination.get("pageSize")),
    ])
    .unwrap_or(fallback_page_size as f64);

    Mem0ListMeta {
        total: if total.is_finite() && total >= 0.0 {
            floor_to_i64(total)
        } else {
            0
        },
        page: if page.is_finite() && page >= 1.0 {
            floor_to_i64(page)
        } else {
            fallback_page
        },
        page_size: if page_size.is_finite() && page_size >= 1.0 {
            floor_to_i64(page_size)
        } else {
            fallback_page_size
        },
    }
}

/// `extractDeletedCount` from `mem0/utils/index.ts:218-236`.
///
/// The four numeric candidates are tested in order with `Number.isFinite(value)
/// && value >= 0` (so an `Infinity` candidate is skipped where the `||` chains
/// of [`extract_list_meta`] would accept it); `deleted_memories` is the array
/// fallback and everything else is `0`.
pub fn extract_deleted_count(payload: &Value) -> i64 {
    let root = pick_record(Some(payload));
    for candidate in [
        js_number_value(root.get("deleted")),
        js_number_value(root.get("count")),
        js_number_value(root.get("total_deleted")),
        js_number_value(root.get("deleted_count")),
    ] {
        if candidate.is_finite() && candidate >= 0.0 {
            return floor_to_i64(candidate);
        }
    }

    match root.get("deleted_memories") {
        Some(Value::Array(rows)) => rows.len() as i64,
        _ => 0,
    }
}

/// `extractErrorDetail` from `mem0/utils/index.ts:241-253`.
///
/// `detail`, then `error`, then `message`; a non-string (for example the
/// `{ error: { code, message } }` envelope of an upstream provider) yields `''`,
/// which is what keeps the `HTTP <status>` fallback of [`Mem0HttpClient::request_once`]
/// intact.
pub fn extract_error_detail(payload: &Value) -> String {
    let root = pick_record(Some(payload));
    pick_string(root.get("detail"))
        .or_else(|| pick_string(root.get("error")))
        .or_else(|| pick_string(root.get("message")))
        .unwrap_or_default()
}

// ─── `mem0/sync.ts` — the model-hub re-sync gate ────────────────────────────

/// The awaited `import('@/server/memory/mem0EmbedderSync')` of `sync.ts:24-29`.
///
/// The gateway injects the real implementation; `betaclaw-core` cannot import
/// the Next.js module, and the trait also keeps the CRUD client testable
/// (`NoopModelHubSync` is the default).
pub trait Mem0ModelHubSync: Send + Sync {
    /// `Promise.all([syncMem0LlmFromModelHub(), syncMem0EmbedderFromModelHub()])`
    /// plus `llmResult.ok && embedderResult.ok`, *including* the
    /// `catch { return false }` of `sync.ts:30-31`: an implementation reports a
    /// failed or unreachable sync as `false` instead of propagating an error.
    fn sync<'a>(&'a self) -> BoxFuture<'a, bool>;
}

/// The default [`Mem0ModelHubSync`]: no model hub is wired into the process, so
/// every attempt reports `false` — the same outcome as the rejected dynamic
/// import of `sync.ts:24`.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoopModelHubSync;

impl Mem0ModelHubSync for NoopModelHubSync {
    fn sync<'a>(&'a self) -> BoxFuture<'a, bool> {
        Box::pin(async { false })
    }
}

/// `let mem0ModelHubSyncInFlight: Promise<boolean> | null` and
/// `let mem0ModelHubLastSyncAttemptMs = 0` from `sync.ts:7-8`.
///
/// The port makes the two module-level variables an explicit, shareable state
/// object (module header, deviation 6). [`Self::trigger`] follows `sync.ts:13-37`
/// step by step: an in-flight attempt is joined, the cooldown window reports
/// `false` without calling the sync, and a fresh attempt stamps the time *before*
/// awaiting.
pub struct Mem0ModelHubSyncState {
    sync: Arc<dyn Mem0ModelHubSync>,
    inner: Mutex<ModelHubSyncInner>,
}

struct ModelHubSyncInner {
    /// The in-flight attempt. Callers that arrive while it runs await the same
    /// cell and therefore observe the same boolean.
    in_flight: Option<Arc<tokio::sync::OnceCell<bool>>>,
    /// `mem0ModelHubLastSyncAttemptMs`, in epoch milliseconds like `Date.now()`.
    last_attempt_ms: i64,
}

/// Which branch of `triggerMem0ModelHubSync` applies, decided under the lock.
enum SyncStep {
    /// `now - lastAttempt < MEM0_MODEL_HUB_SYNC_COOLDOWN_MS` → `false`.
    Cooldown,
    /// `mem0ModelHubSyncInFlight` is set → return the shared result.
    Join(Arc<tokio::sync::OnceCell<bool>>),
    /// A new attempt; the caller is the one that awaits the sync.
    Lead(Arc<tokio::sync::OnceCell<bool>>),
}

impl Mem0ModelHubSyncState {
    /// `new Mem0ModelHubSyncState(sync)`.
    pub fn new(sync: Arc<dyn Mem0ModelHubSync>) -> Self {
        Self {
            sync,
            inner: Mutex::new(ModelHubSyncInner {
                in_flight: None,
                last_attempt_ms: 0,
            }),
        }
    }

    /// The default state: [`NoopModelHubSync`], i.e. the `catch { return false }`
    /// branch of `sync.ts:30`.
    pub fn with_noop() -> Self {
        Self::new(Arc::new(NoopModelHubSync))
    }

    /// `triggerMem0ModelHubSync()` from `sync.ts:13-37`.
    pub async fn trigger(&self) -> bool {
        let now = now_millis();
        let step = {
            let mut inner = self.inner.lock().expect("mem0 sync state lock");
            if let Some(cell) = inner.in_flight.clone() {
                SyncStep::Join(cell)
            } else if now - inner.last_attempt_ms < MEM0_MODEL_HUB_SYNC_COOLDOWN_MS {
                SyncStep::Cooldown
            } else {
                inner.last_attempt_ms = now;
                let cell = Arc::new(tokio::sync::OnceCell::new());
                inner.in_flight = Some(Arc::clone(&cell));
                SyncStep::Lead(cell)
            }
        };

        match step {
            SyncStep::Cooldown => false,
            // The loser of the race never polls its own initialiser, so it
            // observes exactly the boolean the leader computed.
            SyncStep::Join(cell) => *cell.get_or_init(|| async { false }).await,
            SyncStep::Lead(cell) => {
                let sync = Arc::clone(&self.sync);
                let value = *cell.get_or_init(|| async move { sync.sync().await }).await;
                // `finally { mem0ModelHubSyncInFlight = null; }` — `sync.ts:32-34`.
                // The identity check keeps a concurrent reset from clearing the
                // attempt of a *newer* caller.
                let mut inner = self.inner.lock().expect("mem0 sync state lock");
                if inner
                    .in_flight
                    .as_ref()
                    .is_some_and(|current| Arc::ptr_eq(current, &cell))
                {
                    inner.in_flight = None;
                }
                value
            }
        }
    }

    /// `__resetMem0ModelHubSyncStateForTests()` from `sync.ts:42-45`.
    pub fn reset_for_tests(&self) {
        let mut inner = self.inner.lock().expect("mem0 sync state lock");
        inner.in_flight = None;
        inner.last_attempt_ms = 0;
    }

    /// Seam for the cooldown tests: `sync.ts` itself has no setter, its tests
    /// fake `Date.now()` with `vi.useFakeTimers()`.
    pub fn set_last_attempt_ms(&self, last_attempt_ms: i64) {
        self.inner
            .lock()
            .expect("mem0 sync state lock")
            .last_attempt_ms = last_attempt_ms;
    }

    /// `mem0ModelHubLastSyncAttemptMs`, for assertions.
    pub fn last_attempt_ms(&self) -> i64 {
        self.inner
            .lock()
            .expect("mem0 sync state lock")
            .last_attempt_ms
    }

    /// Whether an attempt is currently in flight.
    pub fn is_syncing(&self) -> bool {
        self.inner
            .lock()
            .expect("mem0 sync state lock")
            .in_flight
            .is_some()
    }
}

/// `Date.now()` — epoch milliseconds.
fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

// ─── `mem0/client.ts:43-264` — the client ───────────────────────────────────

/// `class HttpMem0Client implements Mem0Client` from `mem0/client.ts:43-245`.
///
/// The eight operations are the `async` methods below — the port of
/// `operations/**`, which the TypeScript constructor binds in `client.ts:92-107`.
/// The synchronous [`Mem0Client`] contract is implemented further down on top of
/// them through [`drive_sync`] (module header, “The synchronous contract”).
pub struct Mem0HttpClient {
    base_url: String,
    api_path: String,
    api_key: Option<String>,
    read_timeout_ms: u64,
    write_timeout_ms: u64,
    max_retries: u32,
    write_max_retries: u32,
    retry_base_delay_ms: u64,
    transport: Arc<dyn HttpTransport>,
    sync: Arc<Mem0ModelHubSyncState>,
}

impl std::fmt::Debug for Mem0HttpClient {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Mem0HttpClient")
            .field("base_url", &self.base_url)
            .field("api_path", &self.api_path)
            .field("has_api_key", &self.api_key.is_some())
            .field("read_timeout_ms", &self.read_timeout_ms)
            .field("write_timeout_ms", &self.write_timeout_ms)
            .field("max_retries", &self.max_retries)
            .field("write_max_retries", &self.write_max_retries)
            .field("retry_base_delay_ms", &self.retry_base_delay_ms)
            .finish_non_exhaustive()
    }
}

impl Mem0HttpClient {
    /// `createMem0Client(config, fetchImpl)` from `client.ts:256-264`, whose only
    /// validation is the base URL, plus the `new HttpMem0Client(...)` resolution
    /// of `client.ts:68-90`.
    ///
    /// The `fetchImpl` default (`fetch`) has no counterpart: the transport is
    /// required, and [`crate::model_hub::http::UnreachableTransport`] is the
    /// explicit "no client wired" case.
    pub fn new(
        config: Mem0ClientConfig,
        transport: Arc<dyn HttpTransport>,
    ) -> Result<Self, MemoryError> {
        // `if (!config.baseUrl || !config.baseUrl.trim()) throw ...`
        if config.base_url.trim().is_empty() {
            return Err(MemoryError::message(MEM0_BASE_URL_REQUIRED));
        }

        // `config.apiPath || '/v1'`.
        let api_path = config
            .api_path
            .filter(|path| !path.is_empty())
            .unwrap_or_else(|| "/v1".to_string());
        // `config.apiKey?.trim() || undefined`.
        let api_key = config
            .api_key
            .map(|key| key.trim().to_string())
            .filter(|key| !key.is_empty());

        // `client.ts:72-89`. `finite_or` keeps the "absent or non-finite" case
        // separate from the clamp; every fallback here is already a legal value,
        // so clamping it again is the identity.
        let base_timeout_ms =
            clamp_timeout_ms(finite_or(config.timeout_ms, DEFAULT_TIMEOUT_MS as f64));
        let read_timeout_ms =
            clamp_timeout_ms(finite_or(config.read_timeout_ms, base_timeout_ms as f64));
        let write_timeout_ms =
            clamp_timeout_ms(finite_or(config.write_timeout_ms, read_timeout_ms as f64));
        let max_retries = clamp_retries(finite_or(config.max_retries, DEFAULT_MAX_RETRIES as f64));
        let write_max_retries =
            clamp_retries(finite_or(config.write_max_retries, max_retries as f64));
        let retry_base_delay_ms = clamp_delay_ms(finite_or(
            config.retry_base_delay_ms,
            DEFAULT_RETRY_BASE_DELAY_MS as f64,
        ));

        Ok(Self {
            base_url: normalize_base_url(&config.base_url),
            api_path: normalize_api_path(&api_path),
            api_key,
            read_timeout_ms,
            write_timeout_ms,
            max_retries,
            write_max_retries,
            retry_base_delay_ms,
            transport,
            sync: Arc::new(Mem0ModelHubSyncState::with_noop()),
        })
    }

    /// [`Self::new`] with an explicit model-hub sync seam (module header,
    /// deviation 6).
    pub fn with_model_hub_sync(
        config: Mem0ClientConfig,
        transport: Arc<dyn HttpTransport>,
        sync: Arc<Mem0ModelHubSyncState>,
    ) -> Result<Self, MemoryError> {
        Self::new(config, transport).map(|client| client.with_sync(sync))
    }

    /// Replaces the model-hub sync state, keeping every resolved setting.
    pub fn with_sync(mut self, sync: Arc<Mem0ModelHubSyncState>) -> Self {
        self.sync = sync;
        self
    }

    /// `this.baseUrl` — already normalised (no trailing slash).
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// `this.apiPath` — already normalised (`/v1` by default).
    pub fn api_path(&self) -> &str {
        &self.api_path
    }

    /// `this.readTimeoutMs`.
    pub fn read_timeout_ms(&self) -> u64 {
        self.read_timeout_ms
    }

    /// `this.writeTimeoutMs`.
    pub fn write_timeout_ms(&self) -> u64 {
        self.write_timeout_ms
    }

    /// `this.maxRetries`.
    pub fn max_retries(&self) -> u32 {
        self.max_retries
    }

    /// `this.writeMaxRetries`.
    pub fn write_max_retries(&self) -> u32 {
        self.write_max_retries
    }

    /// `this.retryBaseDelayMs`.
    pub fn retry_base_delay_ms(&self) -> u64 {
        self.retry_base_delay_ms
    }

    /// The shared model-hub sync state, so a caller can wire one per process.
    pub fn model_hub_sync_state(&self) -> &Arc<Mem0ModelHubSyncState> {
        &self.sync
    }
}

impl Mem0HttpClient {
    /// `createMem0AbortError()` from `client.ts:247-251`.
    ///
    /// `external.aborted` decides between the caller's cancellation and the
    /// deadline, which is the branch of `client.ts:234-237`.
    fn abort_or_timeout(external: Option<&AbortSignal>, timeout_ms: u64) -> MemoryError {
        if external.is_some_and(AbortSignal::is_aborted) {
            MemoryError::message(MEM0_ABORT_MESSAGE)
        } else {
            MemoryError::message(format!("{MEM0_TIMEOUT_PREFIX}{timeout_ms}ms."))
        }
    }

    /// `requestV2(path, init)` from `client.ts:110-118` — always `/v2`, never any
    /// options, therefore the read timeout and `this.maxRetries`.
    pub async fn request_v2(&self, path: &str, body: Option<&Value>) -> Result<Value, MemoryError> {
        self.request_internal("/v2", path, &Method::POST, body, &RequestOptions::default())
            .await
    }

    /// `request(path, init, options?)` from `client.ts:120-129`.
    ///
    /// The `RequestInit` of `mem0/types.ts:123-126` collapses into `method` plus
    /// an optional JSON `body`; a `GET` never serialises one, exactly like
    /// `client.ts:218`.
    pub async fn request(
        &self,
        path: &str,
        method: Method,
        body: Option<&Value>,
        options: &RequestOptions,
    ) -> Result<Value, MemoryError> {
        self.request_internal(&self.api_path, path, &method, body, options)
            .await
    }

    /// `request(path, init)` without options — the read calls of `recall.ts` and
    /// the deletes of `delete.ts`.
    async fn read_request(&self, path: &str, method: Method) -> Result<Value, MemoryError> {
        self.request_internal(
            &self.api_path,
            path,
            &method,
            None,
            &RequestOptions::default(),
        )
        .await
    }
}

impl Mem0HttpClient {
    /// `requestInternal(apiPath, path, init, options?)` from `client.ts:131-185`.
    ///
    /// The loop is spelled as a `while` with an explicit counter because
    /// `maxAttempts` grows inside the body (the model-hub sync branch of
    /// `client.ts:162-170`), which the `for` header of the source does too.
    async fn request_internal(
        &self,
        api_path: &str,
        path: &str,
        method: &Method,
        body: Option<&Value>,
        options: &RequestOptions,
    ) -> Result<Value, MemoryError> {
        let timeout_ms = match options.timeout_ms {
            Some(value) if value.is_finite() => clamp_timeout_ms(value),
            _ => self.read_timeout_ms,
        };
        let retry_on_timeout = options.retry_on_timeout;
        let max_retries = match options.max_retries {
            Some(value) if value.is_finite() => clamp_retries(value),
            _ => self.max_retries,
        };
        let external = options.signal.clone();
        let mut max_attempts = 1 + u64::from(max_retries);
        let mut last_error: Option<MemoryError> = None;

        let mut attempt: u64 = 0;
        while attempt < max_attempts {
            // "Bail out immediately if the caller already aborted." — `client.ts:153`.
            if external.as_ref().is_some_and(AbortSignal::is_aborted) {
                return Err(MemoryError::message(MEM0_ABORT_MESSAGE));
            }

            match self
                .request_once(api_path, path, method, body, timeout_ms, external.as_ref())
                .await
            {
                Ok(payload) => return Ok(payload),
                Err(error) => {
                    // "Never retry after an external abort." — `client.ts:161`.
                    if external.as_ref().is_some_and(AbortSignal::is_aborted) {
                        last_error = Some(error);
                        break;
                    }
                    // The sync-triggering errors of `client.ts:162-170`.
                    let syncable = is_mem0_runtime_unconfigured_error(&error)
                        || is_mem0_invalid_model_config_error(&error);
                    if syncable && self.sync.trigger().await {
                        if attempt + 1 >= max_attempts {
                            max_attempts += 1;
                        }
                        last_error = Some(error);
                        attempt += 1;
                        continue;
                    }
                    let retries_left = max_attempts.saturating_sub(attempt + 1);
                    let retryable = is_transient_http_error(&error)
                        || (retry_on_timeout && is_timeout_error(&error));
                    if retries_left == 0 || !retryable {
                        return Err(error);
                    }
                    last_error = Some(error);
                    sleep_ms(retry_delay_ms(self.retry_base_delay_ms, attempt as u32)).await;
                }
            }
            attempt += 1;
        }

        Err(last_error.unwrap_or_else(|| MemoryError::message(MEM0_NO_RESPONSE_MESSAGE)))
    }
}

impl Mem0HttpClient {
    /// `requestOnce(apiPath, path, init, timeoutMs, externalSignal?)` from
    /// `client.ts:187-244`.
    ///
    /// Headers, body serialisation, the JSON coercion
    /// (`response.json().catch(() => ({}))`) and the status mapping are the same;
    /// the `AbortController`/`setTimeout` pair is the transport's job, which is
    /// why the deadline travels inside the [`HttpRequest`].
    async fn request_once(
        &self,
        api_path: &str,
        path: &str,
        method: &Method,
        body: Option<&Value>,
        timeout_ms: u64,
        external: Option<&AbortSignal>,
    ) -> Result<Value, MemoryError> {
        let mut request =
            HttpRequest::new(method.clone(), join_url(&self.base_url, api_path, path))
                .header("Content-Type", "application/json")
                .timeout_ms(timeout_ms);
        if let Some(api_key) = &self.api_key {
            request = request.header("Authorization", &format!("Bearer {api_key}"));
        }
        // `init.body && init.method !== 'GET' ? JSON.stringify(init.body) : undefined`
        if *method != Method::GET {
            if let Some(body) = body.filter(|body| !body.is_null()) {
                request = request.json_body(body);
            }
        }
        if let Some(signal) = external {
            request = request.abort(signal.clone());
        }

        match fetch_with_timeout(self.transport.as_ref(), request).await {
            Ok(response) => {
                let payload = serde_json::from_str::<Value>(&response.body)
                    .unwrap_or_else(|_| Value::Object(Map::new()));
                if !response.is_ok() {
                    let detail = extract_error_detail(&payload);
                    let suffix = if detail.is_empty() {
                        String::new()
                    } else {
                        format!(": {detail}")
                    };
                    return Err(MemoryError::message(format!(
                        "Mem0 request failed with HTTP {}{suffix}.",
                        response.status.as_u16()
                    )));
                }
                Ok(payload)
            }
            // The transport reports the caller's signal as `Aborted` and the
            // deadline as `Timeout`; `abort_or_timeout` re-checks the signal so a
            // concurrent cancellation still wins (`client.ts:230-238`).
            Err(HttpError::Aborted | HttpError::Timeout) => {
                Err(Self::abort_or_timeout(external, timeout_ms))
            }
            Err(error) => Err(MemoryError::message(error.to_string())),
        }
    }
}

// ─── `mem0/operations/store.ts` + `mem0/operations/delete.ts` ───────────────

impl Mem0HttpClient {
    /// `addMemory(input)` from `store.ts:24-48`, the `signal: undefined` case.
    pub async fn add_memory(&self, input: &Mem0MemoryInput) -> Result<Mem0AddResult, MemoryError> {
        self.add_memory_with_signal(input, None).await
    }

    /// `addMemory(input, signal?)` from `store.ts:24-48`.
    ///
    /// `POST /memories` with a single user message, `infer: false`, the caller's
    /// metadata and the write deadline/retries; the reply is parsed with
    /// [`extract_id`], so an array, a `results` envelope or a flat `id` all work.
    pub async fn add_memory_with_signal(
        &self,
        input: &Mem0MemoryInput,
        signal: Option<AbortSignal>,
    ) -> Result<Mem0AddResult, MemoryError> {
        let body = json!({
            "messages": [{ "role": "user", "content": input.content }],
            "user_id": input.user_id,
            "agent_id": input.persona_id,
            "metadata": Value::Object(input.metadata.clone()),
            "infer": false,
        });
        let payload = self
            .request(
                "/memories",
                Method::POST,
                Some(&body),
                &RequestOptions::write_with_signal(
                    self.write_timeout_ms,
                    self.write_max_retries,
                    signal,
                ),
            )
            .await?;
        Ok(Mem0AddResult::from_id(extract_id(&payload)))
    }

    /// `updateMemory(id, input)` from `store.ts:62-79`.
    ///
    /// `PUT /memories/{id}` with `text` (not `content`), the metadata and both
    /// scope ids — the endpoint the ignore-`scope` deviation applies to.
    pub async fn update_memory(
        &self,
        id: &str,
        input: &Mem0MemoryInput,
    ) -> Result<(), MemoryError> {
        let body = json!({
            "text": input.content,
            "metadata": Value::Object(input.metadata.clone()),
            "user_id": input.user_id,
            "agent_id": input.persona_id,
        });
        self.request(
            &format!("/memories/{}", encode_uri_component(id)),
            Method::PUT,
            Some(&body),
            &RequestOptions::write(self.write_timeout_ms, self.write_max_retries),
        )
        .await?;
        Ok(())
    }

    /// `deleteMemory(id)` from `delete.ts:19-29`.
    ///
    /// `DELETE /memories/{id}` without a body; the reply is discarded.
    pub async fn delete_memory(&self, id: &str) -> Result<(), MemoryError> {
        self.request(
            &format!("/memories/{}", encode_uri_component(id)),
            Method::DELETE,
            None,
            &RequestOptions::write(self.write_timeout_ms, self.write_max_retries),
        )
        .await?;
        Ok(())
    }

    /// `deleteMemoriesByFilter(input)` from `delete.ts:43-84`.
    ///
    /// First the body form `DELETE /memories` with
    /// `{ user_id, agent_id[, workspace_id] }`; only a
    /// [`is_legacy_delete_filter_error`] (400/404/405) falls back to the query
    /// form `DELETE /memories?user_id=…&agent_id=…`. Both shapes count through
    /// [`extract_deleted_count`].
    pub async fn delete_memories_by_filter(
        &self,
        input: &Mem0DeleteByFilterInput,
    ) -> Result<i64, MemoryError> {
        let options = RequestOptions::write(self.write_timeout_ms, self.write_max_retries);
        // `...(input.workspaceId ? { workspace_id } : {})` — an empty string is
        // falsy and is therefore omitted, in the body *and* in the query.
        let workspace_id = input.workspace_id.as_deref().filter(|id| !id.is_empty());

        let mut body = Map::new();
        body.insert("user_id".to_string(), Value::String(input.user_id.clone()));
        body.insert(
            "agent_id".to_string(),
            Value::String(input.persona_id.clone()),
        );
        if let Some(workspace_id) = workspace_id {
            body.insert(
                "workspace_id".to_string(),
                Value::String(workspace_id.to_string()),
            );
        }

        match self
            .request(
                "/memories",
                Method::DELETE,
                Some(&Value::Object(body)),
                &options,
            )
            .await
        {
            Ok(payload) => Ok(extract_deleted_count(&payload)),
            Err(error) => {
                if !is_legacy_delete_filter_error(&error) {
                    return Err(error);
                }
                let mut params: Vec<(&str, &str)> = vec![
                    ("user_id", input.user_id.as_str()),
                    ("agent_id", input.persona_id.as_str()),
                ];
                if let Some(workspace_id) = workspace_id {
                    params.push(("workspace_id", workspace_id));
                }
                let payload = self
                    .request(
                        &format!("/memories?{}", form_urlencode(&params)),
                        Method::DELETE,
                        None,
                        &options,
                    )
                    .await?;
                Ok(extract_deleted_count(&payload))
            }
        }
    }
}

/// `shouldTryV1Fallback(input, memories, total)` from `recall.ts:22-24`.
///
/// Only the first page probes v1, and only when v2 returned nothing at all.
pub fn should_try_v1_fallback(
    input: &Mem0ListInput,
    memories: &[Mem0MemoryRecord],
    total: i64,
) -> bool {
    input.page.max(1) == 1 && memories.is_empty() && total == 0
}

// ─── `mem0/operations/recall.ts` ────────────────────────────────────────────

impl Mem0HttpClient {
    /// `searchMemories(input)` from `recall.ts:39-72`.
    ///
    /// First `POST /v2/memories/search` with
    /// `{ query, filters: { user_id, agent_id, ...input.filters }, top_k, limit }`;
    /// only a [`is_v2_unavailable_error`] (404/405) falls back to
    /// `POST /search` with the flat body. The caller's `filters` win over the
    /// derived `user_id`/`agent_id`, exactly like an object spread.
    pub async fn search_memories(
        &self,
        input: &Mem0SearchInput,
    ) -> Result<Vec<Mem0SearchHit>, MemoryError> {
        let mut base_filters = Map::new();
        base_filters.insert("user_id".to_string(), Value::String(input.user_id.clone()));
        base_filters.insert(
            "agent_id".to_string(),
            Value::String(input.persona_id.clone()),
        );
        if let Some(filters) = &input.filters {
            for (key, value) in filters {
                // An existing key keeps its position and takes the new value.
                base_filters.insert(key.clone(), value.clone());
            }
        }

        let v2_body = json!({
            "query": input.query,
            "filters": Value::Object(base_filters),
            "top_k": input.limit,
            "limit": input.limit,
        });
        match self.request_v2("/memories/search", Some(&v2_body)).await {
            Ok(payload) => return Ok(extract_hits(&payload)),
            Err(error) => {
                if !is_v2_unavailable_error(&error) {
                    return Err(error);
                }
            }
        }

        let v1_body = json!({
            "query": input.query,
            "user_id": input.user_id,
            "agent_id": input.persona_id,
            "top_k": input.limit,
            "limit": input.limit,
        });
        let payload = self
            .request(
                "/search",
                Method::POST,
                Some(&v1_body),
                &RequestOptions::default(),
            )
            .await?;
        Ok(extract_hits(&payload))
    }

    /// `listMemories(input)` from `recall.ts:126-177`.
    ///
    /// `POST /v2/memories` with the `filters` envelope, the page and the trimmed
    /// query; the v2 result is used as-is unless the first page was empty
    /// *and* the total is `0`, in which case the v1 endpoint is probed and wins
    /// only when it returns something. A non-404/405 failure falls straight
    /// through to [`Self::list_via_v1`].
    pub async fn list_memories(
        &self,
        input: &Mem0ListInput,
    ) -> Result<Mem0ListMemoryResult, MemoryError> {
        let page = input.page.max(1);
        let page_size = input.page_size.max(1);

        let mut filters = Map::new();
        filters.insert("user_id".to_string(), Value::String(input.user_id.clone()));
        if let Some(persona_id) = input.persona_id.as_deref().filter(|id| !id.is_empty()) {
            filters.insert(
                "agent_id".to_string(),
                Value::String(persona_id.to_string()),
            );
        }
        if let Some(node_type) = input.node_type.as_deref().filter(|value| !value.is_empty()) {
            filters.insert("type".to_string(), Value::String(node_type.to_string()));
        }

        let mut body = Map::new();
        body.insert("filters".to_string(), Value::Object(filters));
        body.insert("page".to_string(), json!(page));
        body.insert("page_size".to_string(), json!(page_size));
        // `...(input.query?.trim() ? { query: input.query.trim() } : {})`
        if let Some(query) = input
            .query
            .as_deref()
            .map(str::trim)
            .filter(|query| !query.is_empty())
        {
            body.insert("query".to_string(), Value::String(query.to_string()));
        }

        match self
            .request_v2("/memories", Some(&Value::Object(body)))
            .await
        {
            Ok(payload) => {
                let memories: Vec<Mem0MemoryRecord> = extract_memories(&payload)
                    .iter()
                    .filter_map(to_memory_record)
                    .collect();
                let meta = extract_list_meta(&payload, page, page_size);
                // `meta.total > 0 ? meta.total : memories.length`
                let total = if meta.total > 0 {
                    meta.total
                } else {
                    memories.len() as i64
                };

                if should_try_v1_fallback(input, &memories, total) {
                    // "Keep v2 result when v1 fallback probe fails." — `recall.ts:162-164`.
                    if let Ok(fallback) = self.list_via_v1(input).await {
                        if fallback.total > 0 || !fallback.memories.is_empty() {
                            return Ok(fallback);
                        }
                    }
                }

                Ok(Mem0ListMemoryResult {
                    memories,
                    total,
                    page: meta.page,
                    page_size: meta.page_size,
                })
            }
            Err(error) => {
                if !is_v2_unavailable_error(&error) {
                    return Err(error);
                }
                self.list_via_v1(input).await
            }
        }
    }
}

impl Mem0HttpClient {
    /// `listViaV1(input)` from `recall.ts:88-124`.
    ///
    /// `GET /memories?user_id=…[&agent_id=…]`, then the type filter on
    /// `String(metadata.type || '')`, the query filter on
    /// `normalizeText(content).includes(normalizeText(query))` and a manual
    /// in-memory slice because v1 has no pagination.
    pub async fn list_via_v1(
        &self,
        input: &Mem0ListInput,
    ) -> Result<Mem0ListMemoryResult, MemoryError> {
        let page = input.page.max(1);
        let page_size = input.page_size.max(1);

        let mut params: Vec<(&str, &str)> = vec![("user_id", input.user_id.as_str())];
        if let Some(persona_id) = input.persona_id.as_deref().filter(|id| !id.is_empty()) {
            params.push(("agent_id", persona_id));
        }
        let path = format!("/memories?{}", form_urlencode(&params));
        let payload = self.read_request(&path, Method::GET).await?;

        // `input.query ? normalizeText(input.query) : ''`
        let trimmed_query = match input.query.as_deref() {
            Some(query) if !query.is_empty() => normalize_text(query),
            _ => String::new(),
        };
        let memories: Vec<Mem0MemoryRecord> = extract_memories(&payload)
            .iter()
            .filter_map(to_memory_record)
            .filter(|record| match input.node_type.as_deref() {
                Some(node_type) if !node_type.is_empty() => {
                    js_string(record.metadata.get("type")).trim() == node_type
                }
                _ => true,
            })
            .filter(|record| {
                trimmed_query.is_empty() || normalize_text(&record.content).contains(&trimmed_query)
            })
            .collect();

        let total = memories.len() as i64;
        let start = (page - 1).saturating_mul(page_size).max(0) as usize;
        let paged = memories
            .into_iter()
            .skip(start)
            .take(page_size as usize)
            .collect();

        Ok(Mem0ListMemoryResult {
            memories: paged,
            total,
            page,
            page_size,
        })
    }

    /// `getMemory(id)` from `recall.ts:186-193`.
    ///
    /// `GET /memories/{id}`, accepting either the memory itself or a wrapper
    /// whose `memory` key holds it.
    pub async fn get_memory(&self, id: &str) -> Result<Option<Mem0MemoryRecord>, MemoryError> {
        let payload = self
            .read_request(
                &format!("/memories/{}", encode_uri_component(id)),
                Method::GET,
            )
            .await?;
        if let Some(direct) = to_memory_record(&payload) {
            return Ok(Some(direct));
        }
        let nested = pick_record(Some(&payload))
            .remove("memory")
            .unwrap_or(Value::Null);
        Ok(to_memory_record(&nested))
    }

    /// `getMemoryHistory(id)` from `recall.ts:202-207`.
    pub async fn get_memory_history(&self, id: &str) -> Result<Vec<Mem0HistoryEntry>, MemoryError> {
        let payload = self
            .read_request(
                &format!("/memories/{}/history", encode_uri_component(id)),
                Method::GET,
            )
            .await?;
        Ok(extract_history(&payload))
    }
}

// ─── The synchronous `Mem0Client` contract ──────────────────────────────────

/// Drives one operation future to completion for the synchronous [`Mem0Client`]
/// contract.
///
/// The TypeScript client is always `async`, so there is no source to mirror;
/// this bridge is the price of the synchronous trait (module header, “The
/// synchronous contract”). Three cases:
///
/// * inside a multi-threaded runtime the current worker is released with
///   `block_in_place` and the future is driven through the runtime handle;
/// * inside a current-thread runtime the driver *is* the calling thread, so
///   blocking would dead-lock it — [`MEM0_SYNC_BRIDGE_MESSAGE`] is returned and
///   the caller has to use the async methods;
/// * outside any runtime a temporary current-thread runtime is created, which is
///   what a plain `#[test]` or a blocking gateway thread does.
fn drive_sync<T>(future: impl Future<Output = T>) -> Result<T, MemoryError> {
    match tokio::runtime::Handle::try_current() {
        Ok(handle) if handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => {
            Ok(tokio::task::block_in_place(|| handle.block_on(future)))
        }
        Ok(_) => Err(MemoryError::message(MEM0_SYNC_BRIDGE_MESSAGE)),
        Err(_) => {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|error| MemoryError::storage(format!("tokio runtime: {error}")))?;
            Ok(runtime.block_on(future))
        }
    }
}

/// `HttpMem0Client` as the provider the rest of the slice consumes.
///
/// Every method delegates to the inherent `async` operation of the same name;
/// the trailing `?` unwraps the *bridge* result (a runtime problem, see
/// [`drive_sync`]) while the operation's own [`Result`] stays the return value.
/// Method-call syntax is required for the delegation: an inherent method wins
/// over the trait method of the same name, whereas `Mem0HttpClient::name`
/// resolves to this impl. A resolution mistake could not slip through either —
/// the trait methods return [`Result`]s, [`drive_sync`] demands a `Future`.
/// The optional [`Mem0Scope`] arguments are dropped, exactly as the TypeScript
/// HTTP provider drops them (module header, deviation 3).
impl Mem0Client for Mem0HttpClient {
    fn add_memory(&self, input: &Mem0MemoryInput) -> Result<Mem0AddResult, MemoryError> {
        drive_sync(self.add_memory(input))?
    }

    fn search_memories(&self, input: &Mem0SearchInput) -> Result<Vec<Mem0SearchHit>, MemoryError> {
        drive_sync(self.search_memories(input))?
    }

    fn list_memories(&self, input: &Mem0ListInput) -> Result<Mem0ListMemoryResult, MemoryError> {
        drive_sync(self.list_memories(input))?
    }

    fn get_memory(
        &self,
        id: &str,
        _scope: Option<&Mem0Scope>,
    ) -> Result<Option<Mem0MemoryRecord>, MemoryError> {
        drive_sync(self.get_memory(id))?
    }

    fn get_memory_history(
        &self,
        id: &str,
        _scope: Option<&Mem0Scope>,
    ) -> Result<Vec<Mem0HistoryEntry>, MemoryError> {
        drive_sync(self.get_memory_history(id))?
    }

    fn update_memory(
        &self,
        id: &str,
        input: &Mem0MemoryInput,
        _scope: Option<&Mem0Scope>,
    ) -> Result<(), MemoryError> {
        drive_sync(self.update_memory(id, input))?
    }

    fn delete_memory(&self, id: &str, _scope: Option<&Mem0Scope>) -> Result<(), MemoryError> {
        drive_sync(self.delete_memory(id))?
    }

    fn delete_memories_by_filter(
        &self,
        input: &Mem0DeleteByFilterInput,
    ) -> Result<i64, MemoryError> {
        drive_sync(self.delete_memories_by_filter(input))?
    }
}

// ─── `mem0/client.ts:269-338` — configuration from the environment ───────────

/// `Number(env[key] || fallback)` — the `||` form of `client.ts:299`, where an
/// empty string selects the fallback and a whitespace-only string is `0`.
fn env_number_or(env: &HashMap<String, String>, key: &str, fallback: f64) -> f64 {
    match env.get(key) {
        Some(text) if !text.is_empty() => js_number_str(text),
        _ => fallback,
    }
}

/// `Number(env[key] ?? fallback)` — the `??` form of `client.ts:303`, `:307`,
/// `:312`, `:314` and `:319`, where a present-but-empty string is `0`.
fn env_number_nullish(env: &HashMap<String, String>, key: &str, fallback: f64) -> f64 {
    match env.get(key) {
        Some(text) => js_number_str(text),
        None => fallback,
    }
}

/// `createMem0ClientFromEnv(env, fetchImpl)` from `client.ts:269-338`.
///
/// `Ok(None)` is the TypeScript `null` ("mem0 is not the configured provider"),
/// `Err` is the three configuration errors. `env` is a `Record<string,
/// string | undefined>`; a missing key is `undefined` here as well, which is why
/// the `??` reads of the source survive as [`env_number_nullish`].
pub fn create_mem0_client_from_env(
    env: &HashMap<String, String>,
    transport: Arc<dyn HttpTransport>,
) -> Result<Option<Mem0HttpClient>, MemoryError> {
    let node_env = env
        .get("NODE_ENV")
        .map(|value| value.trim().to_lowercase())
        .unwrap_or_default();
    let is_production = node_env == "production";
    let provider = env
        .get("MEMORY_PROVIDER")
        .map(|value| value.trim().to_lowercase())
        .unwrap_or_default();

    if is_production && provider != "mem0" {
        return Err(MemoryError::message(MEM0_PRODUCTION_REQUIRES_MEM0));
    }
    // `if (provider && provider !== 'mem0') return null;`
    if !provider.is_empty() && provider != "mem0" {
        return Ok(None);
    }

    let base_url = env
        .get("MEM0_BASE_URL")
        .map(|value| value.trim())
        .unwrap_or("");
    let api_key = env
        .get("MEM0_API_KEY")
        .map(|value| value.trim())
        .unwrap_or("");
    if provider == "mem0" && base_url.is_empty() {
        return Err(MemoryError::message(MEM0_ENV_BASE_URL_REQUIRED));
    }
    if provider == "mem0" && api_key.is_empty() {
        return Err(MemoryError::message(MEM0_ENV_API_KEY_REQUIRED));
    }
    if base_url.is_empty() {
        return Ok(None);
    }

    // `client.ts:299-322`: the `||`/`??` defaults are followed by a
    // `Number.isFinite` guard whose fallback is the value the default resolved
    // to, so a `NaN` keeps the previous step instead of dropping to zero.
    let timeout_raw = env_number_or(env, "MEM0_TIMEOUT_MS", DEFAULT_TIMEOUT_MS as f64);
    let timeout_ms = if timeout_raw.is_finite() {
        clamp_timeout_ms(timeout_raw)
    } else {
        DEFAULT_TIMEOUT_MS
    };
    let read_timeout_raw = env_number_nullish(env, "MEM0_READ_TIMEOUT_MS", timeout_ms as f64);
    let read_timeout_ms = if read_timeout_raw.is_finite() {
        clamp_timeout_ms(read_timeout_raw)
    } else {
        timeout_ms
    };
    let write_timeout_raw =
        env_number_nullish(env, "MEM0_WRITE_TIMEOUT_MS", read_timeout_ms as f64);
    let write_timeout_ms = if write_timeout_raw.is_finite() {
        clamp_timeout_ms(write_timeout_raw)
    } else {
        read_timeout_ms
    };
    let max_retries_raw = env_number_nullish(env, "MEM0_MAX_RETRIES", 1.0);
    let max_retries = if max_retries_raw.is_finite() {
        clamp_retries(max_retries_raw)
    } else {
        1
    };
    let write_max_retries_raw = env_number_nullish(env, "MEM0_WRITE_MAX_RETRIES", 0.0);
    let write_max_retries = if write_max_retries_raw.is_finite() {
        clamp_retries(write_max_retries_raw)
    } else {
        0
    };
    let retry_delay_raw = env_number_nullish(
        env,
        "MEM0_RETRY_BASE_DELAY_MS",
        DEFAULT_RETRY_BASE_DELAY_MS as f64,
    );
    let retry_base_delay_ms = if retry_delay_raw.is_finite() {
        clamp_delay_ms(retry_delay_raw)
    } else {
        DEFAULT_RETRY_BASE_DELAY_MS
    };

    // `String(env.MEM0_API_PATH || '/v1').trim() || '/v1'`
    let api_path = env
        .get("MEM0_API_PATH")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or("/v1");

    Mem0HttpClient::new(
        Mem0ClientConfig {
            base_url: base_url.to_string(),
            api_path: Some(api_path.to_string()),
            api_key: Some(api_key.to_string()).filter(|key| !key.is_empty()),
            timeout_ms: Some(timeout_ms as f64),
            read_timeout_ms: Some(read_timeout_ms as f64),
            write_timeout_ms: Some(write_timeout_ms as f64),
            max_retries: Some(max_retries as f64),
            write_max_retries: Some(write_max_retries as f64),
            retry_base_delay_ms: Some(retry_base_delay_ms as f64),
        },
        transport,
    )
    .map(Some)
}

/// [`create_mem0_client_from_env`] reading `process.env`.
pub fn create_mem0_client_from_process_env(
    transport: Arc<dyn HttpTransport>,
) -> Result<Option<Mem0HttpClient>, MemoryError> {
    let env: HashMap<String, String> = std::env::vars().collect();
    create_mem0_client_from_env(&env, transport)
}

// ─── `mem0/operations/feedback.ts` — the placeholders ───────────────────────

/// `FeedbackRating` from `feedback.ts:12`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeedbackRating {
    Positive,
    Negative,
    Neutral,
}

impl FeedbackRating {
    pub fn as_str(self) -> &'static str {
        match self {
            FeedbackRating::Positive => "positive",
            FeedbackRating::Negative => "negative",
            FeedbackRating::Neutral => "neutral",
        }
    }
}

/// `FeedbackInput` from `feedback.ts:17-21`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeedbackInput {
    pub memory_id: String,
    pub rating: FeedbackRating,
    pub comment: Option<String>,
}

/// `{ success: boolean }` of `feedback.ts:29`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FeedbackOutcome {
    pub success: bool,
}

/// `createFeedbackOperation()` from `feedback.ts:28-34`.
///
/// mem0 exposes no feedback endpoint, so the placeholder answers `false` without
/// touching the transport; `_input` is kept for signature parity.
pub async fn submit_feedback(_input: &FeedbackInput) -> FeedbackOutcome {
    FeedbackOutcome { success: false }
}

/// `createGetFeedbackOperation()` from `feedback.ts:41-46`.
///
/// The `Promise<unknown[]>` placeholder: always empty.
pub async fn get_memory_feedback(_memory_id: &str) -> Vec<Value> {
    Vec::new()
}

// ─── `mem0/index.ts:56-68` — the re-exported HTTP helpers ───────────────────

/// `normalizeBaseUrl`, `normalizeApiPath`, `joinUrl` and `normalizeText` from
/// `mem0/utils/http.ts:10-36` already live in [`crate::memory::utils`]; they are
/// re-exported here because `mem0/index.ts:56-68` exposes them through the mem0
/// entry point.
pub use crate::memory::utils::{join_url, normalize_api_path, normalize_base_url, normalize_text};

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, VecDeque};

    use http::StatusCode;
    use serde_json::json;

    use super::*;
    use crate::model_hub::http::HttpResponse;

    /// One queued reply of [`StubTransport`].
    enum Reply {
        /// `new Response(JSON.stringify(value), { status })`.
        Json(StatusCode, Value),
        /// A body that is not JSON, which `response.json()` rejects.
        Text(StatusCode, String),
        /// A transport-level failure (deadline, abort, socket).
        Failure(HttpError),
    }

    /// Records every [`HttpRequest`] and replays a queue of replies in order,
    /// which is how the TypeScript suites model
    /// `fetchMock.mockResolvedValueOnce(...)`.
    struct StubTransport {
        replies: Mutex<VecDeque<Reply>>,
        seen: Mutex<Vec<HttpRequest>>,
    }

    impl StubTransport {
        fn new(replies: Vec<Reply>) -> Arc<Self> {
            Arc::new(Self {
                replies: Mutex::new(replies.into()),
                seen: Mutex::new(Vec::new()),
            })
        }

        /// A queue of `200 application/json` replies.
        fn json(values: Vec<Value>) -> Arc<Self> {
            Self::new(
                values
                    .into_iter()
                    .map(|value| Reply::Json(StatusCode::OK, value))
                    .collect(),
            )
        }

        fn requests(&self) -> Vec<HttpRequest> {
            self.seen.lock().expect("seen lock").clone()
        }

        fn call_count(&self) -> usize {
            self.seen.lock().expect("seen lock").len()
        }

        fn only_request(&self) -> HttpRequest {
            let requests = self.requests();
            assert_eq!(requests.len(), 1, "exactly one request expected");
            requests.into_iter().next().expect("checked")
        }
    }

    impl HttpTransport for StubTransport {
        fn send<'a>(
            &'a self,
            request: HttpRequest,
        ) -> BoxFuture<'a, Result<HttpResponse, HttpError>> {
            self.seen.lock().expect("seen lock").push(request.clone());
            let reply = self
                .replies
                .lock()
                .expect("replies lock")
                .pop_front()
                .expect("no reply queued for this request");
            Box::pin(async move {
                match reply {
                    Reply::Json(status, value) => Ok(HttpResponse::json(status, &value)),
                    Reply::Text(status, body) => Ok(HttpResponse::text(status, body)),
                    Reply::Failure(error) => Err(error),
                }
            })
        }
    }

    /// The `BASE_CONFIG` of `mem0-client-retry.test.ts:18-24` plus the api key of
    /// the operations suite.
    fn config() -> Mem0ClientConfig {
        Mem0ClientConfig {
            base_url: "http://mem0.local".to_string(),
            api_path: Some("/v1".to_string()),
            api_key: Some("secret".to_string()),
            timeout_ms: Some(4000.0),
            ..Mem0ClientConfig::default()
        }
    }

    fn client_with(transport: &Arc<StubTransport>, config: Mem0ClientConfig) -> Mem0HttpClient {
        let transport: Arc<dyn HttpTransport> = transport.clone();
        Mem0HttpClient::new(config, transport).expect("client")
    }

    fn client(transport: &Arc<StubTransport>) -> Mem0HttpClient {
        client_with(transport, config())
    }

    fn memory_input() -> Mem0MemoryInput {
        Mem0MemoryInput {
            user_id: "user-1".to_string(),
            persona_id: "persona-1".to_string(),
            workspace_id: None,
            content: "Ich trinke Kaffee schwarz".to_string(),
            metadata: Map::from_iter([
                ("type".to_string(), json!("fact")),
                ("importance".to_string(), json!(4)),
            ]),
        }
    }

    fn header(request: &HttpRequest, name: &str) -> String {
        request
            .headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string()
    }

    fn body_json(request: &HttpRequest) -> Value {
        serde_json::from_str(request.body.as_deref().expect("a body")).expect("json body")
    }

    /// `it('posts add memory with scoped payload')` —
    /// `mem0-client.operations.cases.ts:7-49`.
    ///
    /// Every part of the request is asserted, including the byte-exact body:
    /// `serde_json` is built with `preserve_order`, so the key order of the
    /// object literal in `store.ts:32-38` survives the serialisation.
    #[tokio::test]
    async fn add_memory_posts_the_scoped_payload() {
        let transport = StubTransport::json(vec![json!([
            { "id": "mem0-1", "memory": "Ich trinke Kaffee schwarz" }
        ])]);
        let client = client(&transport);

        let result = client.add_memory(&memory_input()).await.expect("add");

        assert_eq!(result.id.as_deref(), Some("mem0-1"));
        let request = transport.only_request();
        assert_eq!(request.url, "http://mem0.local/v1/memories");
        assert_eq!(request.method, Method::POST);
        assert_eq!(header(&request, "content-type"), "application/json");
        assert_eq!(header(&request, "authorization"), "Bearer secret");
        assert_eq!(request.timeout_ms, 4000);
        assert_eq!(
            request.body.as_deref(),
            Some(concat!(
                r#"{"messages":[{"role":"user","content":"Ich trinke Kaffee schwarz"}],"#,
                r#""user_id":"user-1","agent_id":"persona-1","#,
                r#""metadata":{"type":"fact","importance":4},"infer":false}"#
            )),
            "the body must be JSON.stringify of store.ts:32-38"
        );
    }

    /// `it('extracts memory id from results envelope on add memory')` —
    /// `mem0-client.operations.cases.ts:222-253`.
    #[tokio::test]
    async fn add_memory_reads_the_id_from_a_results_envelope() {
        let transport = StubTransport::json(vec![json!({
            "results": [{ "id": "mem0-results-1", "memory": "Ich trinke Tee" }]
        })]);
        let client = client(&transport);

        let result = client.add_memory(&memory_input()).await.expect("add");

        assert_eq!(result.id.as_deref(), Some("mem0-results-1"));
        assert!(result.created, "the POST is reported as a creation");
    }

    /// Without an api key there is no `Authorization` header, the api path falls
    /// back to `/v1` and the read timeout to [`DEFAULT_TIMEOUT_MS`] — the
    /// `createMem0Client({ baseUrl, apiPath: '/v1' })` shape of the suites.
    #[tokio::test]
    async fn the_default_config_has_no_authorization_and_the_default_timeout() {
        let transport = StubTransport::json(vec![json!({ "id": "mem0-bare" })]);
        let client = client_with(
            &transport,
            Mem0ClientConfig {
                base_url: "http://mem0.local//".to_string(),
                ..Mem0ClientConfig::default()
            },
        );

        let result = client.add_memory(&memory_input()).await.expect("add");

        assert_eq!(result.id.as_deref(), Some("mem0-bare"));
        let request = transport.only_request();
        assert_eq!(
            request.url, "http://mem0.local/v1/memories",
            "trailing slashes are stripped and the api path defaults to /v1"
        );
        assert_eq!(header(&request, "authorization"), "");
        assert_eq!(request.timeout_ms, DEFAULT_TIMEOUT_MS);
        assert_eq!(client.base_url(), "http://mem0.local");
        assert_eq!(client.api_path(), "/v1");
    }

    /// `updateMemory(id, input)` — `store.ts:62-79`, including
    /// `encodeURIComponent(id)` in the path.
    #[tokio::test]
    async fn update_memory_puts_text_and_metadata() {
        let transport = StubTransport::json(vec![json!({ "id": "a/b" })]);
        let client = client(&transport);

        client
            .update_memory("a/b", &memory_input())
            .await
            .expect("update");

        let request = transport.only_request();
        assert_eq!(request.url, "http://mem0.local/v1/memories/a%2Fb");
        assert_eq!(request.method, Method::PUT);
        assert_eq!(request.timeout_ms, 4000, "the write deadline");
        assert_eq!(
            body_json(&request),
            json!({
                "text": "Ich trinke Kaffee schwarz",
                "metadata": { "type": "fact", "importance": 4 },
                "user_id": "user-1",
                "agent_id": "persona-1",
            })
        );
    }

    /// `deleteMemory(id)` — `delete.ts:19-29`: `DELETE` without a body.
    #[tokio::test]
    async fn delete_memory_sends_the_id_and_no_body() {
        let transport = StubTransport::json(vec![json!({ "deleted": 1 })]);
        let client = client(&transport);

        client.delete_memory("mem0-1").await.expect("delete");

        let request = transport.only_request();
        assert_eq!(request.url, "http://mem0.local/v1/memories/mem0-1");
        assert_eq!(request.method, Method::DELETE);
        assert!(request.body.is_none());
        assert_eq!(header(&request, "authorization"), "Bearer secret");
    }

    /// `getMemory(id)` — `recall.ts:186-193`: the wrapper carrying a `memory` key
    /// is unwrapped when the payload itself is not a record.
    #[tokio::test]
    async fn get_memory_unwraps_the_memory_key() {
        let transport = StubTransport::json(vec![json!({
            "memory": { "id": "mem0-1", "text": "Alpha", "score": 0.5 }
        })]);
        let client = client(&transport);

        let record = client
            .get_memory("mem0-1")
            .await
            .expect("get")
            .expect("some");

        assert_eq!(record.id, "mem0-1");
        assert_eq!(record.content, "Alpha");
        assert_eq!(
            record.score, None,
            "`toMemoryRecord` reads the score from the top level only, so the \
             nested `score` of the unwrapped memory is not picked up"
        );
        assert_eq!(
            transport.only_request().url,
            "http://mem0.local/v1/memories/mem0-1"
        );
    }

    /// `getMemoryHistory(id)` — `recall.ts:202-207`; the response fixture is the
    /// one of `mem0-client.fallbacks-timeout.cases.ts:197-237`.
    #[tokio::test]
    async fn get_memory_history_reads_the_history_endpoint() {
        let transport = StubTransport::json(vec![json!([
            {
                "action": "update",
                "timestamp": "2026-02-15T10:00:00.000Z",
                "content": "updated memory content",
                "metadata": { "version": 2, "type": "fact" }
            }
        ])]);
        let client = client(&transport);

        let history = client.get_memory_history("mem0-1").await.expect("history");

        assert_eq!(history.len(), 1);
        assert_eq!(history[0].action, "update");
        assert_eq!(
            history[0].timestamp.as_deref(),
            Some("2026-02-15T10:00:00.000Z")
        );
        assert_eq!(
            history[0].content.as_deref(),
            Some("updated memory content")
        );
        assert_eq!(history[0].metadata.get("version"), Some(&json!(2)));
        let request = transport.only_request();
        assert_eq!(request.url, "http://mem0.local/v1/memories/mem0-1/history");
        assert_eq!(request.method, Method::GET);
    }

    fn search_input() -> Mem0SearchInput {
        Mem0SearchInput {
            user_id: "user-1".to_string(),
            persona_id: "persona-1".to_string(),
            workspace_id: None,
            query: "Alpha?".to_string(),
            limit: 3,
            filters: None,
        }
    }

    /// `searchMemories(input)` — `recall.ts:39-72`; the fixture is
    /// `mem0-client.operations.cases.ts:156-220`, extended with caller filters to
    /// pin the spread order of `recall.ts:40-44`.
    #[tokio::test]
    async fn search_prefers_v2_and_the_caller_filters_win() {
        let transport = StubTransport::json(vec![json!({
            "memories": [
                { "id": "a", "memory": "Alpha", "score": 0.9, "metadata": { "type": "fact" } }
            ]
        })]);
        let client = client(&transport);
        let input = Mem0SearchInput {
            filters: Some(Map::from_iter([
                ("agent_id".to_string(), json!("persona-override")),
                ("type".to_string(), json!("fact")),
            ])),
            ..search_input()
        };

        let hits = client.search_memories(&input).await.expect("search");

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "a");
        assert_eq!(hits[0].content, "Alpha");
        assert_eq!(hits[0].score, Some(0.9));
        let request = transport.only_request();
        assert_eq!(request.url, "http://mem0.local/v2/memories/search");
        assert_eq!(request.method, Method::POST);
        assert_eq!(
            request.body.as_deref(),
            Some(concat!(
                r#"{"query":"Alpha?","filters":{"user_id":"user-1","agent_id":"persona-override","type":"fact"},"#,
                r#""top_k":3,"limit":3}"#
            )),
            "the caller filters override the derived ids and keep their position"
        );
    }

    /// `it('falls back to v1 search endpoint when v2 search is unavailable')` —
    /// `mem0-client.fallbacks-timeout.cases.ts:7-56`.
    #[tokio::test]
    async fn search_falls_back_to_v1_on_a_404() {
        let transport = StubTransport::new(vec![
            Reply::Json(StatusCode::NOT_FOUND, json!({ "error": "not found" })),
            Reply::Json(
                StatusCode::OK,
                json!([{ "id": "legacy-1", "memory": "Legacy Search Hit", "score": 0.91 }]),
            ),
        ]);
        let client = client(&transport);

        let hits = client
            .search_memories(&search_input())
            .await
            .expect("search");

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "legacy-1");
        assert_eq!(hits[0].content, "Legacy Search Hit");
        let requests = transport.requests();
        assert_eq!(requests[0].url, "http://mem0.local/v2/memories/search");
        assert_eq!(requests[1].url, "http://mem0.local/v1/search");
        assert_eq!(requests[1].method, Method::POST);
        assert_eq!(
            body_json(&requests[1]),
            json!({
                "query": "Alpha?",
                "user_id": "user-1",
                "agent_id": "persona-1",
                "top_k": 3,
                "limit": 3,
            })
        );
    }

    /// A 400 is *not* a "v2 unavailable" error, so it propagates instead of
    /// probing v1 (`recall.ts:57-59`).
    #[tokio::test]
    async fn search_does_not_fall_back_on_a_client_error() {
        let transport = StubTransport::new(vec![Reply::Json(
            StatusCode::BAD_REQUEST,
            json!({ "detail": "bad request" }),
        )]);
        let client = client(&transport);

        let error = client
            .search_memories(&search_input())
            .await
            .expect_err("the 400 must propagate");

        assert_eq!(
            error.to_string(),
            "Mem0 request failed with HTTP 400: bad request."
        );
        assert_eq!(transport.call_count(), 1);
    }

    /// `it('lists memories with filters and pagination for WebUI CRUD')` —
    /// `mem0-client.operations.cases.ts:95-154`.
    #[tokio::test]
    async fn list_posts_filters_and_pagination() {
        let transport = StubTransport::json(vec![json!({
            "memories": [
                { "id": "mem0-1", "memory": "Alpha", "score": 0.9, "metadata": { "type": "fact" } }
            ],
            "total": 17,
            "page": 2,
            "page_size": 10,
        })]);
        let client = client(&transport);

        let result = client
            .list_memories(&Mem0ListInput {
                user_id: "user-1".to_string(),
                persona_id: Some("persona-1".to_string()),
                workspace_id: None,
                page: 2,
                page_size: 10,
                query: Some("alp".to_string()),
                node_type: Some("fact".to_string()),
            })
            .await
            .expect("list");

        let request = transport.only_request();
        assert_eq!(request.url, "http://mem0.local/v2/memories");
        assert_eq!(request.method, Method::POST);
        assert_eq!(
            request.body.as_deref(),
            Some(concat!(
                r#"{"filters":{"user_id":"user-1","agent_id":"persona-1","type":"fact"},"#,
                r#""page":2,"page_size":10,"query":"alp"}"#
            ))
        );
        assert_eq!(result.total, 17);
        assert_eq!(result.page, 2);
        assert_eq!(result.page_size, 10);
        assert_eq!(result.memories.len(), 1);
        assert_eq!(result.memories[0].id, "mem0-1");
        assert_eq!(result.memories[0].content, "Alpha");
    }

    /// `it('falls back to v1 list endpoint when v2 list is unavailable')` —
    /// `mem0-client.fallbacks-timeout.cases.ts:58-106`. The api path `/`
    /// normalises to the empty string, so the v1 URL has no `/v1` prefix.
    #[tokio::test]
    async fn list_falls_back_to_v1_on_a_404() {
        let transport = StubTransport::new(vec![
            Reply::Json(StatusCode::NOT_FOUND, json!({ "error": "not found" })),
            Reply::Json(
                StatusCode::OK,
                json!([
                    { "id": "legacy-1", "memory": "Alpha", "metadata": { "type": "fact" } },
                    { "id": "legacy-2", "memory": "Beta", "metadata": { "type": "preference" } }
                ]),
            ),
        ]);
        let client = client_with(
            &transport,
            Mem0ClientConfig {
                base_url: "http://mem0.local".to_string(),
                api_path: Some("/".to_string()),
                ..Mem0ClientConfig::default()
            },
        );

        let result = client
            .list_memories(&Mem0ListInput {
                user_id: "user-1".to_string(),
                persona_id: Some("persona-1".to_string()),
                workspace_id: None,
                page: 1,
                page_size: 1,
                query: Some("Alpha".to_string()),
                node_type: Some("fact".to_string()),
            })
            .await
            .expect("list");

        assert_eq!(result.total, 1);
        assert_eq!(result.memories.len(), 1);
        assert_eq!(result.memories[0].id, "legacy-1");
        assert_eq!(result.memories[0].content, "Alpha");
        let requests = transport.requests();
        assert_eq!(requests[0].url, "http://mem0.local/v2/memories");
        assert_eq!(
            requests[1].url,
            "http://mem0.local/memories?user_id=user-1&agent_id=persona-1"
        );
        assert_eq!(requests[1].method, Method::GET);
    }

    /// `it('falls back to v1 list endpoint when v2 returns an empty first page')` —
    /// `mem0-client.fallbacks-timeout.cases.ts:108-162`.
    #[tokio::test]
    async fn list_probes_v1_when_the_first_v2_page_is_empty() {
        let transport = StubTransport::new(vec![
            Reply::Json(
                StatusCode::OK,
                json!({ "memories": [], "total": 0, "page": 1, "page_size": 25 }),
            ),
            Reply::Json(
                StatusCode::OK,
                json!([
                    { "id": "legacy-1", "memory": "Alpha", "metadata": { "type": "fact" } },
                    { "id": "legacy-2", "memory": "Beta", "metadata": { "type": "preference" } }
                ]),
            ),
        ]);
        let client = client(&transport);

        let result = client
            .list_memories(&Mem0ListInput {
                user_id: "user-1".to_string(),
                persona_id: Some("persona-1".to_string()),
                workspace_id: None,
                page: 1,
                page_size: 25,
                query: None,
                node_type: Some("fact".to_string()),
            })
            .await
            .expect("list");

        assert_eq!(transport.call_count(), 2);
        assert_eq!(
            transport.requests()[1].url,
            "http://mem0.local/v1/memories?user_id=user-1&agent_id=persona-1"
        );
        assert_eq!(result.total, 1);
        assert_eq!(result.memories.len(), 1);
        assert_eq!(result.memories[0].id, "legacy-1");
    }

    /// A later page is not probed by v1: `shouldTryV1Fallback` requires page 1
    /// (`recall.ts:22-24`).
    #[tokio::test]
    async fn list_does_not_probe_v1_on_a_later_page() {
        let transport = StubTransport::json(vec![json!({ "memories": [], "total": 0 })]);
        let client = client(&transport);
        let input = Mem0ListInput {
            user_id: "user-1".to_string(),
            persona_id: None,
            workspace_id: None,
            page: 2,
            page_size: 5,
            query: None,
            node_type: None,
        };

        let result = client.list_memories(&input).await.expect("list");

        assert_eq!(transport.call_count(), 1);
        assert_eq!(result.total, 0);
        assert!(result.memories.is_empty());
        assert!(!should_try_v1_fallback(&input, &[], 0));
        assert!(should_try_v1_fallback(
            &Mem0ListInput { page: 1, ..input },
            &[],
            0
        ));
    }

    /// The v1 shape is filtered and sliced in memory (`recall.ts:101-123`), and a
    /// missing `agent_id` is simply not appended to the query.
    #[tokio::test]
    async fn list_via_v1_filters_by_type_and_query_and_slices_the_page() {
        let transport = StubTransport::json(vec![json!([
            { "id": "a", "memory": "Alpha", "metadata": { "type": "fact" } },
            { "id": "b", "memory": "beta", "metadata": { "type": "preference" } },
            { "id": "c", "memory": "ALPHA again", "metadata": { "type": "fact" } }
        ])]);
        let client = client(&transport);

        let result = client
            .list_via_v1(&Mem0ListInput {
                user_id: "user-1".to_string(),
                persona_id: None,
                workspace_id: None,
                page: 2,
                page_size: 1,
                query: Some(" alp ".to_string()),
                node_type: Some("fact".to_string()),
            })
            .await
            .expect("v1 list");

        assert_eq!(
            transport.only_request().url,
            "http://mem0.local/v1/memories?user_id=user-1"
        );
        assert_eq!(result.total, 2, "the filters run before paging");
        assert_eq!(result.page, 2);
        assert_eq!(result.page_size, 1);
        assert_eq!(result.memories.len(), 1);
        assert_eq!(result.memories[0].id, "c");
    }

    /// `it('deletes all persona memories via filter endpoint')` —
    /// `mem0-client.fallbacks-timeout.cases.ts:164-195`.
    #[tokio::test]
    async fn delete_by_filter_posts_the_body_form() {
        let transport = StubTransport::json(vec![json!({ "deleted": 3 })]);
        let client = client(&transport);

        let deleted = client
            .delete_memories_by_filter(&Mem0DeleteByFilterInput {
                user_id: "user-1".to_string(),
                persona_id: "persona-1".to_string(),
                workspace_id: None,
            })
            .await
            .expect("delete");

        assert_eq!(deleted, 3);
        let request = transport.only_request();
        assert_eq!(request.url, "http://mem0.local/v1/memories");
        assert_eq!(request.method, Method::DELETE);
        assert_eq!(
            request.body.as_deref(),
            Some(r#"{"user_id":"user-1","agent_id":"persona-1"}"#)
        );
    }

    /// `...(input.workspaceId ? { workspace_id } : {})` (`delete.ts:56`) — an
    /// empty string is falsy and must not reach the body.
    #[tokio::test]
    async fn delete_by_filter_adds_the_workspace_only_when_present() {
        let transport = StubTransport::json(vec![json!({ "deleted": 1 }), json!({ "count": 2 })]);
        let client = client(&transport);

        let with_workspace = client
            .delete_memories_by_filter(&Mem0DeleteByFilterInput {
                user_id: "user-1".to_string(),
                persona_id: "persona-1".to_string(),
                workspace_id: Some("ws-1".to_string()),
            })
            .await
            .expect("delete");
        let empty_workspace = client
            .delete_memories_by_filter(&Mem0DeleteByFilterInput {
                user_id: "user-1".to_string(),
                persona_id: "persona-1".to_string(),
                workspace_id: Some(String::new()),
            })
            .await
            .expect("delete");

        assert_eq!(with_workspace, 1);
        assert_eq!(empty_workspace, 2, "`count` is the second candidate");
        let requests = transport.requests();
        assert_eq!(
            requests[0].body.as_deref(),
            Some(r#"{"user_id":"user-1","agent_id":"persona-1","workspace_id":"ws-1"}"#)
        );
        assert_eq!(
            requests[1].body.as_deref(),
            Some(r#"{"user_id":"user-1","agent_id":"persona-1"}"#)
        );
    }

    /// `it('falls back to query-based delete for legacy mem0 delete API')` —
    /// `mem0-client.fallbacks-timeout.cases.ts:239-275`.
    #[tokio::test]
    async fn delete_by_filter_falls_back_to_the_query_form() {
        let transport = StubTransport::new(vec![
            Reply::Json(StatusCode::NOT_FOUND, json!({ "error": "not found" })),
            Reply::Json(
                StatusCode::OK,
                json!({ "message": "All relevant memories deleted" }),
            ),
        ]);
        let client = client_with(
            &transport,
            Mem0ClientConfig {
                base_url: "http://mem0.local".to_string(),
                api_path: Some("/".to_string()),
                ..Mem0ClientConfig::default()
            },
        );

        let deleted = client
            .delete_memories_by_filter(&Mem0DeleteByFilterInput {
                user_id: "user-1".to_string(),
                persona_id: "persona-1".to_string(),
                workspace_id: None,
            })
            .await
            .expect("delete");

        assert_eq!(deleted, 0, "the message carries no count");
        let requests = transport.requests();
        assert_eq!(requests[0].url, "http://mem0.local/memories");
        assert_eq!(
            requests[1].url,
            "http://mem0.local/memories?user_id=user-1&agent_id=persona-1"
        );
        assert_eq!(requests[1].method, Method::DELETE);
        assert!(requests[1].body.is_none());
    }

    /// A 500 is not a legacy-filter error, so the fallback is not attempted.
    #[tokio::test]
    async fn delete_by_filter_propagates_a_non_legacy_error() {
        let transport = StubTransport::new(vec![Reply::Json(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "detail": "boom" }),
        )]);
        let client = client(&transport);

        let error = client
            .delete_memories_by_filter(&Mem0DeleteByFilterInput {
                user_id: "user-1".to_string(),
                persona_id: "persona-1".to_string(),
                workspace_id: None,
            })
            .await
            .expect_err("the 500 must propagate");

        assert_eq!(
            error.to_string(),
            "Mem0 request failed with HTTP 500: boom."
        );
        assert_eq!(transport.call_count(), 1);
        assert!(is_legacy_delete_filter_error(&MemoryError::message(
            "Mem0 request failed with HTTP 400."
        )));
    }

    /// `Mem0 request failed with HTTP <status>: <detail>.` and the unparsable body
    /// of `client.ts:222` (`response.json().catch(() => ({}))`) which leaves the
    /// status line alone.
    #[tokio::test]
    async fn an_error_detail_is_appended_and_a_bare_body_is_not() {
        let transport = StubTransport::new(vec![
            Reply::Json(StatusCode::NOT_FOUND, json!({ "detail": "no such memory" })),
            Reply::Text(StatusCode::BAD_GATEWAY, "<html>nope</html>".to_string()),
        ]);
        let client = client(&transport);

        let with_detail = client
            .delete_memory("mem0-1")
            .await
            .expect_err("404")
            .to_string();
        let bare = client
            .delete_memory("mem0-2")
            .await
            .expect_err("502")
            .to_string();

        assert_eq!(
            with_detail,
            "Mem0 request failed with HTTP 404: no such memory."
        );
        assert_eq!(bare, "Mem0 request failed with HTTP 502.");
    }

    /// A `200` with a non-JSON body is coerced to `{}`, and a literal `null` body
    /// stays `null`; either way an add reports no id (`extractId`).
    #[tokio::test]
    async fn an_empty_or_null_success_body_reports_no_id() {
        let unparsable = StubTransport::new(vec![Reply::Text(StatusCode::OK, "OK".to_string())]);
        let client = client(&unparsable);
        assert_eq!(
            client.add_memory(&memory_input()).await.expect("add").id,
            None
        );

        let literal_null =
            StubTransport::new(vec![Reply::Text(StatusCode::OK, "null".to_string())]);
        let client = client_with(&literal_null, config());
        assert_eq!(
            client.add_memory(&memory_input()).await.expect("add").id,
            None,
            "`response.json()` resolves `null`, and `extractId(null)` is null"
        );
    }

    /// `it('retries transient HTTP 500 and succeeds on second attempt')`,
    /// `it('retries HTTP 502 and 503 as transient errors')` and
    /// `it('gives up after max retries and throws the last error')`.
    #[tokio::test]
    async fn transient_statuses_are_retried_and_then_given_up() {
        let transport = StubTransport::new(vec![
            Reply::Json(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "detail": "connection pool exhausted" }),
            ),
            Reply::Json(StatusCode::OK, json!([{ "id": "mem-1", "memory": "ok" }])),
        ]);
        let client = client_with(
            &transport,
            Mem0ClientConfig {
                retry_base_delay_ms: Some(0.0),
                max_retries: Some(3.0),
                ..config()
            },
        );

        let result = client.add_memory(&memory_input()).await.expect("add");

        assert_eq!(result.id.as_deref(), Some("mem-1"));
        assert_eq!(transport.call_count(), 2);

        let exhausted = StubTransport::new(vec![
            Reply::Json(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "detail": "pool exhausted" }),
            ),
            Reply::Json(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "detail": "pool exhausted" }),
            ),
            Reply::Json(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "detail": "pool exhausted" }),
            ),
            Reply::Json(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "detail": "pool exhausted" }),
            ),
        ]);
        let client = client_with(
            &exhausted,
            Mem0ClientConfig {
                retry_base_delay_ms: Some(0.0),
                max_retries: Some(3.0),
                ..config()
            },
        );

        let error = client
            .add_memory(&memory_input())
            .await
            .expect_err("the last 500 is thrown");

        assert_eq!(
            error.to_string(),
            "Mem0 request failed with HTTP 500: pool exhausted."
        );
        assert_eq!(exhausted.call_count(), 4, "1 initial + 3 retries");
    }

    /// `it('does not retry client errors like HTTP 400 or 404')` and
    /// `it('defaults to zero retries when maxRetries is not configured')`.
    #[tokio::test]
    async fn client_errors_and_the_default_config_are_not_retried() {
        let transport = StubTransport::new(vec![Reply::Json(
            StatusCode::BAD_REQUEST,
            json!({ "detail": "bad request" }),
        )]);
        let client = client_with(
            &transport,
            Mem0ClientConfig {
                max_retries: Some(3.0),
                ..config()
            },
        );

        let error = client.add_memory(&memory_input()).await.expect_err("400");

        assert!(error.to_string().contains("HTTP 400"), "{error}");
        assert_eq!(transport.call_count(), 1);

        let default_transport = StubTransport::new(vec![Reply::Json(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "detail": "pool exhausted" }),
        )]);
        let client = client_with(
            &default_transport,
            Mem0ClientConfig {
                base_url: "http://mem0.local".to_string(),
                api_path: Some("/v1".to_string()),
                ..Mem0ClientConfig::default()
            },
        );

        let error = client.add_memory(&memory_input()).await.expect_err("500");

        assert!(error.to_string().contains("HTTP 500"), "{error}");
        assert_eq!(default_transport.call_count(), 1);
        assert_eq!(client.max_retries(), 0);
        assert_eq!(client.write_max_retries(), 0);
    }

    /// `it('retries one timed-out write request and succeeds on the next attempt')`
    /// and `it('does not retry timed-out read requests')` —
    /// `mem0-client-retry.test.ts:127-197`.
    #[tokio::test]
    async fn write_timeouts_are_retried_and_read_timeouts_are_not() {
        let transport = StubTransport::new(vec![
            Reply::Failure(HttpError::Timeout),
            Reply::Json(
                StatusCode::OK,
                json!([{ "id": "mem-timeout-1", "memory": "ok" }]),
            ),
        ]);
        let client = client_with(
            &transport,
            Mem0ClientConfig {
                timeout_ms: Some(5_000.0),
                write_timeout_ms: Some(50.0),
                write_max_retries: Some(1.0),
                retry_base_delay_ms: Some(0.0),
                ..config()
            },
        );

        let result = client.add_memory(&memory_input()).await.expect("add");

        assert_eq!(result.id.as_deref(), Some("mem-timeout-1"));
        assert_eq!(transport.call_count(), 2);
        assert_eq!(
            transport.requests()[0].timeout_ms,
            100,
            "`Math.max(100, Math.floor(50))` raises the configured write deadline"
        );

        let read_transport = StubTransport::new(vec![Reply::Failure(HttpError::Timeout)]);
        let client = client_with(
            &read_transport,
            Mem0ClientConfig {
                timeout_ms: Some(4_000.0),
                max_retries: Some(3.0),
                write_timeout_ms: Some(5_000.0),
                write_max_retries: Some(1.0),
                retry_base_delay_ms: Some(0.0),
                ..config()
            },
        );

        let error = client
            .list_memories(&Mem0ListInput {
                user_id: "user-1".to_string(),
                persona_id: Some("persona-1".to_string()),
                workspace_id: None,
                page: 1,
                page_size: 5,
                query: None,
                node_type: None,
            })
            .await
            .expect_err("a read timeout");

        assert_eq!(error.to_string(), "Mem0 request timeout after 4000ms.");
        assert!(is_timeout_error(&error));
        assert_eq!(read_transport.call_count(), 1, "reads are not retried");
    }

    /// `it('fails immediately when the caller signal is already aborted')` —
    /// `mem0-client.fallbacks-timeout.cases.ts:345-361`.
    #[tokio::test]
    async fn an_already_aborted_signal_never_reaches_the_transport() {
        let transport = StubTransport::json(vec![json!({ "id": "never" })]);
        let client = client(&transport);
        let signal = AbortSignal::new();
        signal.abort();

        let error = client
            .add_memory_with_signal(&memory_input(), Some(signal))
            .await
            .expect_err("aborted");

        assert_eq!(error.to_string(), MEM0_ABORT_MESSAGE);
        assert_eq!(transport.call_count(), 0);
    }

    /// A transport that reports the deadline *and* aborts the caller's signal,
    /// which is the race `fetchWithTimeout` resolves towards `Aborted`
    /// (`model_hub/http.rs:356`).
    struct AbortingTransport {
        signal: AbortSignal,
    }

    impl HttpTransport for AbortingTransport {
        fn send<'a>(
            &'a self,
            _request: HttpRequest,
        ) -> BoxFuture<'a, Result<HttpResponse, HttpError>> {
            self.signal.abort();
            Box::pin(async { Err(HttpError::Timeout) })
        }
    }

    /// `it('preserves caller cancellation as AbortError instead of reporting a
    /// timeout')` — `mem0-client.fallbacks-timeout.cases.ts:315-343`. The
    /// `AbortError` name itself is not representable, the message is
    /// (module header, deviation 2).
    #[tokio::test]
    async fn a_cancellation_in_flight_wins_over_the_deadline() {
        let signal = AbortSignal::new();
        let transport: Arc<dyn HttpTransport> = Arc::new(AbortingTransport {
            signal: signal.clone(),
        });
        let client = Mem0HttpClient::new(config(), transport).expect("client");

        let error = client
            .add_memory_with_signal(&memory_input(), Some(signal))
            .await
            .expect_err("aborted");

        assert_eq!(error.to_string(), MEM0_ABORT_MESSAGE);
        assert!(!is_timeout_error(&error));
    }

    /// An `AbortError` without an aborted caller signal is the deadline
    /// (`client.ts:230-238`), and a socket failure keeps the text the classifier
    /// looks for.
    #[tokio::test]
    async fn transport_failures_are_mapped_by_message() {
        let deadline = StubTransport::new(vec![Reply::Failure(HttpError::Aborted)]);
        let client = client(&deadline);

        let error = client.delete_memory("mem0-1").await.expect_err("aborted");

        assert_eq!(error.to_string(), "Mem0 request timeout after 4000ms.");

        let refused = StubTransport::new(vec![Reply::Failure(HttpError::Transport(
            "connect ECONNREFUSED 127.0.0.1:8010".to_string(),
        ))]);
        let client = client_with(&refused, config());

        let error = client.delete_memory("mem0-1").await.expect_err("refused");

        assert_eq!(error.to_string(), "connect ECONNREFUSED 127.0.0.1:8010");
        assert!(is_network_error(&error));
        assert!(is_transient_http_error(&error));
        assert_eq!(refused.call_count(), 1, "no retries configured");
    }

    use std::sync::atomic::{AtomicUsize, Ordering};

    /// The `mem0EmbedderSync` double of `mem0-client.harness.ts:4-16`: counts the
    /// attempts and answers a fixed boolean.
    struct CountingSync {
        calls: AtomicUsize,
        ok: bool,
    }

    impl CountingSync {
        fn new(ok: bool) -> Arc<Self> {
            Arc::new(Self {
                calls: AtomicUsize::new(0),
                ok,
            })
        }

        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    impl Mem0ModelHubSync for CountingSync {
        fn sync<'a>(&'a self) -> BoxFuture<'a, bool> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let ok = self.ok;
            Box::pin(async move { ok })
        }
    }

    fn auto_sync_client(
        transport: &Arc<StubTransport>,
        sync: &Arc<CountingSync>,
    ) -> Mem0HttpClient {
        let transport: Arc<dyn HttpTransport> = transport.clone();
        let sync: Arc<dyn Mem0ModelHubSync> = sync.clone();
        Mem0HttpClient::with_model_hub_sync(
            Mem0ClientConfig {
                base_url: "http://mem0.local".to_string(),
                api_path: Some("/v1".to_string()),
                max_retries: Some(0.0),
                ..Mem0ClientConfig::default()
            },
            transport,
            Arc::new(Mem0ModelHubSyncState::new(sync)),
        )
        .expect("client")
    }

    /// `it('auto-syncs mem0 config from model hub when runtime is unconfigured
    /// (503)')` — `mem0-client.autosync.cases.ts:9-56`.
    ///
    /// The 503 runs both hub syncs, extends the attempt budget by one, and the
    /// empty first page of the retried request then probes v1: three requests.
    #[tokio::test]
    async fn an_unconfigured_runtime_syncs_and_retries() {
        let transport = StubTransport::new(vec![
            Reply::Json(
                StatusCode::SERVICE_UNAVAILABLE,
                json!({ "detail": "Mem0 runtime is not configured." }),
            ),
            Reply::Json(
                StatusCode::OK,
                json!({ "memories": [], "total": 0, "page": 1, "page_size": 1 }),
            ),
            Reply::Json(StatusCode::OK, json!([])),
        ]);
        let sync = CountingSync::new(true);
        let client = auto_sync_client(&transport, &sync);

        let result = client
            .list_memories(&Mem0ListInput {
                user_id: "user-1".to_string(),
                persona_id: Some("persona-1".to_string()),
                workspace_id: None,
                page: 1,
                page_size: 10,
                query: None,
                node_type: None,
            })
            .await
            .expect("list");

        assert_eq!(result.total, 0);
        assert_eq!(transport.call_count(), 3);
        assert_eq!(
            transport.requests()[2].url,
            "http://mem0.local/v1/memories?user_id=user-1&agent_id=persona-1"
        );
        assert_eq!(sync.calls(), 1, "one sync per triggered attempt");
        assert!(!client.model_hub_sync_state().is_syncing());
    }

    /// `it('auto-syncs mem0 config when embed model is invalid/not found')` —
    /// `mem0-client.autosync.cases.ts:58-111`.
    ///
    /// The Gemini `404 NOT_FOUND … embedContent` detail behind an HTTP 500 is what
    /// [`is_mem0_invalid_model_config_error`] recognises.
    #[tokio::test]
    async fn an_invalid_model_configuration_syncs_and_retries() {
        let detail = "404 NOT_FOUND. {'error': {'code': 404, 'message': 'models/text-embedding-004 is not found for API version v1beta, or is not supported for embedContent.', 'status': 'NOT_FOUND'}}";
        let transport = StubTransport::new(vec![
            Reply::Json(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "detail": detail }),
            ),
            Reply::Json(
                StatusCode::OK,
                json!({ "memories": [], "total": 0, "page": 1, "page_size": 1 }),
            ),
            Reply::Json(StatusCode::OK, json!([])),
        ]);
        let sync = CountingSync::new(true);
        let client = auto_sync_client(&transport, &sync);

        let result = client
            .list_memories(&Mem0ListInput {
                user_id: "user-1".to_string(),
                persona_id: Some("persona-1".to_string()),
                workspace_id: None,
                page: 1,
                page_size: 10,
                query: None,
                node_type: None,
            })
            .await
            .expect("list");

        assert_eq!(result.total, 0);
        assert_eq!(transport.call_count(), 3);
        assert_eq!(sync.calls(), 1);
        let error = MemoryError::message(format!("Mem0 request failed with HTTP 500: {detail}."));
        assert!(is_mem0_invalid_model_config_error(&error));
        assert!(is_mem0_runtime_unconfigured_error(&MemoryError::message(
            "Mem0 request failed with HTTP 503: Mem0 runtime is not configured."
        )));
    }

    /// A failed sync leaves the budget alone: the 503 is thrown after one request
    /// (`sync.ts:29-31` + `client.ts:162-170`).
    #[tokio::test]
    async fn a_failed_sync_does_not_extend_the_attempts() {
        let transport = StubTransport::new(vec![Reply::Json(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({ "detail": "Mem0 runtime is not configured." }),
        )]);
        let sync = CountingSync::new(false);
        let client = auto_sync_client(&transport, &sync);

        let error = client
            .add_memory(&memory_input())
            .await
            .expect_err("the 503 is thrown");

        assert_eq!(
            error.to_string(),
            "Mem0 request failed with HTTP 503: Mem0 runtime is not configured..",
            "the detail's own full stop is kept, `client.ts:226` appends another"
        );
        assert_eq!(transport.call_count(), 1);
        assert_eq!(sync.calls(), 1);
    }

    /// `sync.ts:13-37`: the cooldown window short-circuits before the sync, the
    /// attempt stamp is written before the await, and the `finally` clears the
    /// in-flight slot.
    #[tokio::test]
    async fn the_sync_state_holds_the_cooldown() {
        let sync = CountingSync::new(true);
        let state = Mem0ModelHubSyncState::new(sync.clone());

        assert!(state.trigger().await);
        assert_eq!(sync.calls(), 1);
        assert!(state.last_attempt_ms() > 0);
        assert!(!state.is_syncing(), "the attempt cleared itself");

        assert!(!state.trigger().await, "inside the cooldown window");
        assert_eq!(sync.calls(), 1, "the cooldown never reaches the sync");

        state.set_last_attempt_ms(now_millis() - MEM0_MODEL_HUB_SYNC_COOLDOWN_MS - 1);
        assert!(state.trigger().await, "the window has passed");
        assert_eq!(sync.calls(), 2);

        state.reset_for_tests();
        assert_eq!(state.last_attempt_ms(), 0);
    }

    /// A sync that takes a moment, so two concurrent triggers overlap.
    struct SlowSync {
        calls: AtomicUsize,
    }

    impl Mem0ModelHubSync for SlowSync {
        fn sync<'a>(&'a self) -> BoxFuture<'a, bool> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async {
                sleep_ms(5).await;
                true
            })
        }
    }

    /// Concurrent callers join the in-flight attempt instead of starting a second
    /// one (`sync.ts:14-17`), and the loser never polls its own initialiser.
    #[tokio::test]
    async fn concurrent_triggers_share_one_attempt() {
        let sync = Arc::new(SlowSync {
            calls: AtomicUsize::new(0),
        });
        let state = Mem0ModelHubSyncState::new(sync.clone());

        let (first, second) = tokio::join!(state.trigger(), state.trigger());

        assert!(first);
        assert!(second);
        assert_eq!(sync.calls.load(Ordering::SeqCst), 1, "one shared attempt");
        assert!(!state.is_syncing());
    }

    /// Without a model hub the default state reproduces the rejected dynamic
    /// import (`sync.ts:24-31`): the attempt fails, but the stamp was written
    /// before it and the cooldown therefore applies.
    #[tokio::test]
    async fn the_default_sync_state_reports_a_failed_sync() {
        let state = Mem0ModelHubSyncState::with_noop();

        assert!(!state.trigger().await);
        assert!(state.last_attempt_ms() > 0, "stamped before the attempt");
        assert!(!state.trigger().await, "and therefore inside the cooldown");
    }

    /// The synchronous contract of module header “The synchronous contract”; a
    /// multi-threaded runtime releases the worker for `block_in_place`.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_sync_contract_drives_the_async_operations() {
        let transport = StubTransport::json(vec![
            json!([{ "id": "mem0-sync-1", "memory": "Alpha" }]),
            json!({ "deleted": 1 }),
            json!({ "memories": [], "total": 0, "page": 1, "page_size": 5 }),
            json!([]),
        ]);
        let client = client(&transport);
        let provider: &dyn Mem0Client = &client;
        let scope = Mem0Scope::new("user-1", "persona-1");

        let added = provider.add_memory(&memory_input()).expect("add");
        assert_eq!(added.id.as_deref(), Some("mem0-sync-1"));
        provider
            .delete_memory("mem0-1", Some(&scope))
            .expect("delete");
        assert_eq!(
            transport.requests()[1].url,
            "http://mem0.local/v1/memories/mem0-1",
            "the optional Mem0Scope is accepted and ignored (`client.ts:103`)"
        );
        let listed = provider
            .list_memories(&Mem0ListInput {
                user_id: "user-1".to_string(),
                persona_id: None,
                workspace_id: None,
                page: 1,
                page_size: 5,
                query: None,
                node_type: None,
            })
            .expect("list");

        assert_eq!(listed.total, 0, "the empty first page probed v1");
        assert_eq!(transport.call_count(), 4);
        assert!(provider.provider().is_none(), "the HTTP client is mem0");
    }

    /// Without a runtime the bridge creates a temporary current-thread runtime.
    #[test]
    fn the_sync_contract_works_without_a_runtime() {
        let transport = StubTransport::json(vec![json!({ "id": "mem0-plain" })]);
        let client = client(&transport);
        let provider: &dyn Mem0Client = &client;

        let added = provider.add_memory(&memory_input()).expect("add");

        assert_eq!(added.id.as_deref(), Some("mem0-plain"));
        assert_eq!(transport.call_count(), 1);
    }

    /// Inside a current-thread runtime the bridge refuses instead of blocking the
    /// driver it was called on.
    #[tokio::test]
    async fn the_sync_contract_refuses_a_current_thread_runtime() {
        let transport = StubTransport::json(vec![json!({ "id": "mem0-never" })]);
        let client = client(&transport);
        let provider: &dyn Mem0Client = &client;

        let error = provider
            .add_memory(&memory_input())
            .expect_err("the bridge refuses");

        assert_eq!(error.to_string(), MEM0_SYNC_BRIDGE_MESSAGE);
        assert_eq!(transport.call_count(), 0);
    }

    /// `Mem0 baseUrl is required.` — `client.ts:260-263`.
    #[test]
    fn a_missing_base_url_is_rejected() {
        let transport = StubTransport::json(vec![json!({})]);

        let error = Mem0HttpClient::new(
            Mem0ClientConfig {
                base_url: "   ".to_string(),
                ..Mem0ClientConfig::default()
            },
            transport.clone(),
        )
        .expect_err("no base url");

        assert_eq!(error.to_string(), MEM0_BASE_URL_REQUIRED);
        assert_eq!(transport.call_count(), 0);
        assert_eq!(
            Mem0HttpClient::new(Mem0ClientConfig::default(), transport)
                .expect_err("no base url")
                .to_string(),
            MEM0_BASE_URL_REQUIRED
        );
    }

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    /// `it('creates a client from env only when provider is mem0 and base url
    /// exists')` — `mem0-client.env.cases.ts:7-36`.
    #[test]
    fn create_mem0_client_from_env_follows_the_provider_rules() {
        let transport: Arc<dyn HttpTransport> = StubTransport::json(vec![json!({})]);

        let disabled = create_mem0_client_from_env(
            &env(&[
                ("MEMORY_PROVIDER", "disabled"),
                ("MEM0_BASE_URL", "http://mem0.local"),
            ]),
            transport.clone(),
        )
        .expect("no error");
        assert!(disabled.is_none(), "a foreign provider disables mem0");

        let implicit = create_mem0_client_from_env(
            &env(&[("MEM0_BASE_URL", "http://mem0.local")]),
            transport.clone(),
        )
        .expect("no error");
        assert!(implicit.is_some(), "no provider means the legacy mem0 path");

        let enabled = create_mem0_client_from_env(
            &env(&[
                ("MEMORY_PROVIDER", "mem0"),
                ("MEM0_BASE_URL", "http://mem0.local"),
                ("MEM0_API_KEY", "mem0_secret"),
            ]),
            transport,
        )
        .expect("no error")
        .expect("some");
        assert_eq!(enabled.api_path(), "/v1");
        assert_eq!(enabled.base_url(), "http://mem0.local");
    }

    /// `it('throws for explicit mem0 provider without base url')`,
    /// `it('throws for explicit mem0 provider without api key')` and
    /// `it('throws in production when MEMORY_PROVIDER is not mem0')` —
    /// `mem0-client.env.cases.ts:38-77`.
    #[test]
    fn create_mem0_client_from_env_validates_the_explicit_provider() {
        let transport: Arc<dyn HttpTransport> = StubTransport::json(vec![json!({})]);

        let missing_base_url = create_mem0_client_from_env(
            &env(&[("MEMORY_PROVIDER", "mem0"), ("MEM0_BASE_URL", "")]),
            transport.clone(),
        )
        .expect_err("MEM0_BASE_URL");
        assert!(
            missing_base_url.to_string().contains("MEM0_BASE_URL"),
            "{missing_base_url}"
        );

        let missing_key = create_mem0_client_from_env(
            &env(&[
                ("MEMORY_PROVIDER", "mem0"),
                ("MEM0_BASE_URL", "http://mem0.local"),
                ("MEM0_API_KEY", ""),
            ]),
            transport.clone(),
        )
        .expect_err("MEM0_API_KEY");
        assert!(
            missing_key.to_string().contains("MEM0_API_KEY"),
            "{missing_key}"
        );

        let production = create_mem0_client_from_env(
            &env(&[
                ("NODE_ENV", "production"),
                ("MEMORY_PROVIDER", ""),
                ("MEM0_BASE_URL", "http://mem0.local"),
            ]),
            transport,
        )
        .expect_err("production");
        assert!(
            production.to_string().contains("MEMORY_PROVIDER=mem0"),
            "{production}"
        );
    }

    /// The `Number(...)`/`??`/`||` reads of `client.ts:299-322`, asserted through
    /// the resolved settings and through the request the client builds.
    #[tokio::test]
    async fn env_numbers_and_paths_are_resolved_like_the_typescript() {
        let transport = StubTransport::json(vec![json!({ "id": "env-1" })]);
        let client = create_mem0_client_from_env(
            &env(&[
                ("MEMORY_PROVIDER", "mem0"),
                ("MEM0_BASE_URL", "http://mem0.local/"),
                ("MEM0_API_KEY", " mem0_secret "),
                ("MEM0_API_PATH", " /v2/ "),
                ("MEM0_TIMEOUT_MS", "5000"),
                ("MEM0_READ_TIMEOUT_MS", ""),
                ("MEM0_WRITE_TIMEOUT_MS", "abc"),
                ("MEM0_MAX_RETRIES", "2"),
                ("MEM0_WRITE_MAX_RETRIES", "-1"),
                ("MEM0_RETRY_BASE_DELAY_MS", "0"),
            ]),
            transport.clone(),
        )
        .expect("no error")
        .expect("some");

        assert_eq!(
            client.api_path(),
            "/v2",
            "the path is trimmed and normalised"
        );
        assert_eq!(
            client.read_timeout_ms(),
            100,
            "`Number('')` is 0 and clamps up to 100"
        );
        assert_eq!(
            client.write_timeout_ms(),
            100,
            "`Number('abc')` is NaN, so the read timeout is inherited"
        );
        assert_eq!(client.max_retries(), 2);
        assert_eq!(client.write_max_retries(), 0, "`-1` clamps to 0");

        client.add_memory(&memory_input()).await.expect("add");

        let request = transport.only_request();
        assert_eq!(request.url, "http://mem0.local/v2/memories");
        assert_eq!(request.timeout_ms, 100, "the write deadline");
        assert_eq!(header(&request, "authorization"), "Bearer mem0_secret");
    }

    /// `Math.max(100, Math.floor(x))`, `Number.isFinite` and the read/write chain
    /// of `client.ts:72-89`.
    #[test]
    fn the_config_clamps_and_defaults_its_numbers() {
        let base = Mem0ClientConfig {
            base_url: "http://mem0.local".to_string(),
            ..Mem0ClientConfig::default()
        };
        let transport: Arc<dyn HttpTransport> = StubTransport::json(vec![json!({})]);

        let zero = Mem0HttpClient::new(
            Mem0ClientConfig {
                timeout_ms: Some(0.0),
                ..base.clone()
            },
            transport.clone(),
        )
        .expect("client");
        assert_eq!(zero.read_timeout_ms(), 100);

        let nan = Mem0HttpClient::new(
            Mem0ClientConfig {
                timeout_ms: Some(f64::NAN),
                ..base.clone()
            },
            transport.clone(),
        )
        .expect("client");
        assert_eq!(nan.read_timeout_ms(), DEFAULT_TIMEOUT_MS);

        let chained = Mem0HttpClient::new(
            Mem0ClientConfig {
                timeout_ms: Some(250.9),
                ..base.clone()
            },
            transport.clone(),
        )
        .expect("client");
        assert_eq!(chained.read_timeout_ms(), 250, "floored");
        assert_eq!(
            chained.write_timeout_ms(),
            250,
            "the write timeout inherits the read one"
        );

        let fractional = Mem0HttpClient::new(
            Mem0ClientConfig {
                max_retries: Some(2.7),
                write_max_retries: Some(-3.0),
                retry_base_delay_ms: Some(12.9),
                ..base.clone()
            },
            transport.clone(),
        )
        .expect("client");
        assert_eq!(fractional.max_retries(), 2);
        assert_eq!(fractional.write_max_retries(), 0);
        assert_eq!(fractional.retry_base_delay_ms(), 12);

        let trimmed = Mem0HttpClient::new(
            Mem0ClientConfig {
                api_key: Some("   ".to_string()),
                ..base
            },
            transport,
        )
        .expect("client");
        assert_eq!(trimmed.api_path(), "/v1", "an absent api path defaults");
    }

    /// `retryBaseDelayMs * Math.pow(2, attempt)` from `client.ts:177`.
    #[test]
    fn the_retry_delay_doubles_per_attempt() {
        assert_eq!(retry_delay_ms(500, 0), 500);
        assert_eq!(retry_delay_ms(500, 1), 1000);
        assert_eq!(retry_delay_ms(500, 3), 4000);
        assert_eq!(retry_delay_ms(0, 4), 0);
        assert_eq!(retry_delay_ms(u64::MAX, 2), u64::MAX, "saturating");
    }

    /// `describe('toMemoryRecord')` — `mem0-utils.test.ts:105-199`.
    #[test]
    fn to_memory_record_follows_the_field_precedence() {
        let flat = to_memory_record(&json!({
            "id": "mem-1",
            "memory": "Test content",
            "score": 0.95,
            "metadata": { "source": "test" },
            "created_at": "2026-01-01"
        }))
        .expect("record");
        assert_eq!(flat.id, "mem-1");
        assert_eq!(flat.content, "Test content");
        assert_eq!(flat.score, Some(0.95));
        assert_eq!(flat.metadata.get("source"), Some(&json!("test")));
        assert_eq!(flat.created_at.as_deref(), Some("2026-01-01"));
        assert_eq!(flat.updated_at, None);

        let nested = to_memory_record(&json!({
            "memory_id": "mem-2",
            "memory": { "id": "nested-id", "text": "Nested content" },
            "similarity": 0.85
        }))
        .expect("record");
        assert_eq!(nested.id, "mem-2");
        assert_eq!(nested.content, "Nested content");
        assert_eq!(nested.score, Some(0.85));

        let camel = to_memory_record(&json!({
            "id": "mem-6",
            "memory": "CamelCase",
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-02T00:00:00Z"
        }))
        .expect("record");
        assert_eq!(camel.created_at.as_deref(), Some("2026-01-01T00:00:00Z"));
        assert_eq!(camel.updated_at.as_deref(), Some("2026-01-02T00:00:00Z"));

        let minimal =
            to_memory_record(&json!({ "id": "mem-5", "memory": "Minimal" })).expect("record");
        assert_eq!(minimal.score, None);
        assert!(minimal.metadata.is_empty());
        assert_eq!(minimal.created_at, None);

        assert!(to_memory_record(&json!({ "content": "No ID" })).is_none());
        assert!(to_memory_record(&json!({ "id": "mem-4" })).is_none());
        assert!(to_memory_record(&Value::Null).is_none());
        assert!(to_memory_record(&json!("string")).is_none());
    }

    /// `describe('extractMemories')` — `mem0-utils.test.ts:77-103`.
    #[test]
    fn extract_memories_prefers_the_known_envelopes() {
        assert_eq!(
            extract_memories(&json!({ "memories": [{ "id": "1" }] })).len(),
            1
        );
        assert_eq!(
            extract_memories(&json!({ "results": [{ "id": "1" }] })).len(),
            1
        );
        assert_eq!(
            extract_memories(&json!({ "data": [{ "id": "1" }] })).len(),
            1
        );
        assert_eq!(extract_memories(&json!([{ "id": "1" }])).len(), 1);
        assert!(extract_memories(&json!({ "foo": "bar" })).is_empty());
        assert!(extract_memories(&Value::Null).is_empty());
        assert_eq!(
            extract_memories(&json!({
                "memories": [{ "id": "a" }],
                "results": [{ "id": "b" }],
                "data": [{ "id": "c" }]
            }))[0]["id"],
            json!("a"),
            "`memories` wins over `results` and `data`"
        );
    }

    /// `describe('extractHits')` — `mem0-utils.test.ts:201-233`.
    #[test]
    fn extract_hits_drops_entries_without_id_or_content() {
        let hits = extract_hits(&json!({
            "memories": [
                { "id": "1", "memory": "Valid" },
                { "id": "", "memory": "No ID" },
                { "id": "2" },
                null
            ]
        }));

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "1");
        assert_eq!(hits[0].content, "Valid");
        assert!(extract_hits(&json!({})).is_empty());
        assert!(extract_hits(&Value::Null).is_empty());
    }

    /// `describe('toHistoryEntry')` and `describe('extractHistory')` —
    /// `mem0-utils.test.ts:235-310`.
    #[test]
    fn history_entries_keep_the_raw_record_and_their_precedence() {
        let entry = to_history_entry(&json!({
            "id": "hist-1",
            "action": "create",
            "metadata": { "source": "test" },
            "new_memory": { "text": "New memory text" },
            "old_memory": { "text": "Old memory text" },
            "timestamp": "2026-01-01T00:00:00Z"
        }))
        .expect("entry");
        assert_eq!(entry.action, "create");
        assert_eq!(entry.timestamp.as_deref(), Some("2026-01-01T00:00:00Z"));
        assert_eq!(entry.content.as_deref(), Some("New memory text"));
        assert_eq!(entry.metadata.get("source"), Some(&json!("test")));
        assert_eq!(entry.raw.get("id"), Some(&json!("hist-1")));

        let alternative = to_history_entry(&json!({
            "event": "update",
            "time": "2026-01-02T00:00:00Z",
            "content": "Direct content"
        }))
        .expect("entry");
        assert_eq!(alternative.action, "update");
        assert_eq!(
            alternative.timestamp.as_deref(),
            Some("2026-01-02T00:00:00Z")
        );
        assert_eq!(alternative.content.as_deref(), Some("Direct content"));

        let unknown = to_history_entry(&json!({ "id": "hist-2" })).expect("entry");
        assert_eq!(unknown.action, "unknown");
        assert_eq!(unknown.content, None);
        assert!(to_history_entry(&json!({})).is_none());
        assert!(to_history_entry(&Value::Null).is_none());
        assert!(to_history_entry(&json!("string")).is_none());

        let history = extract_history(&json!({
            "history": [
                { "action": "create", "timestamp": "2026-01-01" },
                { "action": "update", "timestamp": "2026-01-02" }
            ]
        }));
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].action, "create");
        assert_eq!(
            extract_history(&json!({ "results": [{ "action": "delete" }] })).len(),
            1
        );
        assert_eq!(
            extract_history(&json!([{ "action": "create" }])).len(),
            1,
            "the payload array wins over the `history` key"
        );
        assert!(extract_history(&json!({})).is_empty());
    }

    /// `describe('extractId')` — `mem0-utils.test.ts:312-341`.
    #[test]
    fn extract_id_reads_every_envelope() {
        assert_eq!(
            extract_id(&json!({ "id": "mem-123" })).as_deref(),
            Some("mem-123")
        );
        assert_eq!(
            extract_id(&json!({ "memory_id": "mem-456" })).as_deref(),
            Some("mem-456")
        );
        assert_eq!(
            extract_id(&json!({ "memory": { "id": "mem-789" } })).as_deref(),
            Some("mem-789")
        );
        assert_eq!(
            extract_id(&json!({ "data": { "id": "mem-999" } })).as_deref(),
            Some("mem-999")
        );
        assert_eq!(
            extract_id(&json!([
                { "id": "first", "memory": "test" },
                { "id": "second", "memory": "test2" }
            ]))
            .as_deref(),
            Some("first")
        );
        assert_eq!(
            extract_id(&json!({ "results": [{ "id": "result-id", "memory": "test" }] })).as_deref(),
            Some("result-id")
        );
        assert_eq!(extract_id(&json!({ "foo": "bar" })), None);
        assert_eq!(extract_id(&json!([])), None);
        assert_eq!(
            extract_id(&json!([{ "id": "no-content" }])),
            None,
            "an array entry is read through toMemoryRecord"
        );
    }

    /// `describe('extractListMeta')` — `mem0-utils.test.ts:343-410`.
    #[test]
    fn extract_list_meta_follows_the_field_chain() {
        let flat = extract_list_meta(&json!({ "total": 100, "page": 2, "page_size": 10 }), 1, 10);
        assert_eq!(flat.total, 100);
        assert_eq!(flat.page, 2);
        assert_eq!(flat.page_size, 10);

        let nested = extract_list_meta(
            &json!({ "pagination": { "total": 50, "current_page": 3, "per_page": 20 } }),
            1,
            10,
        );
        assert_eq!(nested.total, 50);
        assert_eq!(
            nested.page, 1,
            "`pagination.current_page` is not read by the source"
        );
        assert_eq!(nested.page_size, 10);

        let alternative = extract_list_meta(
            &json!({ "total_count": 75, "current_page": 4, "page_size": 15 }),
            1,
            10,
        );
        assert_eq!(alternative.total, 75);
        assert_eq!(alternative.page, 4);
        assert_eq!(alternative.page_size, 15);

        let fallback = extract_list_meta(&json!({ "foo": "bar" }), 5, 25);
        assert_eq!(fallback.total, 0);
        assert_eq!(fallback.page, 5);
        assert_eq!(fallback.page_size, 25);

        let count = extract_list_meta(
            &json!({ "count": 75, "page_number": 4, "limit": 15 }),
            1,
            10,
        );
        assert_eq!(count.total, 75);
        assert_eq!(count.page, 1);
        assert_eq!(count.page_size, 10);

        let guarded = extract_list_meta(
            &json!({ "total": -5, "page": 0, "page_size": 0, "pageSize": 3 }),
            7,
            9,
        );
        assert_eq!(guarded.total, 0, "a negative total falls back to 0");
        assert_eq!(guarded.page, 7, "a 0 page falls back to the caller's");
        assert_eq!(guarded.page_size, 3, "`pageSize` is the camelCase fallback");
    }

    /// `extractDeletedCount` from `mem0/utils/index.ts:218-236`.
    #[test]
    fn extract_deleted_count_reads_the_candidates_in_order() {
        assert_eq!(extract_deleted_count(&json!({ "deleted": 3 })), 3);
        assert_eq!(extract_deleted_count(&json!({ "count": 2 })), 2);
        assert_eq!(extract_deleted_count(&json!({ "total_deleted": 4 })), 4);
        assert_eq!(extract_deleted_count(&json!({ "deleted_count": 5 })), 5);
        assert_eq!(
            extract_deleted_count(&json!({ "deleted_memories": [{}, {}] })),
            2
        );
        assert_eq!(extract_deleted_count(&json!({ "missing": true })), 0);
        assert_eq!(
            extract_deleted_count(&json!({ "deleted": -1, "count": 2 })),
            2,
            "a negative candidate is skipped"
        );
        assert_eq!(
            extract_deleted_count(&json!({ "deleted": "not-a-number" })),
            0
        );
        assert_eq!(extract_deleted_count(&Value::Null), 0);
    }

    /// `extractErrorDetail` from `mem0/utils/index.ts:241-253`.
    #[test]
    fn extract_error_detail_prefers_detail_then_error_then_message() {
        assert_eq!(
            extract_error_detail(&json!({ "detail": "d", "error": "e", "message": "m" })),
            "d"
        );
        assert_eq!(
            extract_error_detail(&json!({ "error": "e", "message": "m" })),
            "e"
        );
        assert_eq!(extract_error_detail(&json!({ "message": "m" })), "m");
        assert_eq!(
            extract_error_detail(&json!({ "error": { "code": 404 } })),
            "",
            "a non-string `error` yields the status-line fallback"
        );
        assert_eq!(extract_error_detail(&Value::Null), "");
        assert_eq!(extract_error_detail(&json!({ "detail": "  " })), "");
    }

    /// `mem0/utils/http.ts:41-107` — the classifiers read the rendered message.
    #[test]
    fn classifiers_match_the_typescript_regexes() {
        assert!(is_network_error(&MemoryError::message("fetch failed")));
        assert!(is_network_error(&MemoryError::message(
            "connect ECONNRESET 1.2.3.4"
        )));
        assert!(!is_network_error(&MemoryError::message("HTTP 500")));

        assert!(is_transient_http_error(&MemoryError::message(
            "Mem0 request failed with HTTP 502."
        )));
        assert!(is_transient_http_error(&MemoryError::message(
            "Mem0 request failed with HTTP 429."
        )));
        assert!(
            !is_transient_http_error(&MemoryError::message("Mem0 request failed with HTTP 400.")),
            "400 is not transient"
        );
        assert!(
            !is_transient_http_error(&MemoryError::message(
                "Mem0 request failed with HTTP 404: HTTP 500."
            )),
            "only the first status is tested, like the single `exec`"
        );
        assert!(!is_transient_http_error(&MemoryError::message(
            "no status at all"
        )));

        assert!(is_timeout_error(&MemoryError::message(
            "Mem0 request timeout after 50ms."
        )));
        assert!(!is_timeout_error(&MemoryError::message(MEM0_ABORT_MESSAGE)));

        assert!(is_v2_unavailable_error(&MemoryError::message(
            "Mem0 request failed with HTTP 405."
        )));
        assert!(!is_v2_unavailable_error(&MemoryError::message(
            "Mem0 request failed with HTTP 400."
        )));
        assert!(is_legacy_delete_filter_error(&MemoryError::message(
            "Mem0 request failed with HTTP 400."
        )));
        assert!(!is_legacy_delete_filter_error(&MemoryError::message(
            "Mem0 request failed with HTTP 500."
        )));

        assert!(is_mem0_runtime_unconfigured_error(&MemoryError::message(
            "Mem0 request failed with HTTP 503: Mem0 runtime is not configured."
        )));
        assert!(
            !is_mem0_runtime_unconfigured_error(&MemoryError::message(
                "Mem0 request failed with HTTP 503: other"
            )),
            "the marker must be present"
        );
        assert!(
            !is_mem0_invalid_model_config_error(&MemoryError::message(
                "Mem0 request failed with HTTP 404: memory not found."
            )),
            "a plain 404 is not a model configuration problem"
        );
    }

    /// `Number(text)` for the environment strings (`client.ts:299-322`).
    #[test]
    fn js_number_str_follows_javascript_number() {
        assert_eq!(js_number_str("  15000  "), 15_000.0);
        assert_eq!(js_number_str(""), 0.0, "`Number('')` is 0");
        assert_eq!(js_number_str("1e3"), 1_000.0);
        assert_eq!(js_number_str("0x10"), 16.0);
        assert_eq!(js_number_str("0b101"), 5.0);
        assert_eq!(js_number_str("0o17"), 15.0);
        assert_eq!(js_number_str("Infinity"), f64::INFINITY);
        assert_eq!(js_number_str("-Infinity"), f64::NEG_INFINITY);
        assert!(js_number_str("-1.5").eq(&-1.5));
        assert!(js_number_str("abc").is_nan());
        assert!(js_number_str("15abc").is_nan());
        assert!(
            js_number_str("inf").is_nan(),
            "JavaScript does not accept lower-case infinity"
        );
        assert!(js_number_str("NaN").is_nan());
        assert!(js_number_str("0x").is_nan());

        assert_eq!(js_number_value(Some(&json!(null))), 0.0);
        assert_eq!(js_number_value(Some(&json!(true))), 1.0);
        assert_eq!(js_number_value(Some(&json!(" 42 "))), 42.0);
        assert!(js_number_value(None).is_nan());
        assert!(js_number_value(Some(&json!({}))).is_nan());
    }

    /// `encodeURIComponent` and the `URLSearchParams` serialiser of
    /// `delete.ts:70-73` and `recall.ts:91-97`.
    #[test]
    fn the_url_helpers_reproduce_the_javascript_encoders() {
        assert_eq!(encode_uri_component("aZ0-_.!~*'()"), "aZ0-_.!~*'()");
        assert_eq!(encode_uri_component("a/b+c=d&e"), "a%2Fb%2Bc%3Dd%26e");
        assert_eq!(encode_uri_component("ä"), "%C3%A4");

        assert_eq!(
            form_urlencode(&[("user_id", "user-1"), ("agent_id", "persona-1")]),
            "user_id=user-1&agent_id=persona-1"
        );
        assert_eq!(
            form_urlencode(&[("query", "a b/c~")]),
            "query=a+b%2Fc%7E",
            "spaces become `+`; `~` is escaped because the form-urlencoded set \
             is smaller than encodeURIComponent's"
        );

        assert_eq!(normalize_base_url("https://x///"), "https://x");
        assert_eq!(normalize_api_path("v1/"), "/v1");
        assert_eq!(
            join_url("https://x//", "v1", "memories"),
            "https://x/v1/memories"
        );
        assert_eq!(normalize_text("  AbC "), "abc");
    }

    /// `operations/feedback.ts:28-46` — placeholders without an endpoint.
    #[tokio::test]
    async fn the_feedback_placeholders_stay_placeholders() {
        let outcome = submit_feedback(&FeedbackInput {
            memory_id: "mem0-1".to_string(),
            rating: FeedbackRating::Positive,
            comment: Some("thanks".to_string()),
        })
        .await;

        assert!(!outcome.success);
        assert!(get_memory_feedback("mem0-1").await.is_empty());
        assert_eq!(FeedbackRating::Neutral.as_str(), "neutral");
    }
}
