//! Shared application state.

use std::sync::Arc;

use betaclaw_core::config::GatewayConfig;
use betaclaw_core::gateway::registry::{ClientRegistry, SharedRegistry};
use betaclaw_core::gateway_config::GatewayConfigStore;
use betaclaw_core::logging::repository::{LogRepository, LogRepositoryError};
use betaclaw_core::messages_store::{MessageRepositoryError, MessagesStore};
use betaclaw_core::personas::repository::{PersonaRepository, PersonaRepositoryError};
use betaclaw_core::personas::PersonaWorkspace;
use tokio::sync::Mutex;

use crate::routes::inbox::InboxRateLimiter;

/// State shared by every request handler.
pub struct AppState {
    pub config: GatewayConfig,
    pub registry: SharedRegistry,
    /// The log repository is behind a mutex because `rusqlite::Connection` is
    /// synchronous. Contention is negligible: log writes are short and rare
    /// compared to reads through the gateway.
    pub logs: Mutex<LogRepository>,
    /// Gateway config store, built once from the resolved backend and paths.
    pub gateway_config: GatewayConfigStore,
    // ponytail: sync SQLite under a mutex on the reactor, same as `logs`.
    // Upgrade to spawn_blocking if persona routes show up in profiles.
    pub personas: Mutex<PersonaRepository>,
    // ponytail: one connection under a mutex for conversations, messages and the
    // inbox, same as `personas`. Upgrade to spawn_blocking or a pool if the chat
    // routes show up in profiles.
    pub messages: Mutex<MessagesStore>,
    /// Per-user request windows for `GET /api/channels/inbox`.
    pub inbox_rate_limiter: InboxRateLimiter,
    /// Upstream client for the reverse proxy. One client per process keeps the
    /// connection pool bounded and predictable.
    pub upstream: reqwest::Client,
}

impl AppState {
    pub fn new(config: GatewayConfig) -> Result<Self, StateError> {
        let registry: SharedRegistry = Arc::new(ClientRegistry::new());
        let logs = LogRepository::open(&config.logs_db_path)?;
        let personas = PersonaRepository::open_with_workspace(
            &config.personas_db_path,
            PersonaWorkspace::new(config.personas_root_path.as_str()),
        )?;
        let messages = MessagesStore::open(&config.messages_db_path)?;
        let gateway_config = GatewayConfigStore::new(
            config.gateway_config_backend,
            config.gateway_config_path.as_str(),
            config.gateway_config_db_path.as_str(),
        );
        let upstream = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()?;
        Ok(Self {
            config,
            registry,
            logs: Mutex::new(logs),
            gateway_config,
            personas: Mutex::new(personas),
            messages: Mutex::new(messages),
            inbox_rate_limiter: InboxRateLimiter::default(),
            upstream,
        })
    }
}

/// Failures while building [`AppState`]. Each store keeps its own error type.
#[derive(Debug, thiserror::Error)]
pub enum StateError {
    #[error(transparent)]
    Logs(#[from] LogRepositoryError),
    #[error(transparent)]
    Personas(#[from] PersonaRepositoryError),
    #[error(transparent)]
    Messages(#[from] MessageRepositoryError),
    #[error("failed to build upstream client: {0}")]
    Upstream(#[from] reqwest::Error),
}

pub type SharedState = Arc<AppState>;

/// Everything the process owns at runtime, used by start-up and shutdown.
pub struct GatewayRuntime {
    pub state: SharedState,
    pub listener: tokio::net::TcpListener,
}

impl GatewayRuntime {
    /// Binds the public listener and builds the shared state.
    pub async fn bind(config: GatewayConfig) -> Result<Self, GatewayBindError> {
        // Fail before binding so a misconfigured production deployment never
        // opens a port.
        betaclaw_core::auth::production_guard::assert_production_auth_config_from_env()
            .map_err(GatewayBindError::AuthConfig)?;

        let bind_address = if config.hostname.contains(':') && !config.hostname.starts_with('[') {
            format!("[{}]:{}", config.hostname, config.port)
        } else {
            format!("{}:{}", config.hostname, config.port)
        };

        let listener = tokio::net::TcpListener::bind(&bind_address)
            .await
            .map_err(|source| GatewayBindError::Listen {
                address: bind_address,
                source,
            })?;

        let state = Arc::new(AppState::new(config).map_err(GatewayBindError::State)?);
        Ok(Self { state, listener })
    }
}

#[derive(Debug, thiserror::Error)]
pub enum GatewayBindError {
    #[error("refusing to start: {0}")]
    AuthConfig(#[from] betaclaw_core::auth::production_guard::AuthConfigError),
    #[error("failed to listen on {address}: {source}")]
    Listen {
        address: String,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to initialise state: {0}")]
    State(#[from] StateError),
}
