//! Port of `src/server/channels/pairing/bridge.ts` (WhatsApp and iMessage
//! bridges): health probe, webhook registration and the pairing itself.
//!
//! The bridge is trusted local infrastructure. Its webhook secret is sent to it
//! in the request body and in a header, as in the source. The secret is never
//! written to a log line.

use chrono::Utc;
use http::Method;
use serde_json::{json, Value};
use tracing::warn;

use super::bridge_accounts::{
    normalize_bridge_account_id, resolve_bridge_account_secret, upsert_bridge_account,
    BridgeAccountUpsert, BridgeChannel,
};
use super::credentials::{ChannelCredentialStore, ChannelEnv};
use super::{app_url, random_hex, trim_one_slash, PairingOutcome};
use crate::channels::adapters::types::{non_empty, response_json, ChannelError};
use crate::model_hub::http::{fetch_with_timeout, HttpRequest, HttpTransport};

/// `probeBridgeHealth` result.
#[derive(Debug, Clone, PartialEq)]
pub struct BridgeHealth {
    pub ok: bool,
    pub status: u16,
    pub peer_name: Option<String>,
    pub details: Option<Value>,
}

/// `registerBridgeWebhook` result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebhookRegistration {
    pub ok: bool,
    pub callback_url: Option<String>,
}

/// `resolveBridgeUrl`: the bridge base URL without a trailing slash.
pub fn resolve_bridge_url(
    env: &ChannelEnv,
    channel: BridgeChannel,
) -> Result<String, ChannelError> {
    let name = channel.bridge_url_env();
    let url = non_empty(env.get(name))
        .ok_or_else(|| ChannelError::new(format!("{name} is not configured.")))?;
    Ok(trim_one_slash(&url).to_string())
}

/// `probeBridgeHealth`: `GET <bridge>/health`.
pub async fn probe_bridge_health(
    transport: &dyn HttpTransport,
    env: &ChannelEnv,
    channel: BridgeChannel,
) -> Result<BridgeHealth, ChannelError> {
    let base = resolve_bridge_url(env, channel)?;
    let response =
        fetch_with_timeout(transport, HttpRequest::get(format!("{base}/health"))).await?;
    if !response.is_ok() {
        return Ok(BridgeHealth {
            ok: false,
            status: response.status.as_u16(),
            peer_name: None,
            details: None,
        });
    }

    let payload = response_json(&response);
    Ok(BridgeHealth {
        ok: true,
        status: response.status.as_u16(),
        peer_name: payload
            .get("peerName")
            .and_then(Value::as_str)
            .map(str::to_string),
        details: Some(payload),
    })
}

/// `registerBridgeWebhook`. A missing app URL or a failed registration is not an
/// error: the result says `ok: false`, as in the source.
pub async fn register_bridge_webhook(
    transport: &dyn HttpTransport,
    store: &dyn ChannelCredentialStore,
    env: &ChannelEnv,
    channel: BridgeChannel,
    account_id: Option<&str>,
    webhook_secret: Option<&str>,
) -> Result<WebhookRegistration, ChannelError> {
    let account_id = normalize_bridge_account_id(account_id)?;
    let base = resolve_bridge_url(env, channel)?;
    let Some(app) = app_url(env) else {
        warn!("APP_URL not set - bridge webhook not registered.");
        return Ok(WebhookRegistration {
            ok: false,
            callback_url: None,
        });
    };

    let callback_url = format!(
        "{}/api/channels/{}/webhook?accountId={}",
        trim_one_slash(&app),
        channel.as_str(),
        account_id
    );
    let secret = match webhook_secret.filter(|secret| !secret.is_empty()) {
        Some(secret) => secret.to_string(),
        None => resolve_bridge_account_secret(store, env, channel, Some(account_id.as_str()))?,
    };

    let body = json!({
        "callbackUrl": callback_url,
        "accountId": account_id,
        "secret": secret,
        "headers": {
            "x-webhook-secret": secret,
            "x-betaclaw-account-id": account_id,
        },
    });
    let request = HttpRequest::post(format!("{base}/webhook"))
        .header("Content-Type", "application/json")
        .json_body(&body);

    match fetch_with_timeout(transport, request).await {
        Ok(response) if response.is_ok() => Ok(WebhookRegistration {
            ok: true,
            callback_url: Some(callback_url),
        }),
        Ok(response) => {
            warn!(
                "{} webhook registration failed with status {}.",
                channel.as_str(),
                response.status.as_u16()
            );
            Ok(WebhookRegistration {
                ok: false,
                callback_url: Some(callback_url),
            })
        }
        Err(error) => {
            warn!(
                "{} webhook registration warning: {}",
                channel.as_str(),
                error
            );
            Ok(WebhookRegistration {
                ok: false,
                callback_url: Some(callback_url),
            })
        }
    }
}

/// `pairBridgeChannel`: probes the bridge, registers the webhook with a fresh
/// secret and records the account as connected.
pub async fn pair_bridge_channel(
    transport: &dyn HttpTransport,
    store: &dyn ChannelCredentialStore,
    env: &ChannelEnv,
    channel: BridgeChannel,
    account_id_input: Option<&str>,
) -> Result<PairingOutcome, ChannelError> {
    let account_id = normalize_bridge_account_id(account_id_input)?;
    let health = probe_bridge_health(transport, env, channel).await?;
    if !health.ok {
        return Err(ChannelError::new(format!(
            "{} bridge health check failed with {}.",
            channel.as_str(),
            health.status
        )));
    }

    let webhook_secret = random_hex(32)?;
    register_bridge_webhook(
        transport,
        store,
        env,
        channel,
        Some(account_id.as_str()),
        Some(webhook_secret.as_str()),
    )
    .await?;

    let peer_name = non_empty(health.peer_name.clone())
        .unwrap_or_else(|| format!("{}-bridge", channel.as_str()));
    let upsert = BridgeAccountUpsert {
        account_id: Some(account_id.clone()),
        pairing_status: Some("connected".to_string()),
        webhook_secret: Some(webhook_secret),
        peer_name: Some(peer_name.clone()),
        touch_last_seen: true,
    };
    if let Err(error) = upsert_bridge_account(store, channel, &upsert, Utc::now()) {
        warn!(
            "{} pairing status persistence warning: {}",
            channel.as_str(),
            error
        );
    }

    Ok(PairingOutcome {
        status: None,
        transport: None,
        account_id: Some(account_id),
        peer_name,
        details: health.details.unwrap_or_else(|| json!({})),
    })
}

/// `DELETE <bridge>/webhook?accountId=...`, the deregistration of `unpairBridge`.
pub async fn deregister_bridge_webhook(
    transport: &dyn HttpTransport,
    store: &dyn ChannelCredentialStore,
    env: &ChannelEnv,
    channel: BridgeChannel,
    base: &str,
    account_id: &str,
) -> Result<(), ChannelError> {
    let secret = resolve_bridge_account_secret(store, env, channel, Some(account_id))?;
    let url = format!("{base}/webhook?accountId={account_id}");
    let mut request = HttpRequest::new(Method::DELETE, url);
    if !secret.is_empty() {
        request = request.header("x-webhook-secret", &secret);
    }
    fetch_with_timeout(transport, request).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channels::pairing::test_support::{
        isolated_env, json_response, memory_store, ScriptedTransport,
    };

    #[test]
    fn the_bridge_url_loses_one_trailing_slash_and_must_be_set() {
        let env = isolated_env();
        assert_eq!(
            resolve_bridge_url(&env, BridgeChannel::WhatsApp)
                .unwrap_err()
                .0,
            "WHATSAPP_BRIDGE_URL is not configured."
        );
        env.set("WHATSAPP_BRIDGE_URL", "http://bridge.test/");
        assert_eq!(
            resolve_bridge_url(&env, BridgeChannel::WhatsApp).unwrap(),
            "http://bridge.test"
        );
    }

    #[tokio::test]
    async fn pairing_registers_the_webhook_and_records_the_account() {
        let transport = ScriptedTransport::new();
        transport.then(
            "/health",
            json_response(200, json!({"peerName": "wa-phone"})),
        );
        transport.then("/webhook", json_response(200, json!({})));
        let store = memory_store();
        let env = isolated_env();
        env.set("WHATSAPP_BRIDGE_URL", "http://bridge.test");
        env.set("APP_URL", "https://app.test/");

        let outcome = pair_bridge_channel(
            transport.as_ref(),
            store.as_ref(),
            &env,
            BridgeChannel::WhatsApp,
            None,
        )
        .await
        .expect("paired");

        assert_eq!(outcome.account_id.as_deref(), Some("default"));
        assert_eq!(outcome.peer_name, "wa-phone");
        assert_eq!(
            store
                .get_credential("whatsapp", "pairing_status")
                .as_deref(),
            Some("connected")
        );
        let registration = ScriptedTransport::body_of(&transport.calls("/webhook")[0]);
        assert_eq!(
            registration["callbackUrl"],
            "https://app.test/api/channels/whatsapp/webhook?accountId=default"
        );
        assert_eq!(registration["headers"]["x-betaclaw-account-id"], "default");
    }

    #[tokio::test]
    async fn a_failing_health_check_stops_the_pairing() {
        let transport = ScriptedTransport::new();
        transport.then("/health", json_response(503, json!({})));
        let store = memory_store();
        let env = isolated_env();
        env.set("IMESSAGE_BRIDGE_URL", "http://bridge.test");

        let error = pair_bridge_channel(
            transport.as_ref(),
            store.as_ref(),
            &env,
            BridgeChannel::IMessage,
            None,
        )
        .await
        .expect_err("health failed");

        assert_eq!(error.0, "imessage bridge health check failed with 503.");
        assert!(transport.calls("/webhook").is_empty());
    }

    #[tokio::test]
    async fn a_missing_app_url_skips_the_registration_without_failing() {
        let transport = ScriptedTransport::new();
        let store = memory_store();
        let env = isolated_env();
        env.set("WHATSAPP_BRIDGE_URL", "http://bridge.test");

        let registration = register_bridge_webhook(
            transport.as_ref(),
            store.as_ref(),
            &env,
            BridgeChannel::WhatsApp,
            None,
            Some("s"),
        )
        .await
        .expect("not an error");

        assert_eq!(
            registration,
            WebhookRegistration {
                ok: false,
                callback_url: None
            }
        );
        assert!(transport.requests().is_empty());
    }
}
