//! Port of `src/server/memory/mem0EmbedderSync.ts:1-469` — push the active
//! Model Hub LLM and embedder into the Mem0 admin API.
//!
//! | TypeScript                                             | Rust |
//! | ------------------------------------------------------ | ---- |
//! | `mem0EmbedderSync.ts:6-9` (constants)                   | the `pub const`s below |
//! | `mem0EmbedderSync.ts:11-17` (`isEnabled`)               | [`is_enabled`] |
//! | `mem0EmbedderSync.ts:19-22` (`Mem0ProviderPayload`)     | [`Mem0ProviderPayload`] |
//! | `mem0EmbedderSync.ts:24-43` (result interfaces)         | [`Mem0EmbedderSyncResult`], [`Mem0LlmSyncResult`] |
//! | `mem0EmbedderSync.ts:45-53` (`normalizeBearerSecret`)   | [`normalize_bearer_secret`] |
//! | `mem0EmbedderSync.ts:55-60` (`normalizeGeminiModelName`)| [`normalize_gemini_model_name`] |
//! | `mem0EmbedderSync.ts:62-67` (`normalizeProviderModelName`)| [`normalize_provider_model_name`] |
//! | `mem0EmbedderSync.ts:69-73` (`asPositiveInteger`)       | [`as_positive_integer`] |
//! | `mem0EmbedderSync.ts:75-80` (`resolveEmbeddingProfileHead`)| [`resolve_embedding_profile_head`] |
//! | `mem0EmbedderSync.ts:82-115` (`buildMem0LlmPayload`)    | [`build_mem0_llm_payload`] |
//! | `mem0EmbedderSync.ts:117-149` (`buildMem0EmbedderPayload`)| [`build_mem0_embedder_payload`] |
//! | `mem0EmbedderSync.ts:151-168` (`resolveMem0SyncTarget`) | [`resolve_mem0_sync_target`] |
//! | `mem0EmbedderSync.ts:170-176` (`extractEmbeddingDims`)  | [`extract_embedding_dims`] |
//! | `mem0EmbedderSync.ts:178-195` (`resolveAccountWithSecret`)| [`resolve_account_with_secret`] |
//! | `mem0EmbedderSync.ts:197-218` (`probeEmbeddingDims`)    | [`probe_embedding_dims`] |
//! | `mem0EmbedderSync.ts:220-261` (`postMem0Admin`)         | [`post_mem0_admin`] |
//! | `mem0EmbedderSync.ts:263-344` (`syncMem0LlmFromModelHub`)| [`sync_mem0_llm_from_model_hub`] |
//! | `mem0EmbedderSync.ts:346-469` (`syncMem0EmbedderFromModelHub`)| [`sync_mem0_embedder_from_model_hub`] |
//!
//! # Seams
//!
//! 1. **`getModelHubService()` / `getModelHubEncryptionKey()`.** Both are
//!    process singletons in TypeScript. The port takes a [`Mem0ModelHub`] seam
//!    and the encryption key as arguments, like the rest of this slice.
//! 2. **`fetch`.** `postMem0Admin` talks to the Mem0 admin API; the port uses
//!    the shared [`HttpTransport`] and carries the timeout on the request (the
//!    concrete client applies it, `model_hub/http.rs:235`).
//! 3. **`decryptSecret` throws.** `resolveAccountWithSecret` lets the throw
//!    escape as a rejected promise; the port reports it as
//!    [`Mem0SyncError::Crypto`].

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::model_hub::crypto::decrypt_secret;
use crate::model_hub::http::{BoxFuture, HttpError, HttpRequest, HttpTransport};
use crate::model_hub::provider_catalog::find_provider;
use crate::model_hub::types::{
    PipelineModelEntry, PipelineStatus, ProviderAccountRecord, ProviderCapability,
};

/// `Mem0ProviderPayload.config` builder: `Map` with the keys in source order.
fn config(entries: Vec<(&str, Value)>) -> Map<String, Value> {
    let mut map = Map::new();
    for (key, value) in entries {
        map.insert(key.to_string(), value);
    }
    map
}

/// `CHAT_PROFILE_ID` — `mem0EmbedderSync.ts:6`.
pub const CHAT_PROFILE_ID: &str = "p1";
/// `EMBEDDING_PROFILE_ID` — `mem0EmbedderSync.ts:7`.
pub const EMBEDDING_PROFILE_ID: &str = "p1-embeddings";
/// `DEFAULT_SYNC_TIMEOUT_MS` — `mem0EmbedderSync.ts:8`.
pub const DEFAULT_SYNC_TIMEOUT_MS: u64 = 10_000;
/// `MEM0_PGVECTOR_HNSW_MAX_DIMS` — `mem0EmbedderSync.ts:9`.
pub const MEM0_PGVECTOR_HNSW_MAX_DIMS: i64 = 2_000;

/// `isEnabled` — `mem0EmbedderSync.ts:11-17`.
pub fn is_enabled(value: Option<&str>) -> bool {
    matches!(
        value.unwrap_or("").trim().to_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

/// `Mem0ProviderPayload` — `mem0EmbedderSync.ts:19-22`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Mem0ProviderPayload {
    pub provider: String,
    pub config: Map<String, Value>,
}

/// `Mem0EmbedderSyncResult` — `mem0EmbedderSync.ts:24-33`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mem0EmbedderSyncResult {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skipped: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub embedding_dims: Option<i64>,
}

/// `Mem0LlmSyncResult` — `mem0EmbedderSync.ts:35-43`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mem0LlmSyncResult {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skipped: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_name: Option<String>,
}

/// `resolveAccountWithSecret`'s result — `mem0EmbedderSync.ts:191-194`.
#[derive(Debug)]
pub struct AccountWithSecret {
    pub account: ProviderAccountRecord,
    pub secret: String,
}

/// The failure seam of `decryptSecret`, which the TypeScript lets escape as a
/// rejected promise (seam 3).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Mem0SyncError {
    /// `decryptSecret` threw (`gemini.ts:17`).
    #[error("{0}")]
    Crypto(String),
    /// A `getModelHubService()` call threw.
    #[error("{0}")]
    Service(String),
}

/// The Model Hub half of `mem0EmbedderSync.ts` (seam 1).
///
/// Mirrors `getModelHubService().listPipeline`, `.getUsableAccountById` and
/// `.dispatchEmbedding`; every method reports a thrown error as `Err(String)`.
pub trait Mem0ModelHub {
    fn list_pipeline(&self, profile_id: &str) -> Result<Vec<PipelineModelEntry>, String>;

    fn get_usable_account_by_id<'a>(
        &'a self,
        account_id: &'a str,
        encryption_key: &'a str,
    ) -> BoxFuture<'a, Result<Option<ProviderAccountRecord>, String>>;

    fn dispatch_embedding<'a>(
        &'a self,
        encryption_key: &'a str,
        input: &'a Value,
    ) -> BoxFuture<'a, Result<Value, String>>;
}

/// `normalizeBearerSecret` — `mem0EmbedderSync.ts:45-53`.
pub fn normalize_bearer_secret(secret: &str) -> String {
    let mut normalized = secret.trim().to_string();

    // `normalized.replace(/^['"`](.*)['"`]$/s, '$1').trim()` — one surrounding
    // quote layer, and `.` matches newlines with the `/s` flag.
    let bytes = normalized.clone().into_bytes();
    if bytes.len() >= 2 {
        let first = bytes[0];
        let last = bytes[bytes.len() - 1];
        if matches!(first, b'\'' | b'"' | b'`') && last == first {
            normalized = normalized[1..normalized.len() - 1].trim().to_string();
        }
    }

    // `normalized.replace(/^Bearer\s+/i, '').trim()`.
    if normalized.len() >= 7 && normalized[..7].eq_ignore_ascii_case("Bearer ") {
        normalized = normalized[7..].trim().to_string();
    }

    // `normalized.replace(/\\[nrt]/g, '')` — remove the two-character escapes.
    normalized = normalized
        .replace("\\n", "")
        .replace("\\r", "")
        .replace("\\t", "");
    // `normalized.replace(/[\r\n\t]/g, '')` — remove the literal characters.
    normalized.replace(['\r', '\n', '\t'], "")
}

/// `normalizeGeminiModelName` — `mem0EmbedderSync.ts:55-60`.
pub fn normalize_gemini_model_name(model_name: &str) -> String {
    let trimmed = model_name.trim();
    if trimmed.len() >= 7 && trimmed[..7].eq_ignore_ascii_case("models/") {
        trimmed[7..].trim().to_string()
    } else {
        trimmed.to_string()
    }
}

/// `normalizeProviderModelName` — `mem0EmbedderSync.ts:62-67`.
pub fn normalize_provider_model_name(provider_id: &str, model_name: &str) -> String {
    if provider_id == "gemini" {
        return normalize_gemini_model_name(model_name);
    }
    model_name.trim().to_string()
}

/// `asPositiveInteger` — `mem0EmbedderSync.ts:69-73`.
///
/// `Number.parseInt(value, 10)` reads an optional sign and the leading digits,
/// so `"12abc"` is `12` and `"abc"` is `NaN`.
pub fn as_positive_integer(value: Option<&str>) -> Option<i64> {
    let text = value.unwrap_or("").trim_start();
    let mut chars = text.char_indices().peekable();
    let mut sign = 1i64;
    if let Some((_, '+' | '-')) = chars.peek().map(|(index, ch)| (*index, *ch)) {
        if chars.peek().map(|(_, ch)| *ch) == Some('-') {
            sign = -1;
        }
        chars.next();
    }
    let digits: String = chars
        .take_while(|(_, ch)| ch.is_ascii_digit())
        .map(|(_, ch)| ch)
        .collect();
    if digits.is_empty() {
        return None;
    }
    let parsed: i64 = digits.parse().ok()?;
    let parsed = parsed.checked_mul(sign)?;
    if parsed <= 0 {
        None
    } else {
        Some(parsed)
    }
}

/// `resolveEmbeddingProfileHead` — `mem0EmbedderSync.ts:75-80`.
///
/// `filter(status === 'active').sort((a, b) => a.priority - b.priority)[0]`:
/// the lowest priority wins, ties keep the first occurrence (`Array#sort` is
/// stable).
pub fn resolve_embedding_profile_head(
    entries: &[PipelineModelEntry],
) -> Option<&PipelineModelEntry> {
    let mut head: Option<&PipelineModelEntry> = None;
    for entry in entries
        .iter()
        .filter(|entry| entry.status == PipelineStatus::Active)
    {
        match head {
            Some(current) if current.priority <= entry.priority => {}
            _ => head = Some(entry),
        }
    }
    head
}

/// `extractEmbeddingDims` — `mem0EmbedderSync.ts:170-176`.
pub fn extract_embedding_dims(payload: &Value) -> Option<i64> {
    let embedding = payload.get("embedding")?;
    if !embedding.is_object() {
        return None;
    }
    let values = embedding.get("values")?;
    let values = values.as_array()?;
    if values.is_empty() {
        return None;
    }
    Some(values.len() as i64)
}

/// `buildMem0LlmPayload` — `mem0EmbedderSync.ts:82-115`.
pub fn build_mem0_llm_payload(
    account: &ProviderAccountRecord,
    model_name: &str,
    decrypted_secret: &str,
) -> Option<Mem0ProviderPayload> {
    let catalog = find_provider(&account.provider_id)?;

    if catalog.id == "gemini" {
        return Some(Mem0ProviderPayload {
            provider: "gemini".to_string(),
            config: config(vec![
                ("api_key", Value::String(decrypted_secret.to_string())),
                (
                    "model",
                    Value::String(normalize_gemini_model_name(model_name)),
                ),
                ("temperature", json_number(0.2)),
            ]),
        });
    }

    // Mem0 openai llm supports arbitrary OpenAI-compatible base URLs.
    let base_url = catalog
        .api_base_url
        .clone()
        .filter(|value| !value.is_empty())?;
    if !catalog.capabilities.contains(&ProviderCapability::Chat) {
        return None;
    }
    Some(Mem0ProviderPayload {
        provider: "openai".to_string(),
        config: config(vec![
            (
                "api_key",
                Value::String(normalize_bearer_secret(decrypted_secret)),
            ),
            ("model", Value::String(model_name.to_string())),
            ("openai_base_url", Value::String(base_url)),
        ]),
    })
}

/// `buildMem0EmbedderPayload` — `mem0EmbedderSync.ts:117-149`.
pub fn build_mem0_embedder_payload(
    account: &ProviderAccountRecord,
    model_name: &str,
    decrypted_secret: &str,
) -> Option<Mem0ProviderPayload> {
    let catalog = find_provider(&account.provider_id)?;

    if catalog.id == "gemini" {
        return Some(Mem0ProviderPayload {
            provider: "gemini".to_string(),
            config: config(vec![
                ("api_key", Value::String(decrypted_secret.to_string())),
                (
                    "model",
                    Value::String(normalize_gemini_model_name(model_name)),
                ),
            ]),
        });
    }

    // Mem0 openai embedder supports arbitrary OpenAI-compatible base URLs.
    let base_url = catalog
        .api_base_url
        .clone()
        .filter(|value| !value.is_empty())?;
    if !catalog
        .capabilities
        .contains(&ProviderCapability::Embeddings)
    {
        return None;
    }
    Some(Mem0ProviderPayload {
        provider: "openai".to_string(),
        config: config(vec![
            (
                "api_key",
                Value::String(normalize_bearer_secret(decrypted_secret)),
            ),
            ("model", Value::String(model_name.to_string())),
            ("openai_base_url", Value::String(base_url)),
        ]),
    })
}

/// `Number` JSON value of a Rust `f64` literal.
fn json_number(value: f64) -> Value {
    serde_json::Number::from_f64(value)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

/// `resolveMem0SyncTarget`'s result — `mem0EmbedderSync.ts:151-155`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mem0SyncTarget {
    pub base_url: String,
    pub api_key: String,
    pub timeout_ms: u64,
}

/// `resolveMem0SyncTarget` — `mem0EmbedderSync.ts:151-168`.
pub fn resolve_mem0_sync_target(env: &HashMap<String, String>) -> Option<Mem0SyncTarget> {
    let provider = env
        .get("MEMORY_PROVIDER")
        .map(|value| value.trim().to_lowercase())
        .unwrap_or_default();
    if !provider.is_empty() && provider != "mem0" {
        return None;
    }
    let base_url = env
        .get("MEM0_BASE_URL")
        .map(|value| value.trim())
        .unwrap_or("");
    let api_key = env
        .get("MEM0_API_KEY")
        .map(|value| value.trim())
        .unwrap_or("");
    if base_url.is_empty() || api_key.is_empty() {
        return None;
    }

    let timeout_ms =
        as_positive_integer(env.get("MEM0_EMBEDDER_SYNC_TIMEOUT_MS").map(String::as_str))
            .map(|value| value as u64)
            .unwrap_or(DEFAULT_SYNC_TIMEOUT_MS);

    Some(Mem0SyncTarget {
        base_url: base_url.trim_end_matches('/').to_string(),
        api_key: api_key.to_string(),
        timeout_ms,
    })
}

/// `resolveAccountWithSecret` — `mem0EmbedderSync.ts:182-195`.
pub async fn resolve_account_with_secret(
    service: &dyn Mem0ModelHub,
    account_id: &str,
    encryption_key: &str,
) -> Result<Option<AccountWithSecret>, Mem0SyncError> {
    let Some(account) = service
        .get_usable_account_by_id(account_id, encryption_key)
        .await
        .map_err(Mem0SyncError::Service)?
    else {
        return Ok(None);
    };
    let secret = decrypt_secret(&account.encrypted_secret_payload(), encryption_key)
        .map_err(|error| Mem0SyncError::Crypto(error.to_string()))?;
    let secret = secret.trim();
    if secret.is_empty() {
        return Ok(None);
    }
    Ok(Some(AccountWithSecret {
        account,
        secret: secret.to_string(),
    }))
}

/// `probeEmbeddingDims` — `mem0EmbedderSync.ts:197-218`.
pub async fn probe_embedding_dims(
    service: &dyn Mem0ModelHub,
    model_name: &str,
    encryption_key: &str,
    requested_dims: Option<i64>,
) -> Result<Option<i64>, Mem0SyncError> {
    let mut payload = Map::new();
    payload.insert("model".to_string(), Value::String(model_name.to_string()));
    payload.insert(
        "input".to_string(),
        Value::Array(vec![Value::String("mem0-dimension-probe".to_string())]),
    );
    if let Some(requested_dims) = requested_dims.filter(|value| *value > 0) {
        payload.insert(
            "dimensions".to_string(),
            Value::Number(requested_dims.into()),
        );
    }

    let input = json_object(vec![
        ("operation", Value::String("embedContent".to_string())),
        ("payload", Value::Object(payload)),
    ]);
    let result = service
        .dispatch_embedding(encryption_key, &input)
        .await
        .map_err(Mem0SyncError::Service)?;

    if let Some(error) = result.get("error").and_then(Value::as_str) {
        if !error.trim().is_empty() {
            return Ok(None);
        }
    }
    Ok(extract_embedding_dims(&result))
}

/// A JSON object built from ordered entries.
fn json_object(entries: Vec<(&str, Value)>) -> Value {
    Value::Object(config(entries))
}

/// `Mem0AdminResponse` — `mem0EmbedderSync.ts:220-223`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mem0AdminResponse {
    pub ok: bool,
    pub error: Option<String>,
}

/// `postMem0Admin` — `mem0EmbedderSync.ts:225-261`.
///
/// The `AbortController` deadline travels on the request (`timeout_ms`); the
/// transport reports an elapsed deadline as [`HttpError::Timeout`].
pub async fn post_mem0_admin(
    transport: &dyn HttpTransport,
    target: &Mem0SyncTarget,
    endpoint_path: &str,
    payload: &Value,
) -> Mem0AdminResponse {
    let request = HttpRequest::post(format!("{}{endpoint_path}", target.base_url))
        .header("Content-Type", "application/json")
        .header("Authorization", &format!("Bearer {}", target.api_key))
        .json_body(payload)
        .timeout_ms(target.timeout_ms);

    match transport.send(request).await {
        Ok(response) => {
            if response.is_ok() {
                return Mem0AdminResponse {
                    ok: true,
                    error: None,
                };
            }
            let message = response.body;
            let detail = if message.is_empty() {
                String::new()
            } else {
                format!(": {message}")
            };
            Mem0AdminResponse {
                ok: false,
                error: Some(format!(
                    "Mem0 sync failed with HTTP {}{detail}",
                    response.status.as_u16()
                )),
            }
        }
        Err(HttpError::Timeout) => Mem0AdminResponse {
            ok: false,
            error: Some(format!("Mem0 sync timeout after {}ms.", target.timeout_ms)),
        },
        Err(error) => Mem0AdminResponse {
            ok: false,
            error: Some(error.to_string()),
        },
    }
}

/// `syncMem0LlmFromModelHub` — `mem0EmbedderSync.ts:263-344`.
pub async fn sync_mem0_llm_from_model_hub(
    env: &HashMap<String, String>,
    service: &dyn Mem0ModelHub,
    encryption_key: &str,
    transport: &dyn HttpTransport,
) -> Result<Mem0LlmSyncResult, Mem0SyncError> {
    let Some(target) = resolve_mem0_sync_target(env) else {
        return Ok(Mem0LlmSyncResult {
            ok: false,
            skipped: Some(true),
            reason: Some("Mem0 runtime not configured; skipping llm sync.".to_string()),
            error: None,
            profile_id: None,
            provider_id: None,
            model_name: None,
        });
    };

    let pipeline = service
        .list_pipeline(CHAT_PROFILE_ID)
        .map_err(Mem0SyncError::Service)?;
    let Some(head) = resolve_embedding_profile_head(&pipeline) else {
        return Ok(Mem0LlmSyncResult {
            ok: false,
            skipped: None,
            reason: None,
            error: Some("No active llm model in p1.".to_string()),
            profile_id: Some(CHAT_PROFILE_ID.to_string()),
            provider_id: None,
            model_name: None,
        });
    };
    let provider_id = head.provider_id.clone();
    let configured_model = head.model_name.clone();
    let normalized = normalize_provider_model_name(&provider_id, &configured_model);
    if normalized.is_empty() {
        return Ok(Mem0LlmSyncResult {
            ok: false,
            skipped: None,
            reason: None,
            error: Some("No llm model name configured in p1.".to_string()),
            profile_id: Some(CHAT_PROFILE_ID.to_string()),
            provider_id: Some(provider_id),
            model_name: Some(configured_model),
        });
    }

    let Some(account) =
        resolve_account_with_secret(service, &head.account_id, encryption_key).await?
    else {
        return Ok(Mem0LlmSyncResult {
            ok: false,
            skipped: None,
            reason: None,
            error: Some(format!(
                "LLM account {} not found or secret missing.",
                head.account_id
            )),
            profile_id: Some(CHAT_PROFILE_ID.to_string()),
            provider_id: Some(provider_id),
            model_name: Some(configured_model),
        });
    };

    let Some(llm) = build_mem0_llm_payload(&account.account, &normalized, &account.secret) else {
        return Ok(Mem0LlmSyncResult {
            ok: false,
            skipped: None,
            reason: None,
            error: Some(format!(
                "LLM provider \"{provider_id}\" is not supported for Mem0 sync."
            )),
            profile_id: Some(CHAT_PROFILE_ID.to_string()),
            provider_id: Some(provider_id),
            model_name: Some(normalized),
        });
    };

    let response =
        post_mem0_admin(transport, &target, "/configure/llm", &json!({ "llm": llm })).await;
    if !response.ok {
        return Ok(Mem0LlmSyncResult {
            ok: false,
            skipped: None,
            reason: None,
            error: response.error,
            profile_id: Some(CHAT_PROFILE_ID.to_string()),
            provider_id: Some(provider_id),
            model_name: Some(normalized),
        });
    }

    Ok(Mem0LlmSyncResult {
        ok: true,
        skipped: None,
        reason: None,
        error: None,
        profile_id: Some(CHAT_PROFILE_ID.to_string()),
        provider_id: Some(provider_id),
        model_name: Some(normalized),
    })
}

/// `syncMem0EmbedderFromModelHub` — `mem0EmbedderSync.ts:346-469`.
pub async fn sync_mem0_embedder_from_model_hub(
    env: &HashMap<String, String>,
    service: &dyn Mem0ModelHub,
    encryption_key: &str,
    transport: &dyn HttpTransport,
) -> Result<Mem0EmbedderSyncResult, Mem0SyncError> {
    let Some(target) = resolve_mem0_sync_target(env) else {
        return Ok(Mem0EmbedderSyncResult {
            ok: false,
            skipped: Some(true),
            reason: Some("Mem0 runtime not configured; skipping embedder sync.".to_string()),
            error: None,
            profile_id: None,
            provider_id: None,
            model_name: None,
            embedding_dims: None,
        });
    };

    let pipeline = service
        .list_pipeline(EMBEDDING_PROFILE_ID)
        .map_err(Mem0SyncError::Service)?;
    let Some(head) = resolve_embedding_profile_head(&pipeline) else {
        return Ok(Mem0EmbedderSyncResult {
            ok: false,
            skipped: None,
            reason: None,
            error: Some("No active embedding model in p1-embeddings.".to_string()),
            profile_id: Some(EMBEDDING_PROFILE_ID.to_string()),
            provider_id: None,
            model_name: None,
            embedding_dims: None,
        });
    };
    let provider_id = head.provider_id.clone();
    let configured_model = head.model_name.clone();
    let normalized = normalize_provider_model_name(&provider_id, &configured_model);
    if normalized.is_empty() {
        return Ok(Mem0EmbedderSyncResult {
            ok: false,
            skipped: None,
            reason: None,
            error: Some("No embedding model name configured in p1-embeddings.".to_string()),
            profile_id: Some(EMBEDDING_PROFILE_ID.to_string()),
            provider_id: Some(provider_id),
            model_name: Some(configured_model),
            embedding_dims: None,
        });
    }

    let Some(account) =
        resolve_account_with_secret(service, &head.account_id, encryption_key).await?
    else {
        return Ok(Mem0EmbedderSyncResult {
            ok: false,
            skipped: None,
            reason: None,
            error: Some(format!(
                "Embedding account {} not found or secret missing.",
                head.account_id
            )),
            profile_id: Some(EMBEDDING_PROFILE_ID.to_string()),
            provider_id: Some(provider_id),
            model_name: Some(configured_model),
            embedding_dims: None,
        });
    };

    let Some(mut embedder) =
        build_mem0_embedder_payload(&account.account, &normalized, &account.secret)
    else {
        return Ok(Mem0EmbedderSyncResult {
            ok: false,
            skipped: None,
            reason: None,
            error: Some(format!(
                "Embedding provider \"{provider_id}\" is not supported for Mem0 sync."
            )),
            profile_id: Some(EMBEDDING_PROFILE_ID.to_string()),
            provider_id: Some(provider_id),
            model_name: Some(normalized),
            embedding_dims: None,
        });
    };

    let requested_dims = as_positive_integer(env.get("MEM0_EMBEDDING_DIMS").map(String::as_str));
    let measured_dims =
        probe_embedding_dims(service, &normalized, encryption_key, requested_dims).await?;
    let Some(embedding_dims) = measured_dims.or(requested_dims) else {
        return Ok(Mem0EmbedderSyncResult {
            ok: false,
            skipped: None,
            reason: None,
            error: Some(
                "Unable to determine embedding dimensions for Mem0 vector store.".to_string(),
            ),
            profile_id: Some(EMBEDDING_PROFILE_ID.to_string()),
            provider_id: Some(provider_id),
            model_name: Some(normalized),
            embedding_dims: None,
        });
    };

    if is_enabled(env.get("MEM0_VECTOR_HNSW").map(String::as_str))
        && embedding_dims > MEM0_PGVECTOR_HNSW_MAX_DIMS
    {
        return Ok(Mem0EmbedderSyncResult {
            ok: false,
            skipped: None,
            reason: None,
            error: Some(format!(
                "Embedding dimension {embedding_dims} exceeds Mem0 pgvector/hnsw limit ({MEM0_PGVECTOR_HNSW_MAX_DIMS}). Set MEM0_EMBEDDING_DIMS<={MEM0_PGVECTOR_HNSW_MAX_DIMS} for providers that support down-projection, or switch to a smaller embedding model."
            )),
            profile_id: Some(EMBEDDING_PROFILE_ID.to_string()),
            provider_id: Some(provider_id),
            model_name: Some(normalized),
            embedding_dims: Some(embedding_dims),
        });
    }

    if embedder.provider == "openai" {
        embedder.config.insert(
            "embedding_dims".to_string(),
            Value::Number(embedding_dims.into()),
        );
    }

    let response = post_mem0_admin(
        transport,
        &target,
        "/configure/embedder",
        &json!({ "embedder": embedder, "embedding_model_dims": embedding_dims }),
    )
    .await;
    if !response.ok {
        return Ok(Mem0EmbedderSyncResult {
            ok: false,
            skipped: None,
            reason: None,
            error: response.error,
            profile_id: Some(EMBEDDING_PROFILE_ID.to_string()),
            provider_id: Some(provider_id),
            model_name: Some(normalized),
            embedding_dims: Some(embedding_dims),
        });
    }

    Ok(Mem0EmbedderSyncResult {
        ok: true,
        skipped: None,
        reason: None,
        error: None,
        profile_id: Some(EMBEDDING_PROFILE_ID.to_string()),
        provider_id: Some(provider_id),
        model_name: Some(normalized),
        embedding_dims: Some(embedding_dims),
    })
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    use http::{Method, StatusCode};

    use super::*;
    use crate::model_hub::crypto::encrypt_secret_with_iv;
    use crate::model_hub::http::{BoxFuture, HttpResponse};
    use crate::model_hub::types::{EncryptedSecretPayloadJson, ProviderAuthMethod};

    const KEY: &str = "0123456789abcdef0123456789abcdef";

    fn dummy_encrypted() -> EncryptedSecretPayloadJson {
        EncryptedSecretPayloadJson {
            alg: "aes-256-gcm".to_string(),
            key_id: "default".to_string(),
            iv: String::new(),
            ciphertext: String::new(),
            tag: String::new(),
        }
    }

    fn encrypted_secret(secret: &str) -> EncryptedSecretPayloadJson {
        let payload = encrypt_secret_with_iv(secret, KEY, "default", &[0u8; 12]).expect("encrypt");
        EncryptedSecretPayloadJson::from_payload(&payload)
    }

    fn account(
        provider_id: &str,
        encrypted_secret: EncryptedSecretPayloadJson,
    ) -> ProviderAccountRecord {
        ProviderAccountRecord {
            id: "acct-1".to_string(),
            provider_id: provider_id.to_string(),
            label: "account".to_string(),
            auth_method: ProviderAuthMethod::ApiKey,
            secret_masked: "****".to_string(),
            has_refresh_token: false,
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
            updated_at: "2026-01-01T00:00:00.000Z".to_string(),
            last_check_at: None,
            last_check_ok: None,
            last_check_message: None,
            encrypted_secret,
            encrypted_refresh_token: None,
        }
    }

    fn entry(
        id: &str,
        profile_id: &str,
        provider_id: &str,
        model_name: &str,
        priority: i64,
        status: PipelineStatus,
    ) -> PipelineModelEntry {
        PipelineModelEntry {
            id: id.to_string(),
            profile_id: profile_id.to_string(),
            account_id: "acct-1".to_string(),
            provider_id: provider_id.to_string(),
            model_name: model_name.to_string(),
            reasoning_effort: None,
            priority,
            status,
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
            updated_at: "2026-01-01T00:00:00.000Z".to_string(),
        }
    }

    struct StubModelHub {
        pipeline: Vec<PipelineModelEntry>,
        account: Option<ProviderAccountRecord>,
        dispatch: Result<Value, String>,
    }

    impl Mem0ModelHub for StubModelHub {
        fn list_pipeline(&self, _profile_id: &str) -> Result<Vec<PipelineModelEntry>, String> {
            Ok(self.pipeline.clone())
        }

        fn get_usable_account_by_id<'a>(
            &'a self,
            _account_id: &'a str,
            _encryption_key: &'a str,
        ) -> BoxFuture<'a, Result<Option<ProviderAccountRecord>, String>> {
            let account = self.account.clone();
            Box::pin(async move { Ok(account) })
        }

        fn dispatch_embedding<'a>(
            &'a self,
            _encryption_key: &'a str,
            _input: &'a Value,
        ) -> BoxFuture<'a, Result<Value, String>> {
            let dispatch = self.dispatch.clone();
            Box::pin(async move { dispatch })
        }
    }

    struct StubTransport {
        requests: Mutex<Vec<HttpRequest>>,
        responses: Mutex<VecDeque<Result<HttpResponse, HttpError>>>,
    }

    impl StubTransport {
        fn new(responses: Vec<Result<HttpResponse, HttpError>>) -> Arc<Self> {
            Arc::new(Self {
                requests: Mutex::new(Vec::new()),
                responses: Mutex::new(responses.into()),
            })
        }
    }

    impl HttpTransport for StubTransport {
        fn send<'a>(
            &'a self,
            request: HttpRequest,
        ) -> BoxFuture<'a, Result<HttpResponse, HttpError>> {
            self.requests.lock().expect("lock").push(request);
            let response = self
                .responses
                .lock()
                .expect("lock")
                .pop_front()
                .expect("a canned response");
            Box::pin(async move { response })
        }
    }

    fn env(entries: &[(&str, &str)]) -> HashMap<String, String> {
        entries
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    #[test]
    fn bearer_secret_normalizes_quotes_bearer_and_control_characters() {
        assert_eq!(normalize_bearer_secret("  sk-abc  "), "sk-abc");
        assert_eq!(normalize_bearer_secret("\"sk-abc\""), "sk-abc");
        assert_eq!(normalize_bearer_secret("'sk-abc'"), "sk-abc");
        assert_eq!(normalize_bearer_secret("`sk-abc`"), "sk-abc");
        assert_eq!(normalize_bearer_secret("Bearer sk-abc"), "sk-abc");
        assert_eq!(normalize_bearer_secret("bearer   sk-abc"), "sk-abc");
        assert_eq!(normalize_bearer_secret("sk\\nabc"), "skabc");
        assert_eq!(normalize_bearer_secret("sk\rabc\ndef"), "skabcdef");
    }

    #[test]
    fn gemini_model_names_drop_the_models_prefix() {
        assert_eq!(
            normalize_gemini_model_name("  models/text-embedding  "),
            "text-embedding"
        );
        assert_eq!(
            normalize_gemini_model_name("MODELS/text-embedding"),
            "text-embedding"
        );
        assert_eq!(
            normalize_gemini_model_name("text-embedding"),
            "text-embedding"
        );
        assert_eq!(
            normalize_provider_model_name("gemini", " models/embedding-001"),
            "embedding-001"
        );
        assert_eq!(
            normalize_provider_model_name("openai", " text-embedding-3-small "),
            "text-embedding-3-small"
        );
    }

    #[test]
    fn as_positive_integer_reads_the_leading_decimal_digits() {
        assert_eq!(as_positive_integer(Some("12")), Some(12));
        assert_eq!(as_positive_integer(Some("12abc")), Some(12));
        assert_eq!(as_positive_integer(Some("  42  ")), Some(42));
        assert_eq!(as_positive_integer(Some("0")), None);
        assert_eq!(as_positive_integer(Some("-5")), None);
        assert_eq!(as_positive_integer(Some("abc")), None);
        assert_eq!(as_positive_integer(None), None);
    }

    #[test]
    fn the_profile_head_is_the_lowest_priority_active_entry() {
        let entries = vec![
            entry("a", "p1", "openai", "gpt", 5, PipelineStatus::Active),
            entry("b", "p1", "openai", "gpt", 1, PipelineStatus::RateLimited),
            entry("c", "p1", "openai", "gpt", 2, PipelineStatus::Active),
            entry("d", "p1", "openai", "gpt", 3, PipelineStatus::Active),
        ];
        let head = resolve_embedding_profile_head(&entries).expect("head");
        assert_eq!(head.id, "c");
        assert!(resolve_embedding_profile_head(&[]).is_none());
    }

    #[test]
    fn embedding_dims_come_from_a_non_empty_values_array() {
        assert_eq!(
            extract_embedding_dims(&json!({ "embedding": { "values": [1.0, 2.0, 3.0] } })),
            Some(3)
        );
        assert_eq!(
            extract_embedding_dims(&json!({ "embedding": { "values": [] } })),
            None
        );
        assert_eq!(extract_embedding_dims(&json!({ "embedding": "x" })), None);
        assert_eq!(extract_embedding_dims(&json!({})), None);
    }

    #[test]
    fn gemini_payloads_carry_the_secret_and_temp() {
        let llm = build_mem0_llm_payload(
            &account("gemini", dummy_encrypted()),
            "models/gemini-2",
            "AIza-secret",
        )
        .expect("payload");
        assert_eq!(llm.provider, "gemini");
        assert_eq!(llm.config["api_key"], json!("AIza-secret"));
        assert_eq!(llm.config["model"], json!("gemini-2"));
        assert_eq!(llm.config["temperature"], json!(0.2));

        let embedder = build_mem0_embedder_payload(
            &account("gemini", dummy_encrypted()),
            "models/embedding-001",
            "AIza",
        )
        .expect("payload");
        assert_eq!(embedder.provider, "gemini");
        assert_eq!(embedder.config["model"], json!("embedding-001"));
        assert!(embedder.config.get("temperature").is_none());
    }

    #[test]
    fn openai_compatible_payloads_use_the_catalog_base_url() {
        let llm = build_mem0_llm_payload(
            &account("openai", dummy_encrypted()),
            "gpt-5",
            "Bearer sk-x",
        )
        .expect("payload");
        assert_eq!(llm.provider, "openai");
        assert_eq!(llm.config["api_key"], json!("sk-x"));
        assert_eq!(
            llm.config["openai_base_url"],
            json!("https://api.openai.com/v1")
        );

        let embedder = build_mem0_embedder_payload(
            &account("openai", dummy_encrypted()),
            "text-embedding-3-small",
            "sk-y",
        )
        .expect("payload");
        assert_eq!(embedder.provider, "openai");
        assert_eq!(
            embedder.config["openai_base_url"],
            json!("https://api.openai.com/v1")
        );
    }

    #[test]
    fn a_provider_without_the_capability_or_the_catalog_entry_is_unsupported() {
        // opencode advertises chat but no embeddings.
        assert!(
            build_mem0_llm_payload(&account("opencode", dummy_encrypted()), "m", "s").is_some()
        );
        assert!(
            build_mem0_embedder_payload(&account("opencode", dummy_encrypted()), "m", "s")
                .is_none()
        );
        assert!(build_mem0_llm_payload(&account("unknown", dummy_encrypted()), "m", "s").is_none());
    }

    #[test]
    fn the_sync_target_requires_mem0_credentials_and_trims_the_trailing_slash() {
        assert!(resolve_mem0_sync_target(&env(&[("MEMORY_PROVIDER", "postgres")])).is_none());
        assert!(resolve_mem0_sync_target(&env(&[("MEMORY_PROVIDER", "mem0")])).is_none());
        assert!(
            resolve_mem0_sync_target(&env(&[("MEM0_BASE_URL", "https://mem0")])).is_none(),
            "missing api key"
        );

        let target = resolve_mem0_sync_target(&env(&[
            ("MEM0_BASE_URL", "https://mem0///"),
            ("MEM0_API_KEY", "kc"),
        ]))
        .expect("target");
        assert_eq!(target.base_url, "https://mem0");
        assert_eq!(target.api_key, "kc");
        assert_eq!(target.timeout_ms, DEFAULT_SYNC_TIMEOUT_MS);

        let custom = resolve_mem0_sync_target(&env(&[
            ("MEMORY_PROVIDER", "mem0"),
            ("MEM0_BASE_URL", "https://mem0"),
            ("MEM0_API_KEY", "kc"),
            ("MEM0_EMBEDDER_SYNC_TIMEOUT_MS", "2500"),
        ]))
        .expect("target");
        assert_eq!(custom.timeout_ms, 2_500);
    }

    #[tokio::test]
    async fn post_mem0_admin_reports_success_failure_and_timeout() {
        let target = Mem0SyncTarget {
            base_url: "https://mem0".to_string(),
            api_key: "kc".to_string(),
            timeout_ms: 10_000,
        };

        let ok_transport = StubTransport::new(vec![Ok(HttpResponse::json(
            StatusCode::OK,
            &json!({ "ok": true }),
        ))]);
        let response = post_mem0_admin(
            ok_transport.as_ref(),
            &target,
            "/configure/llm",
            &json!({ "llm": {} }),
        )
        .await;
        assert!(response.ok);
        assert!(response.error.is_none());
        {
            let requests = ok_transport.requests.lock().expect("lock");
            assert_eq!(requests[0].method, Method::POST);
            assert_eq!(requests[0].url, "https://mem0/configure/llm");
            assert_eq!(
                requests[0]
                    .headers
                    .get("authorization")
                    .and_then(|value| value.to_str().ok()),
                Some("Bearer kc")
            );
            assert_eq!(requests[0].timeout_ms, 10_000);
        }

        let failing = StubTransport::new(vec![Ok(HttpResponse::text(
            StatusCode::UNAUTHORIZED,
            "invalid key",
        ))]);
        let response =
            post_mem0_admin(failing.as_ref(), &target, "/configure/llm", &json!({})).await;
        assert_eq!(
            response.error.as_deref(),
            Some("Mem0 sync failed with HTTP 401: invalid key")
        );

        let timed_out = StubTransport::new(vec![Err(HttpError::Timeout)]);
        let response =
            post_mem0_admin(timed_out.as_ref(), &target, "/configure/llm", &json!({})).await;
        assert_eq!(
            response.error.as_deref(),
            Some("Mem0 sync timeout after 10000ms.")
        );
    }

    #[tokio::test]
    async fn probe_embedding_dims_reads_the_embedding_answer() {
        let hub = StubModelHub {
            pipeline: vec![],
            account: None,
            dispatch: Ok(json!({ "embedding": { "values": [0.0, 1.0, 2.0] } })),
        };
        assert_eq!(
            probe_embedding_dims(&hub, "model", KEY, None)
                .await
                .expect("ok"),
            Some(3)
        );

        let errored = StubModelHub {
            pipeline: vec![],
            account: None,
            dispatch: Ok(json!({ "error": "bad payload" })),
        };
        assert_eq!(
            probe_embedding_dims(&errored, "model", KEY, Some(4))
                .await
                .expect("ok"),
            None
        );
    }

    #[tokio::test]
    async fn a_malformed_encrypted_secret_surfaces_as_a_crypto_error() {
        let hub = StubModelHub {
            pipeline: vec![],
            account: Some(account("openai", dummy_encrypted())),
            dispatch: Ok(json!({})),
        };
        let error = resolve_account_with_secret(&hub, "acct-1", KEY)
            .await
            .expect_err("crypto error");
        assert!(matches!(error, Mem0SyncError::Crypto(_)));
    }

    #[tokio::test]
    async fn the_llm_sync_is_skipped_without_a_target() {
        let hub = StubModelHub {
            pipeline: vec![],
            account: None,
            dispatch: Ok(json!({})),
        };
        let transport = StubTransport::new(vec![]);
        let result = sync_mem0_llm_from_model_hub(&env(&[]), &hub, KEY, transport.as_ref())
            .await
            .expect("ok");
        assert!(!result.ok);
        assert_eq!(result.skipped, Some(true));
        assert_eq!(
            result.reason.as_deref(),
            Some("Mem0 runtime not configured; skipping llm sync.")
        );
        assert!(transport.requests.lock().expect("lock").is_empty());
    }

    #[tokio::test]
    async fn the_llm_sync_pushes_the_profile_head() {
        let hub = StubModelHub {
            pipeline: vec![entry(
                "a",
                "p1",
                "openai",
                "gpt-5",
                1,
                PipelineStatus::Active,
            )],
            account: Some(account("openai", encrypted_secret("sk-live"))),
            dispatch: Ok(json!({})),
        };
        let transport = StubTransport::new(vec![Ok(HttpResponse::json(
            StatusCode::OK,
            &json!({ "ok": true }),
        ))]);
        let result = sync_mem0_llm_from_model_hub(
            &env(&[("MEM0_BASE_URL", "https://mem0"), ("MEM0_API_KEY", "kc")]),
            &hub,
            KEY,
            transport.as_ref(),
        )
        .await
        .expect("ok");
        assert!(result.ok);
        assert_eq!(result.profile_id.as_deref(), Some("p1"));
        assert_eq!(result.provider_id.as_deref(), Some("openai"));
        assert_eq!(result.model_name.as_deref(), Some("gpt-5"));

        let requests = transport.requests.lock().expect("lock");
        let body: Value =
            serde_json::from_str(requests[0].body.as_deref().expect("body")).expect("json");
        assert_eq!(body["llm"]["provider"], json!("openai"));
        assert_eq!(body["llm"]["config"]["api_key"], json!("sk-live"));
        assert_eq!(body["llm"]["config"]["model"], json!("gpt-5"));
    }

    #[tokio::test]
    async fn the_llm_sync_reports_an_empty_pipeline() {
        let hub = StubModelHub {
            pipeline: vec![],
            account: None,
            dispatch: Ok(json!({})),
        };
        let transport = StubTransport::new(vec![]);
        let result = sync_mem0_llm_from_model_hub(
            &env(&[("MEM0_BASE_URL", "https://mem0"), ("MEM0_API_KEY", "kc")]),
            &hub,
            KEY,
            transport.as_ref(),
        )
        .await
        .expect("ok");
        assert_eq!(result.error.as_deref(), Some("No active llm model in p1."));
        assert_eq!(result.profile_id.as_deref(), Some("p1"));
    }

    #[tokio::test]
    async fn the_embedder_sync_pushes_the_measured_dims() {
        let hub = StubModelHub {
            pipeline: vec![entry(
                "a",
                "p1-embeddings",
                "openai",
                "text-embedding-3-small",
                1,
                PipelineStatus::Active,
            )],
            account: Some(account("openai", encrypted_secret("sk-embed"))),
            dispatch: Ok(json!({ "embedding": { "values": [0.0, 1.0, 2.0, 3.0] } })),
        };
        let transport = StubTransport::new(vec![Ok(HttpResponse::json(
            StatusCode::OK,
            &json!({ "ok": true }),
        ))]);
        let result = sync_mem0_embedder_from_model_hub(
            &env(&[("MEM0_BASE_URL", "https://mem0"), ("MEM0_API_KEY", "kc")]),
            &hub,
            KEY,
            transport.as_ref(),
        )
        .await
        .expect("ok");
        assert!(result.ok);
        assert_eq!(result.embedding_dims, Some(4));
        assert_eq!(result.profile_id.as_deref(), Some("p1-embeddings"));

        let requests = transport.requests.lock().expect("lock");
        let body: Value =
            serde_json::from_str(requests[0].body.as_deref().expect("body")).expect("json");
        assert_eq!(body["embedding_model_dims"], json!(4));
        assert_eq!(body["embedder"]["config"]["embedding_dims"], json!(4));
    }

    #[tokio::test]
    async fn the_embedder_sync_rejects_dims_above_the_hnsw_limit() {
        let hub = StubModelHub {
            pipeline: vec![entry(
                "a",
                "p1-embeddings",
                "openai",
                "text-embedding-3-large",
                1,
                PipelineStatus::Active,
            )],
            account: Some(account("openai", encrypted_secret("sk-embed"))),
            // The probe cannot measure the dims, so `measured ?? requested` keeps
            // the requested 3000 and the HNSW guard fires.
            dispatch: Ok(json!({})),
        };
        let transport = StubTransport::new(vec![]);
        let result = sync_mem0_embedder_from_model_hub(
            &env(&[
                ("MEM0_BASE_URL", "https://mem0"),
                ("MEM0_API_KEY", "kc"),
                ("MEM0_VECTOR_HNSW", "1"),
                ("MEM0_EMBEDDING_DIMS", "3000"),
            ]),
            &hub,
            KEY,
            transport.as_ref(),
        )
        .await
        .expect("ok");
        assert!(!result.ok);
        assert_eq!(result.embedding_dims, Some(3000));
        assert!(result
            .error
            .as_deref()
            .expect("error")
            .contains("exceeds Mem0 pgvector/hnsw limit (2000)"));
        assert!(transport.requests.lock().expect("lock").is_empty());
    }
}
