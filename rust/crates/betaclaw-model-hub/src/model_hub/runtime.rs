//! Port of `src/server/model-hub/runtime.ts` (1-151).
//!
//! Three responsibilities:
//!
//! - [`get_model_hub_encryption_key`] (`runtime.ts:110-130`) resolves the AES key
//!   and refuses the public example key outside tests.
//! - [`get_model_hub_service`] (`runtime.ts:139-151`) is the real wiring. The
//!   process-wide singleton of `runtime.ts:132-137` cannot exist in Rust without
//!   an unsafe global, so the caller (the gateway's `AppState`) owns the
//!   repository and the [`ServiceDependencies`]; `get_model_hub_service` is the
//!   one-liner that composes them, mirroring `new ModelHubService(repository)`.
//! - [`build_test_mode_service`] (`runtime.ts:43-108`) is the `MODEL_HUB_TEST_MODE=1`
//!   fake used by the E2E lane: no network, a canned `multi_tool_use_parallel`
//!   tool call for `parallel-check` and a two-delta stream.
//!
//! `isModelHubTestMode` (`runtime.ts:11-13`) is [`is_model_hub_test_mode`].

use std::time::Duration;

use serde_json::json;

use crate::model_hub::crypto::normalize_key;
use crate::model_hub::env::EnvOverrides;
use crate::model_hub::http::AbortSignal;
use crate::model_hub::openai_compatible::StreamDeltaCallback;
use crate::model_hub::repository::ModelHubRepository;
use crate::model_hub::service::types::DispatchWithFallbackOptions;
use crate::model_hub::service::{ModelHubService, ServiceDependencies};
use crate::model_hub::types::{GatewayFunctionCall, GatewayRequest, GatewayResponse, GatewayRole};

/// `'test-only-encryption-key-32bytes'` from `runtime.ts:126`.
pub const TEST_MODE_ENCRYPTION_KEY: &str = "test-only-encryption-key-32bytes";

/// `Buffer.from('0123456789abcdef0123456789abcdef')` from `runtime.ts:116`.
const PUBLIC_EXAMPLE_KEY: &[u8; 32] = b"0123456789abcdef0123456789abcdef";

/// The 25 ms step of `delayWithAbort` (`runtime.ts:22`).
const DELAY_STEP_MS: u64 = 25;

/// Failure of [`get_model_hub_encryption_key`] and of the test-mode dispatch.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RuntimeError {
    /// `runtime.ts:118-120`.
    #[error("Public example MODEL_HUB_ENCRYPTION_KEY is unsafe; rotate existing secrets.")]
    PublicExampleKey,
    /// `runtime.ts:129`.
    #[error("Missing MODEL_HUB_ENCRYPTION_KEY")]
    MissingKey,
    /// `normalizeKey` rejected the configured key (`crypto.ts:19`).
    #[error("Encryption key must be 32 UTF-8 bytes or 64 hex chars.")]
    InvalidKey,
    /// `createAbortError` (`runtime.ts:15-19`).
    #[error("Aborted")]
    Aborted,
}

/// `NODE_ENV === 'test'`.
fn is_test_node_env(env: &EnvOverrides) -> bool {
    env.get("NODE_ENV").as_deref() == Some("test")
}

/// `isModelHubTestMode` from `runtime.ts:11-13`.
///
/// `String(process.env.MODEL_HUB_TEST_MODE || '').trim() === '1'` — an absent
/// variable, an empty string and `'0'` all report `false`.
pub fn is_model_hub_test_mode(env: &EnvOverrides) -> bool {
    env.get("MODEL_HUB_TEST_MODE")
        .map(|value| value.trim() == "1")
        .unwrap_or(false)
}

/// `getModelHubEncryptionKey` from `runtime.ts:110-130`.
///
/// In order: a configured key wins (after the public-example guard, which is
/// skipped only when `NODE_ENV === 'test'`); otherwise the test-only key is
/// returned in a test environment; otherwise the missing-key error.
pub fn get_model_hub_encryption_key(env: &EnvOverrides) -> Result<String, RuntimeError> {
    if let Some(key) = env
        .get("MODEL_HUB_ENCRYPTION_KEY")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        let bytes = normalize_key(&key).map_err(|_| RuntimeError::InvalidKey)?;
        if !is_test_node_env(env) && &bytes == PUBLIC_EXAMPLE_KEY {
            return Err(RuntimeError::PublicExampleKey);
        }
        return Ok(key);
    }

    if is_test_node_env(env) {
        return Ok(TEST_MODE_ENCRYPTION_KEY.to_string());
    }

    Err(RuntimeError::MissingKey)
}

/// `getModelHubService` from `runtime.ts:139-151` — the real branch.
///
/// The repository and the dependencies are the caller's; the Rust port has no
/// process-wide mutable singleton, so the returned [`ModelHubService`] borrows
/// them for as long as the caller needs it.
pub fn get_model_hub_service<'a>(
    repository: &'a dyn ModelHubRepository,
    dependencies: ServiceDependencies<'a>,
) -> ModelHubService<'a> {
    ModelHubService::new(repository, dependencies)
}

/// `delayWithAbort` from `runtime.ts:21-30`.
async fn delay_with_abort(ms: u64, signal: Option<&AbortSignal>) -> Result<(), RuntimeError> {
    let max_iterations = ms.div_ceil(DELAY_STEP_MS);
    for _ in 0..max_iterations {
        if signal.is_some_and(AbortSignal::is_aborted) {
            return Err(RuntimeError::Aborted);
        }
        tokio::time::sleep(Duration::from_millis(DELAY_STEP_MS)).await;
    }
    Ok(())
}

/// `getLastUserMessage` from `runtime.ts:32-41`.
///
/// `entry.content` is always a string in [`GatewayRequest`], so only the role
/// test matters.
fn get_last_user_message(request: &GatewayRequest) -> String {
    request
        .messages
        .iter()
        .rev()
        .find(|entry| entry.role == GatewayRole::User)
        .map(|entry| entry.content.clone())
        .unwrap_or_default()
}

/// `buildTestModeService` from `runtime.ts:43-108`.
///
/// The fake shares no code with the real dispatch path: it answers from the last
/// user message and never touches a repository or a socket.
#[derive(Debug, Clone, Copy, Default)]
pub struct TestModeService;

/// `build_test_mode_service()` — the `MODEL_HUB_TEST_MODE=1` singleton.
pub fn build_test_mode_service() -> TestModeService {
    TestModeService
}

impl TestModeService {
    /// `runtime.dispatchWithFallback` from `runtime.ts:45-104`.
    pub async fn dispatch_with_fallback(
        &self,
        profile_id: &str,
        request: &GatewayRequest,
        options: Option<&DispatchWithFallbackOptions>,
    ) -> Result<GatewayResponse, RuntimeError> {
        let signal = options.and_then(|options| options.abort.clone());
        let model_override = options.and_then(|options| options.model_override.clone());
        let on_stream_delta: Option<StreamDeltaCallback> =
            options.and_then(|options| options.on_stream_delta.clone());

        if signal.as_ref().is_some_and(AbortSignal::is_aborted) {
            return Err(RuntimeError::Aborted);
        }

        let last_user_message = get_last_user_message(request);
        let has_parallel_tool_result = last_user_message
            .contains("Tool \"multi_tool_use_parallel\"")
            || last_user_message.contains("Tool \"multi_tool_use.parallel\"");

        let model = model_override.unwrap_or_else(|| "test-mode-model".to_string());

        if last_user_message.contains("parallel-check") && !has_parallel_tool_result {
            return Ok(GatewayResponse {
                ok: true,
                text: String::new(),
                model,
                provider: "test-mode".to_string(),
                usage: None,
                function_calls: Some(vec![GatewayFunctionCall {
                    name: "multi_tool_use_parallel".to_string(),
                    args: Some(json!({
                        "tool_uses": [{
                            "recipient_name": "functions.shell_execute",
                            "parameters": { "command": "echo parallel-nexus" },
                        }],
                    })),
                }]),
                rate_limits: None,
                error: None,
            });
        }

        if last_user_message.contains("E2E_ABORT_WAIT") {
            delay_with_abort(5_000, signal.as_ref()).await?;
        }

        if let Some(on_stream_delta) = &on_stream_delta {
            on_stream_delta("fixture ");
            delay_with_abort(40, signal.as_ref()).await?;
            on_stream_delta("response");
        }

        let text = if has_parallel_tool_result {
            "[test-mode] parallel flow complete".to_string()
        } else if last_user_message.is_empty() {
            format!("[test-mode:{profile_id}] ok")
        } else {
            format!("[test-mode:{profile_id}] {last_user_message}")
        };

        Ok(GatewayResponse {
            ok: true,
            text,
            model,
            provider: "test-mode".to_string(),
            usage: None,
            function_calls: None,
            rate_limits: None,
            error: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::model_hub::types::GatewayMessage;

    /// `runtime.ts:11-13`: only a trimmed `'1'` enables test mode.
    #[test]
    fn test_mode_is_only_the_trimmed_one() {
        assert!(is_model_hub_test_mode(
            &EnvOverrides::new().with("MODEL_HUB_TEST_MODE", "1")
        ));
        assert!(is_model_hub_test_mode(
            &EnvOverrides::new().with("MODEL_HUB_TEST_MODE", "  1  ")
        ));
        assert!(!is_model_hub_test_mode(&EnvOverrides::new()));
        assert!(!is_model_hub_test_mode(
            &EnvOverrides::new().with("MODEL_HUB_TEST_MODE", "0")
        ));
    }

    /// `runtime.ts:111-123`: a configured key is returned trimmed, and the public
    /// example key is rejected outside tests.
    #[test]
    fn the_configured_key_is_returned_and_the_example_key_is_rejected() {
        let key = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
        let env = EnvOverrides::new().with("MODEL_HUB_ENCRYPTION_KEY", key);
        assert_eq!(get_model_hub_encryption_key(&env).expect("key"), key);

        let example = EnvOverrides::new().with(
            "MODEL_HUB_ENCRYPTION_KEY",
            "00000000000000000000000000000000000000000000000000000000000000ff",
        );
        assert!(get_model_hub_encryption_key(&example).is_ok());

        let public = EnvOverrides::new().with(
            "MODEL_HUB_ENCRYPTION_KEY",
            "0123456789abcdef0123456789abcdef",
        );
        assert_eq!(
            get_model_hub_encryption_key(&public),
            Err(RuntimeError::PublicExampleKey)
        );
        // In test mode the guard is skipped.
        let public_test = public.with("NODE_ENV", "test");
        assert_eq!(
            get_model_hub_encryption_key(&public_test).expect("allowed in test"),
            "0123456789abcdef0123456789abcdef"
        );
    }

    /// `runtime.ts:125-129`: the test key and the missing-key error.
    #[test]
    fn the_test_key_and_missing_key_paths() {
        assert_eq!(
            get_model_hub_encryption_key(&EnvOverrides::new().with("NODE_ENV", "test"))
                .expect("test key"),
            TEST_MODE_ENCRYPTION_KEY
        );
        assert_eq!(
            get_model_hub_encryption_key(&EnvOverrides::new()),
            Err(RuntimeError::MissingKey)
        );
        assert_eq!(
            get_model_hub_encryption_key(
                &EnvOverrides::new().with("MODEL_HUB_ENCRYPTION_KEY", "too-short")
            ),
            Err(RuntimeError::InvalidKey)
        );
    }

    /// `runtime.ts:64-84`: a `parallel-check` prompt answers with the canned
    /// `multi_tool_use_parallel` tool call and carries the model override.
    #[tokio::test]
    async fn the_test_mode_service_returns_the_parallel_tool_call() {
        let service = build_test_mode_service();
        let request = GatewayRequest::new("ignored", vec![GatewayMessage::user("parallel-check")]);
        let options = DispatchWithFallbackOptions::with_model_override("test-mode-model-override");

        let response = service
            .dispatch_with_fallback("p1", &request, Some(&options))
            .await
            .expect("dispatch");

        assert!(response.ok);
        assert_eq!(response.provider, "test-mode");
        assert_eq!(response.model, "test-mode-model-override");
        assert!(response.text.is_empty());
        let calls = response.function_calls.expect("tool call");
        assert_eq!(calls[0].name, "multi_tool_use_parallel");
    }

    /// `runtime.ts:96-103`: the default reply echoes the last user message and the
    /// profile id.
    #[tokio::test]
    async fn the_test_mode_service_echoes_the_last_user_message() {
        let service = build_test_mode_service();
        let request = GatewayRequest::new(
            "ignored",
            vec![GatewayMessage::user("hello"), GatewayMessage::user("final")],
        );
        let response = service
            .dispatch_with_fallback("p1", &request, None)
            .await
            .expect("dispatch");
        assert_eq!(response.text, "[test-mode:p1] final");
        assert_eq!(response.model, "test-mode-model");
    }

    /// `runtime.ts:90-94`: `onStreamDelta` sees `fixture ` then `response`.
    #[tokio::test]
    async fn the_test_mode_service_streams_two_deltas() {
        let service = build_test_mode_service();
        let deltas = Arc::new(std::sync::Mutex::new(String::new()));
        let sink = deltas.clone();
        let options = DispatchWithFallbackOptions {
            on_stream_delta: Some(Arc::new(move |delta: &str| {
                sink.lock().expect("lock").push_str(delta);
            })),
            ..DispatchWithFallbackOptions::default()
        };

        let request = GatewayRequest::new("ignored", vec![GatewayMessage::user("x")]);
        service
            .dispatch_with_fallback("p1", &request, Some(&options))
            .await
            .expect("dispatch");
        assert_eq!(*deltas.lock().expect("lock"), "fixture response");
    }

    /// `runtime.ts:55-57`: an already-aborted signal throws `AbortError`.
    #[tokio::test]
    async fn an_aborted_signal_aborts_the_test_mode_service() {
        let service = build_test_mode_service();
        let signal = AbortSignal::new();
        signal.abort();
        let options = DispatchWithFallbackOptions {
            abort: Some(signal),
            ..DispatchWithFallbackOptions::default()
        };

        let request = GatewayRequest::new("ignored", vec![GatewayMessage::user("x")]);
        assert_eq!(
            service
                .dispatch_with_fallback("p1", &request, Some(&options))
                .await,
            Err(RuntimeError::Aborted)
        );
    }
}
