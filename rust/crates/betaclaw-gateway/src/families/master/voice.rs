//! Port of `app/api/master/voice-session/route.ts` (GET). The route reads the first
//! xAI account of the Model Hub, decrypts its key and asks the xAI realtime endpoint
//! for a short-lived client secret through `fetchWithPolicy`.
//!
//! Identity is checked first, because the source wraps this route in
//! `withUserContext`. The key lookup comes before the account lookup, so a missing
//! encryption key is a `500` even when no xAI account exists, as in the source.

use std::sync::Arc;

use axum::extract::Extension;
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::IntoResponse;
use axum::Json;
use betaclaw_core::model_hub::crypto::decrypt_secret;
use betaclaw_core::model_hub::env::EnvOverrides;
use betaclaw_core::model_hub::http::HttpRequest;
use betaclaw_core::model_hub::repository::ModelHubRepository;
use betaclaw_core::model_hub::runtime::get_model_hub_encryption_key;
use betaclaw_core::model_hub::sqlite::SqliteModelHubRepository;
use betaclaw_core::net_guard::fetch_with_policy::{fetch_with_policy, FetchPolicy};
use chrono::Utc;
use serde_json::{json, Value};

use super::support::{query_of, server_error, user_or_401, ApiError, Reply};
use super::Services;

/// `VALID_VOICES` of the source, and the `'Ara'` default.
const VOICES: [&str; 5] = ["Ara", "Rex", "Sal", "Eve", "Leo"];
const DEFAULT_VOICE: &str = "Ara";
const XAI_PROVIDER: &str = "xai";
const XAI_REALTIME_SECRETS_URL: &str = "https://api.x.ai/v1/realtime/client_secrets";
/// `expires_after.seconds` of the request, and the fallback expiry in seconds.
const TOKEN_TTL_SECONDS: i64 = 300;

/// `GET /api/master/voice-session` (`voice-session/route.ts:13-94`).
pub(super) async fn session(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    uri: Uri,
) -> Reply {
    user_or_401(&headers)?;
    let api_key = xai_api_key(&services.model_hub_db_path)?;
    let query = query_of(&uri);
    let voice = query
        .get("voice")
        .filter(|value| VOICES.contains(&value.as_str()))
        .unwrap_or_else(|| DEFAULT_VOICE.to_string());

    let request = HttpRequest::post(XAI_REALTIME_SECRETS_URL)
        .header("Authorization", &format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .json_body(&json!({ "expires_after": { "seconds": TOKEN_TTL_SECONDS } }));
    let policy = FetchPolicy {
        retries: 1,
        ..FetchPolicy::default()
    };
    let response = fetch_with_policy(services.transport.as_ref(), request, &policy)
        .await
        .map_err(|error| ApiError::new(StatusCode::BAD_GATEWAY, error))?;
    if !response.status.is_success() {
        return Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            format!(
                "xAI returned {}: {}",
                response.status.as_u16(),
                response.body
            ),
        ));
    }
    let data: Value = serde_json::from_str(&response.body)
        .map_err(|error| ApiError::new(StatusCode::BAD_GATEWAY, error))?;

    // The token sits under `client_secret.value`, or at the top level as `token` or `value`.
    let secret = data.get("client_secret").filter(|value| !value.is_null());
    let token = secret
        .and_then(|value| value.get("value"))
        .and_then(Value::as_str)
        .or_else(|| data.get("token").and_then(Value::as_str))
        .or_else(|| data.get("value").and_then(Value::as_str))
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::BAD_GATEWAY,
                "Unexpected response shape from xAI token endpoint",
            )
        })?;
    let expires_at = secret
        .and_then(|value| value.get("expires_at"))
        .filter(|value| !value.is_null())
        .or_else(|| data.get("expires_at").filter(|value| !value.is_null()))
        .cloned()
        .unwrap_or_else(|| json!(Utc::now().timestamp() + TOKEN_TTL_SECONDS));

    Ok(Json(json!({
        "ok": true,
        "token": token,
        "voice": voice,
        "expiresAt": expires_at,
    }))
    .into_response())
}

/// The first xAI account's secret, decrypted (`route.ts:15-37` and `:65-70`).
///
/// Runs synchronously so no SQLite handle is held across the network call.
fn xai_api_key(db_path: &str) -> Result<String, ApiError> {
    let repository = SqliteModelHubRepository::open(db_path).map_err(server_error)?;
    let key = get_model_hub_encryption_key(&EnvOverrides::new()).map_err(server_error)?;
    let accounts = repository.list_accounts().map_err(server_error)?;
    let mut record = None;
    for account in accounts
        .iter()
        .filter(|account| account.provider_id == XAI_PROVIDER)
    {
        if let Some(found) = repository
            .get_account_record_by_id(&account.id)
            .map_err(server_error)?
        {
            record = Some(found);
            break;
        }
    }
    let record = record.ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "No xAI account configured in Model Hub",
        )
    })?;
    decrypt_secret(&record.encrypted_secret_payload(), &key).map_err(server_error)
}

#[cfg(test)]
mod tests {
    use axum::http::{Method, StatusCode};

    use crate::families::master::test_support::Harness;

    #[tokio::test]
    async fn voice_session_requires_a_user() {
        let harness = Harness::new();
        let (status, body) = harness
            .send(Method::GET, "/api/master/voice-session", None, None)
            .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["ok"], false);
        assert_eq!(body["error"], "Unauthorized");
    }
}
