//! Port of `src/server/memory/runtime.ts:1-278` — provider selection, the
//! readiness probe and the degraded-runtime recovery.
//!
//! | TypeScript                                          | Rust |
//! | --------------------------------------------------- | ---- |
//! | `runtime.ts:18-22` (constants)                       | the `pub const`s below |
//! | `runtime.ts:24-34` (`configuredProvider`)            | [`configured_provider`] |
//! | `runtime.ts:36-42` (`isProductionEnv`)               | [`is_production_env`] |
//! | `runtime.ts:44-46` (`sleep`)                         | the caller's timer (see deviation 2) |
//! | `runtime.ts:48-57` (`setMemoryRuntimeReadyState`)    | [`MemoryRuntime::set_ready_state`] |
//! | `runtime.ts:59-76` (`schedule…RecoveryProbe`)        | [`MemoryRuntime::schedule_recovery_probe`] |
//! | `runtime.ts:78-110` (`assert…Configuration`)         | [`assert_memory_runtime_configuration`] |
//! | `runtime.ts:112-124` (`resolveMemoryClient`)         | [`MemoryClientFactory`], [`MemoryRuntime::from_env`] |
//! | `runtime.ts:126-131` (`MemoryRuntimeUnavailableError`)| [`MemoryRuntimeUnavailableError`] |
//! | `runtime.ts:133-141` (`getRequiredMemoryClient`)     | [`MemoryRuntime::required_client`] |
//! | `runtime.ts:143-152` (`getMemoryService`)            | [`MemoryRuntime::memory_service`] |
//! | `runtime.ts:154-158` (`getMemoryRuntimeReadyState`)  | [`MemoryRuntime::ready_state`] |
//! | `runtime.ts:160-166` (`getMemoryServiceIfReady`)     | [`MemoryRuntime::memory_service_if_ready`] |
//! | `runtime.ts:168-170` (`getMemoryProviderKind`)       | [`MemoryRuntime::provider_kind`] |
//! | `runtime.ts:172-188` (`assertMemoryRuntimeReady`)    | [`MemoryRuntime::assert_ready`] |
//! | `runtime.ts:190-245` (`ensure…ForStartup`)           | [`MemoryRuntime::ensure_ready_for_startup`] |
//! | `runtime.ts:247-249` (`…ReadyStateForTests`)         | [`MemoryRuntime::set_ready_state`] |
//! | `runtime.ts:251-278` (`recoverMemoryRuntimeNow`)     | [`MemoryRuntime::recover_now`] |
//!
//! # Deviations
//!
//! 1. **No process-wide singleton.** The TypeScript stores the client, the
//!    service and the ready flag on `globalThis`. The Rust port follows the
//!    Model Hub runtime (`model_hub/runtime.rs:97-107`): the caller owns a
//!    [`MemoryRuntime`] and passes it around, so two tests never share state.
//! 2. **The caller owns the timers.** `setTimeout(…).unref()` has no Rust
//!    equivalent in a library. [`MemoryRuntime::schedule_recovery_probe`]
//!    returns the delay the caller must wait before calling
//!    [`MemoryRuntime::recover_now`]; `ensure_ready_for_startup` does its own
//!    `tokio::time::sleep`.
//! 3. **The probe is synchronous.** Every [`Mem0Client`] method is synchronous
//!    in this slice, so the readiness probe does not need `async`; only the
//!    retry loop of `ensure_ready_for_startup` awaits its delay.

use std::collections::HashMap;

use crate::memory::service::{MemoryService, MemoryServiceDependencies};
use crate::memory::types::{Mem0Client, Mem0ListInput, MemoryProviderKind};
use crate::world_model::config::resolve_world_model_config;

/// `MEMORY_RUNTIME_PROBE_USER_ID` — `runtime.ts:18`.
pub const MEMORY_RUNTIME_PROBE_USER_ID: &str = "memory-runtime-probe";
/// `MEMORY_RUNTIME_PROBE_PERSONA_ID` — `runtime.ts:19`.
pub const MEMORY_RUNTIME_PROBE_PERSONA_ID: &str = "memory-runtime-probe";
/// `DEFAULT_STARTUP_RETRY_DELAY_MS` — `runtime.ts:20`.
pub const DEFAULT_STARTUP_RETRY_DELAY_MS: u64 = 1_500;
/// `DEFAULT_RECOVERY_RETRY_DELAY_MS` — `runtime.ts:21`.
pub const DEFAULT_RECOVERY_RETRY_DELAY_MS: u64 = 5_000;
/// `MAX_RECOVERY_RETRY_DELAY_MS` — `runtime.ts:22`.
pub const MAX_RECOVERY_RETRY_DELAY_MS: u64 = 60_000;

/// `EnvLike` — `runtime.ts:17`.
pub type EnvLike = HashMap<String, String>;

/// `configuredProvider`'s return type — `runtime.ts:24`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfiguredProvider {
    Postgres,
    Mem0,
    Sqlite,
}

impl ConfiguredProvider {
    /// The `MemoryProviderKind` a client of this provider declares.
    pub fn provider_kind(self) -> MemoryProviderKind {
        match self {
            ConfiguredProvider::Postgres => MemoryProviderKind::Postgres,
            ConfiguredProvider::Mem0 => MemoryProviderKind::Mem0,
            ConfiguredProvider::Sqlite => MemoryProviderKind::Sqlite,
        }
    }
}

/// `String(env.NAME || '')` — `runtime.ts:25`.
fn env_value(env: &EnvLike, name: &str) -> String {
    env.get(name).cloned().unwrap_or_default()
}

/// `configuredProvider` from `runtime.ts:24-34`.
pub fn configured_provider(env: &EnvLike) -> ConfiguredProvider {
    let explicit = env_value(env, "MEMORY_PROVIDER").trim().to_lowercase();
    match explicit.as_str() {
        "postgres" | "world-model" | "world_model" => return ConfiguredProvider::Postgres,
        "sqlite" => return ConfiguredProvider::Sqlite,
        "mem0" => return ConfiguredProvider::Mem0,
        _ => {}
    }
    if resolve_world_model_config(env).mode.is_canonical() {
        ConfiguredProvider::Postgres
    } else {
        ConfiguredProvider::Mem0
    }
}

/// `isProductionEnv` from `runtime.ts:36-42`.
pub fn is_production_env(env: &EnvLike) -> bool {
    env_value(env, "NODE_ENV").trim().to_lowercase() == "production"
}

/// `assertMemoryRuntimeConfiguration` from `runtime.ts:78-110`.
///
/// The four error texts are reproduced verbatim; a non-production environment
/// always passes.
pub fn assert_memory_runtime_configuration(env: &EnvLike) -> Result<(), MemoryRuntimeError> {
    if !is_production_env(env) {
        return Ok(());
    }

    match configured_provider(env) {
        ConfiguredProvider::Postgres => {
            let world_model = resolve_world_model_config(env);
            if !world_model.enabled || !world_model.mode.is_canonical() {
                return Err(MemoryRuntimeError::Configuration(
                    "Invalid memory configuration: MEMORY_PROVIDER=postgres requires WORLD_MODEL_MODE=canonical and an enabled World Model."
                        .to_string(),
                ));
            }
            Ok(())
        }
        ConfiguredProvider::Sqlite => Err(MemoryRuntimeError::Configuration(
            "Invalid memory configuration: production requires MEMORY_PROVIDER=postgres (canonical) or explicit MEMORY_PROVIDER=mem0 (legacy)."
                .to_string(),
        )),
        ConfiguredProvider::Mem0 => {
            if env_value(env, "MEM0_BASE_URL").trim().is_empty() {
                return Err(MemoryRuntimeError::Configuration(
                    "Invalid memory configuration: MEM0_BASE_URL is required when MEMORY_PROVIDER=mem0."
                        .to_string(),
                ));
            }
            if env_value(env, "MEM0_API_KEY").trim().is_empty() {
                return Err(MemoryRuntimeError::Configuration(
                    "Invalid memory configuration: MEM0_API_KEY is required when MEMORY_PROVIDER=mem0."
                        .to_string(),
                ));
            }
            Ok(())
        }
    }
}

/// `MemoryRuntimeUnavailableError` from `runtime.ts:126-131`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryRuntimeUnavailableError {
    pub message: String,
}

impl MemoryRuntimeUnavailableError {
    /// The constructor's default argument — `runtime.ts:127`.
    pub fn new() -> Self {
        Self {
            message: "Memory runtime unavailable: configured provider is not ready.".to_string(),
        }
    }
}

impl Default for MemoryRuntimeUnavailableError {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for MemoryRuntimeUnavailableError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for MemoryRuntimeUnavailableError {}

/// The two `throw new Error` shapes of `runtime.ts` plus the typed
/// `MemoryRuntimeUnavailableError`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum MemoryRuntimeError {
    /// Every `throw new Error(message)`, including the connectivity wrapper of
    /// `assertMemoryRuntimeReady`.
    #[error("{0}")]
    Configuration(String),

    /// `throw new MemoryRuntimeUnavailableError()` — `runtime.ts:146`.
    #[error(transparent)]
    Unavailable(MemoryRuntimeUnavailableError),
}

impl MemoryRuntimeError {
    /// `error instanceof Error ? error.message : String(error)` — the text a
    /// route handler forwards.
    pub fn message(&self) -> String {
        match self {
            MemoryRuntimeError::Configuration(message) => message.clone(),
            MemoryRuntimeError::Unavailable(error) => error.message.clone(),
        }
    }
}

/// The client constructor seam of `resolveMemoryClient` — `runtime.ts:112-124`.
///
/// The TypeScript constructs `PostgresMemoryClient`, `SqliteMemoryClient` or
/// `createMem0ClientFromEnv()` directly. Each of those needs a driver, a
/// database path or an HTTP transport, so the port injects the choice and keeps
/// the provider-selection logic here.
pub trait MemoryClientFactory {
    fn create(
        &self,
        provider: ConfiguredProvider,
        env: &EnvLike,
    ) -> Result<Box<dyn Mem0Client>, MemoryRuntimeError>;
}

/// The readiness probe input of `assertMemoryRuntimeReady` — `runtime.ts:175-180`.
fn probe_input() -> Mem0ListInput {
    Mem0ListInput {
        user_id: MEMORY_RUNTIME_PROBE_USER_ID.to_string(),
        persona_id: Some(MEMORY_RUNTIME_PROBE_PERSONA_ID.to_string()),
        workspace_id: None,
        page: 1,
        page_size: 1,
        query: None,
        node_type: None,
    }
}

/// `Math.min(MAX, DEFAULT * 2^attempt)` — `runtime.ts:64-67`.
///
/// `attempt` is clamped to `>= 0` first, exactly like
/// `Math.max(0, globalThis.__memoryRuntimeRecoveryAttempt || 0)`.
fn recovery_delay_ms(attempt: i64) -> u64 {
    let attempt = attempt.clamp(0, 31) as u32;
    let scaled = DEFAULT_RECOVERY_RETRY_DELAY_MS as u128 * (1u128 << attempt);
    scaled.min(MAX_RECOVERY_RETRY_DELAY_MS as u128) as u64
}

/// The process-wide state of `runtime.ts`'s `globalThis` bucket, owned by the
/// caller (deviation 1).
pub struct MemoryRuntime {
    provider: ConfiguredProvider,
    client: Option<Box<dyn Mem0Client>>,
    ready: Option<bool>,
    recovery_attempt: i64,
}

impl MemoryRuntime {
    /// The client `getRequiredMemoryClient` returns — `runtime.ts:116-121`.
    pub fn new(provider: ConfiguredProvider, client: Box<dyn Mem0Client>) -> Self {
        Self {
            provider,
            client: Some(client),
            ready: None,
            recovery_attempt: 0,
        }
    }

    /// The `globalThis.__mem0Client === null` branch — `runtime.ts:123`.
    pub fn without_client(provider: ConfiguredProvider) -> Self {
        Self {
            provider,
            client: None,
            ready: None,
            recovery_attempt: 0,
        }
    }

    /// `resolveMemoryClient` — `runtime.ts:112-124`.
    ///
    /// Asserts the configuration, resolves the provider and builds the client
    /// through the injected factory.
    pub fn from_env(
        env: &EnvLike,
        factory: &dyn MemoryClientFactory,
    ) -> Result<Self, MemoryRuntimeError> {
        assert_memory_runtime_configuration(env)?;
        let provider = configured_provider(env);
        let client = factory.create(provider, env)?;
        Ok(Self::new(provider, client))
    }

    /// The provider chosen at construction.
    pub fn provider(&self) -> ConfiguredProvider {
        self.provider
    }

    /// `globalThis.__memoryRuntimeReady` as a tri-state — `runtime.ts:154-158`.
    pub fn ready_state(&self) -> Option<bool> {
        self.ready
    }

    /// `setMemoryRuntimeReadyState` — `runtime.ts:48-57`.
    ///
    /// `true` or `undefined` clears the pending recovery: the timer and the
    /// attempt counter of the TypeScript become "no scheduled delay" and
    /// `recovery_attempt == 0` here.
    pub fn set_ready_state(&mut self, ready: Option<bool>) {
        self.ready = ready;
        if ready == Some(true) || ready.is_none() {
            self.recovery_attempt = 0;
        }
    }

    /// The attempt counter `globalThis.__memoryRuntimeRecoveryAttempt`.
    pub fn recovery_attempt(&self) -> i64 {
        self.recovery_attempt
    }

    /// `scheduleMemoryRuntimeRecoveryProbe` — `runtime.ts:59-76`.
    ///
    /// Returns the delay the caller must wait, or `None` when the runtime is not
    /// degraded (the TypeScript's early `return`). Each eligible call increments
    /// the attempt counter, so the next delay is longer.
    pub fn schedule_recovery_probe(&mut self) -> Option<u64> {
        if self.ready != Some(false) {
            return None;
        }
        let attempt = self.recovery_attempt.max(0);
        let delay = recovery_delay_ms(attempt);
        self.recovery_attempt = attempt + 1;
        Some(delay)
    }

    /// `getRequiredMemoryClient` — `runtime.ts:133-141`.
    pub fn required_client(&self) -> Result<&dyn Mem0Client, MemoryRuntimeError> {
        self.client.as_deref().ok_or_else(|| {
            MemoryRuntimeError::Configuration(
                "Invalid memory configuration: memory client unavailable. Set MEMORY_PROVIDER=postgres, mem0, or sqlite."
                    .to_string(),
            )
        })
    }
}
/// The service and readiness half of `runtime.ts:143-278`.
impl MemoryRuntime {
    /// `getMemoryService` — `runtime.ts:143-152`.
    ///
    /// The TypeScript caches the service on `globalThis`; [`MemoryService`] only
    /// holds references, so the port builds an equivalent value on each call.
    /// Unlike the source, this method does not schedule the recovery probe on the
    /// degraded path — the caller does it through
    /// [`Self::schedule_recovery_probe`] (deviation 2).
    pub fn memory_service<'a>(
        &'a self,
        dependencies: MemoryServiceDependencies<'a>,
    ) -> Result<MemoryService<'a>, MemoryRuntimeError> {
        if self.ready == Some(false) {
            return Err(MemoryRuntimeError::Unavailable(
                MemoryRuntimeUnavailableError::new(),
            ));
        }
        Ok(MemoryService::new(self.required_client()?, dependencies))
    }

    /// `getMemoryServiceIfReady` — `runtime.ts:160-166`.
    pub fn memory_service_if_ready<'a>(
        &'a self,
        dependencies: MemoryServiceDependencies<'a>,
    ) -> Result<Option<MemoryService<'a>>, MemoryRuntimeError> {
        if self.ready == Some(false) {
            return Ok(None);
        }
        Ok(Some(self.memory_service(dependencies)?))
    }

    /// `getMemoryProviderKind` — `runtime.ts:168-170`.
    ///
    /// `client.provider ?? 'mem0'`: a client that does not declare itself
    /// resolves to [`MemoryProviderKind::Mem0`].
    pub fn provider_kind(&self) -> Result<MemoryProviderKind, MemoryRuntimeError> {
        Ok(self.required_client()?.provider().unwrap_or_default())
    }

    /// `assertMemoryRuntimeReady` — `runtime.ts:172-188`.
    ///
    /// The probe lists one page for the fixed probe ids. A failure marks the
    /// runtime degraded, schedules the recovery probe and returns the wrapped
    /// error text.
    pub fn assert_ready(&mut self) -> Result<(), MemoryRuntimeError> {
        let probe = self.required_client()?.list_memories(&probe_input());
        match probe {
            Ok(_) => {
                self.set_ready_state(Some(true));
                Ok(())
            }
            Err(error) => {
                self.set_ready_state(Some(false));
                self.schedule_recovery_probe();
                Err(MemoryRuntimeError::Configuration(format!(
                    "Memory provider connectivity check failed: {error}"
                )))
            }
        }
    }

    /// `recoverMemoryRuntimeNow` — `runtime.ts:256-278`.
    ///
    /// A synchronous port of the in-flight deduplicated promise (deviation 3).
    pub fn recover_now(&mut self) -> bool {
        self.assert_ready().is_ok()
    }

    /// `ensureMemoryRuntimeReadyForStartup` — `runtime.ts:190-245`.
    ///
    /// `retries` and `retry_delay_ms` are optional so the defaults
    /// (`isProductionEnv ? 2 : 4` / `1500`) apply. A production startup throws
    /// the last error; every other environment returns `Ok(false)` after
    /// logging the degradation.
    pub async fn ensure_ready_for_startup(
        &mut self,
        component: &str,
        env: &EnvLike,
        retries: Option<i64>,
        retry_delay_ms: Option<u64>,
    ) -> Result<bool, MemoryRuntimeError> {
        let default_retries = if is_production_env(env) { 2 } else { 4 };
        let retries = retries.unwrap_or(default_retries).max(0);
        let retry_delay_ms = retry_delay_ms.unwrap_or(DEFAULT_STARTUP_RETRY_DELAY_MS);
        let required = is_production_env(env);

        for attempt in 0..=retries {
            match self.assert_ready() {
                Ok(()) => {
                    if attempt > 0 {
                        tracing::info!(
                            "[memory-runtime] {component} memory provider connectivity ready after retry {attempt}/{retries}"
                        );
                    }
                    self.set_ready_state(Some(true));
                    return Ok(true);
                }
                Err(error) => {
                    let message = error.message();
                    let attempt_label = format!("{}/{}", attempt + 1, retries + 1);
                    if attempt < retries {
                        tracing::warn!(
                            "[memory-runtime] {component} memory provider readiness probe failed ({attempt_label}): {message}. Retrying in {retry_delay_ms}ms..."
                        );
                        tokio::time::sleep(std::time::Duration::from_millis(retry_delay_ms)).await;
                        continue;
                    }

                    if required {
                        return Err(error);
                    }

                    tracing::warn!(
                        "[memory-runtime] {component} continuing without confirmed memory provider readiness after {attempt_label}: {message}"
                    );
                    self.set_ready_state(Some(false));
                    self.schedule_recovery_probe();
                    return Ok(false);
                }
            }
        }

        // The loop always returns; this is unreachable but keeps the type honest.
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::errors::MemoryError;
    use crate::memory::service::MemoryServiceDependencies;
    use crate::memory::types::{
        Mem0AddResult, Mem0DeleteByFilterInput, Mem0HistoryEntry, Mem0ListMemoryResult,
        Mem0MemoryInput, Mem0MemoryRecord, Mem0Scope, Mem0SearchHit, Mem0SearchInput,
    };

    /// The smallest `Mem0Client`: `list_memories` answers the canned probe
    /// outcome, every other method is unreachable in these tests.
    struct StubClient {
        probe_ok: bool,
    }

    impl Mem0Client for StubClient {
        fn add_memory(&self, _input: &Mem0MemoryInput) -> Result<Mem0AddResult, MemoryError> {
            Err(MemoryError::message("unused"))
        }

        fn search_memories(
            &self,
            _input: &Mem0SearchInput,
        ) -> Result<Vec<Mem0SearchHit>, MemoryError> {
            Err(MemoryError::message("unused"))
        }

        fn list_memories(
            &self,
            _input: &Mem0ListInput,
        ) -> Result<Mem0ListMemoryResult, MemoryError> {
            if self.probe_ok {
                Ok(Mem0ListMemoryResult {
                    memories: Vec::new(),
                    total: 0,
                    page: 1,
                    page_size: 1,
                })
            } else {
                Err(MemoryError::message("HTTP 500 probe failed"))
            }
        }

        fn get_memory(
            &self,
            _id: &str,
            _scope: Option<&Mem0Scope>,
        ) -> Result<Option<Mem0MemoryRecord>, MemoryError> {
            Err(MemoryError::message("unused"))
        }

        fn get_memory_history(
            &self,
            _id: &str,
            _scope: Option<&Mem0Scope>,
        ) -> Result<Vec<Mem0HistoryEntry>, MemoryError> {
            Err(MemoryError::message("unused"))
        }

        fn update_memory(
            &self,
            _id: &str,
            _input: &Mem0MemoryInput,
            _scope: Option<&Mem0Scope>,
        ) -> Result<(), MemoryError> {
            Err(MemoryError::message("unused"))
        }

        fn delete_memory(&self, _id: &str, _scope: Option<&Mem0Scope>) -> Result<(), MemoryError> {
            Err(MemoryError::message("unused"))
        }

        fn delete_memories_by_filter(
            &self,
            _input: &Mem0DeleteByFilterInput,
        ) -> Result<i64, MemoryError> {
            Err(MemoryError::message("unused"))
        }
    }

    const PROBE_ERROR: &str = "Memory provider connectivity check failed: HTTP 500 probe failed";

    fn runtime(probe_ok: bool) -> MemoryRuntime {
        MemoryRuntime::new(
            ConfiguredProvider::Sqlite,
            Box::new(StubClient { probe_ok }),
        )
    }

    #[test]
    fn explicit_provider_spellings_win_over_the_world_model_mode() {
        for spelling in ["postgres", "world-model", "world_model", "  POSTGRES "] {
            let env = EnvLike::from([("MEMORY_PROVIDER".to_string(), spelling.to_string())]);
            assert_eq!(configured_provider(&env), ConfiguredProvider::Postgres);
        }
        let env = EnvLike::from([("MEMORY_PROVIDER".to_string(), "SQLite".to_string())]);
        assert_eq!(configured_provider(&env), ConfiguredProvider::Sqlite);
        let env = EnvLike::from([("MEMORY_PROVIDER".to_string(), "mem0".to_string())]);
        assert_eq!(configured_provider(&env), ConfiguredProvider::Mem0);
    }

    #[test]
    fn an_unset_provider_follows_the_world_model_mode() {
        let canonical = EnvLike::from([("WORLD_MODEL_MODE".to_string(), "canonical".to_string())]);
        assert_eq!(
            configured_provider(&canonical),
            ConfiguredProvider::Postgres
        );
        let off = EnvLike::new();
        assert_eq!(configured_provider(&off), ConfiguredProvider::Mem0);
    }

    #[test]
    fn production_env_is_the_trimmed_lowercase_node_env() {
        assert!(is_production_env(&EnvLike::from([(
            "NODE_ENV".to_string(),
            " Production ".to_string()
        )])));
        assert!(!is_production_env(&EnvLike::from([(
            "NODE_ENV".to_string(),
            "test".to_string()
        )])));
        assert!(!is_production_env(&EnvLike::new()));
    }

    #[test]
    fn non_production_configuration_is_never_rejected() {
        assert!(assert_memory_runtime_configuration(&EnvLike::new()).is_ok());
    }

    #[test]
    fn production_postgres_requires_an_enabled_canonical_world_model() {
        let mut env = EnvLike::from([("NODE_ENV".to_string(), "production".to_string())]);
        env.insert("MEMORY_PROVIDER".to_string(), "postgres".to_string());
        let error = assert_memory_runtime_configuration(&env).expect_err("rejected");
        assert_eq!(
            error.message(),
            "Invalid memory configuration: MEMORY_PROVIDER=postgres requires WORLD_MODEL_MODE=canonical and an enabled World Model."
        );

        env.insert("WORLD_MODEL_MODE".to_string(), "canonical".to_string());
        assert!(assert_memory_runtime_configuration(&env).is_ok());
    }

    #[test]
    fn production_rejects_sqlite_and_mem0_without_credentials() {
        let mut env = EnvLike::from([("NODE_ENV".to_string(), "production".to_string())]);
        env.insert("MEMORY_PROVIDER".to_string(), "sqlite".to_string());
        assert_eq!(
            assert_memory_runtime_configuration(&env)
                .expect_err("rejected")
                .message(),
            "Invalid memory configuration: production requires MEMORY_PROVIDER=postgres (canonical) or explicit MEMORY_PROVIDER=mem0 (legacy)."
        );

        env.insert("MEMORY_PROVIDER".to_string(), "mem0".to_string());
        assert_eq!(
            assert_memory_runtime_configuration(&env)
                .expect_err("rejected")
                .message(),
            "Invalid memory configuration: MEM0_BASE_URL is required when MEMORY_PROVIDER=mem0."
        );

        env.insert("MEM0_BASE_URL".to_string(), "https://mem0".to_string());
        assert_eq!(
            assert_memory_runtime_configuration(&env)
                .expect_err("rejected")
                .message(),
            "Invalid memory configuration: MEM0_API_KEY is required when MEMORY_PROVIDER=mem0."
        );

        env.insert("MEM0_API_KEY".to_string(), "secret".to_string());
        assert!(assert_memory_runtime_configuration(&env).is_ok());
    }

    #[test]
    fn recovery_delay_doubles_from_five_seconds_and_caps_at_sixty() {
        assert_eq!(recovery_delay_ms(0), 5_000);
        assert_eq!(recovery_delay_ms(1), 10_000);
        assert_eq!(recovery_delay_ms(2), 20_000);
        assert_eq!(recovery_delay_ms(3), 40_000);
        assert_eq!(recovery_delay_ms(4), 60_000);
        assert_eq!(recovery_delay_ms(31), 60_000);
        assert_eq!(recovery_delay_ms(-3), 5_000);
    }

    #[test]
    fn the_probe_is_only_scheduled_for_a_degraded_runtime() {
        let mut runtime = runtime(true);
        assert_eq!(runtime.schedule_recovery_probe(), None, "no ready flag yet");
        runtime.set_ready_state(Some(true));
        assert_eq!(runtime.schedule_recovery_probe(), None);

        runtime.set_ready_state(Some(false));
        assert_eq!(runtime.schedule_recovery_probe(), Some(5_000));
        assert_eq!(runtime.schedule_recovery_probe(), Some(10_000));
        assert_eq!(runtime.recovery_attempt(), 2);

        runtime.set_ready_state(Some(true));
        assert_eq!(runtime.recovery_attempt(), 0, "ready clears the backoff");
        assert_eq!(runtime.schedule_recovery_probe(), None);
    }

    #[test]
    fn a_clientless_runtime_reports_the_required_client_error() {
        let runtime = MemoryRuntime::without_client(ConfiguredProvider::Mem0);
        assert_eq!(
            runtime.required_client().err().expect("no client").message(),
            "Invalid memory configuration: memory client unavailable. Set MEMORY_PROVIDER=postgres, mem0, or sqlite."
        );
        assert_eq!(
            runtime.provider_kind().expect_err("no client").message(),
            "Invalid memory configuration: memory client unavailable. Set MEMORY_PROVIDER=postgres, mem0, or sqlite."
        );
    }

    #[test]
    fn a_provider_that_does_not_declare_itself_reports_mem0() {
        let runtime = runtime(true);
        assert_eq!(
            runtime.provider_kind().expect("kind"),
            MemoryProviderKind::Mem0
        );
        assert_eq!(runtime.provider(), ConfiguredProvider::Sqlite);
    }

    #[test]
    fn the_probe_marks_the_runtime_ready_or_degraded() {
        let mut ready = runtime(true);
        assert_eq!(ready.assert_ready(), Ok(()));
        assert_eq!(ready.ready_state(), Some(true));

        let mut degraded = runtime(false);
        let error = degraded.assert_ready().expect_err("probe fails");
        assert_eq!(error.message(), PROBE_ERROR);
        assert_eq!(degraded.ready_state(), Some(false));
        assert_eq!(degraded.recovery_attempt(), 1, "failure schedules recovery");
    }

    #[test]
    fn recover_now_returns_the_probe_outcome() {
        let mut recovering = runtime(true);
        assert!(recovering.recover_now());
        assert_eq!(recovering.ready_state(), Some(true));

        let mut degraded = runtime(false);
        assert!(!degraded.recover_now());
        assert_eq!(degraded.ready_state(), Some(false));
    }

    #[test]
    fn a_degraded_runtime_refuses_the_service() {
        let mut degraded = runtime(false);
        let _ = degraded.recover_now();
        let error = match degraded.memory_service(MemoryServiceDependencies::for_test()) {
            Ok(_) => panic!("a degraded runtime must not hand out a service"),
            Err(error) => error,
        };
        assert!(matches!(error, MemoryRuntimeError::Unavailable(_)));
        assert_eq!(
            error.message(),
            "Memory runtime unavailable: configured provider is not ready."
        );
        assert!(degraded
            .memory_service_if_ready(MemoryServiceDependencies::for_test())
            .expect("no error")
            .is_none());
    }

    #[test]
    fn a_ready_runtime_builds_the_service() {
        let mut ready = runtime(true);
        assert!(ready.assert_ready().is_ok());
        assert!(ready
            .memory_service(MemoryServiceDependencies::for_test())
            .is_ok());
        assert!(ready
            .memory_service_if_ready(MemoryServiceDependencies::for_test())
            .expect("no error")
            .is_some());
    }

    #[tokio::test]
    async fn startup_retries_then_continues_degraded_outside_production() {
        let mut degraded = runtime(false);
        let env = EnvLike::new();
        let outcome = degraded
            .ensure_ready_for_startup("gateway", &env, Some(1), Some(0))
            .await
            .expect("non-production continues");
        assert!(!outcome);
        assert_eq!(degraded.ready_state(), Some(false));
        assert!(degraded.recovery_attempt() >= 1);
    }

    #[tokio::test]
    async fn a_production_startup_throws_the_last_error() {
        let mut degraded = runtime(false);
        let env = EnvLike::from([("NODE_ENV".to_string(), "production".to_string())]);
        let error = degraded
            .ensure_ready_for_startup("gateway", &env, Some(1), Some(0))
            .await
            .expect_err("production startup must fail");
        assert_eq!(error.message(), PROBE_ERROR);
    }

    #[tokio::test]
    async fn a_ready_probe_ends_the_startup_loop() {
        let mut ready = runtime(true);
        assert!(ready
            .ensure_ready_for_startup("scheduler", &EnvLike::new(), Some(2), Some(0))
            .await
            .expect("ready"));
        assert_eq!(ready.ready_state(), Some(true));
    }
}
