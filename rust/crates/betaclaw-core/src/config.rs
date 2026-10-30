//! Process-wide configuration resolved from the environment.
//!
//! Mirrors the `process.env` reads scattered across `server.ts`, `proxy.ts` and
//! `src/server/auth/*.ts`. Values are resolved once at start-up so that a request
//! can never observe a half-mutated configuration.

use std::env;

use crate::gateway_config::{ConfigBackend, PathResolver};

/// `x-betaclaw-client-loopback`.
///
/// The header is never trusted from the client. The gateway always deletes an
/// inbound value and re-derives it from the TCP peer, matching
/// `src/server/auth/proxyPolicy.ts:11`.
pub const CLIENT_LOOPBACK_HEADER: &str = "x-betaclaw-client-loopback";

/// Public API prefixes, ported from `proxy.ts:15-29`.
///
/// Order is irrelevant; matching is prefix based and case sensitive.
pub const PUBLIC_API_PREFIXES: &[&str] = &[
    "/api/auth",
    "/api/webhooks",
    "/api/model-hub/oauth/callback",
    "/api/channels/telegram/webhook",
    "/api/channels/telegram/bots",
    "/api/channels/discord/webhook",
    "/api/channels/slack/webhook",
    "/api/channels/whatsapp/webhook",
    "/api/channels/imessage/webhook",
    "/api/health/scheduler",
    // Graphiti authenticates this internal adapter with its own bearer token;
    // do not require a browser session or the general MC_API_TOKEN here.
    "/api/internal/model-hub/graphiti",
];

fn env_string(key: &str) -> String {
    env::var(key).unwrap_or_default().trim().to_string()
}

fn env_bool(key: &str, default: bool) -> bool {
    match env::var(key) {
        Ok(raw) => raw.trim().eq_ignore_ascii_case("true"),
        Err(_) => default,
    }
}

/// Port of the `http` branch of `resolveLimit` in `src/server/channels/inbox/rateLimit.ts`.
fn resolve_inbox_http_rate_limit() -> u32 {
    const DEFAULT: u32 = 120;
    match env_string("INBOX_HTTP_RATE_LIMIT_PER_MINUTE").parse::<i64>() {
        Ok(value) if value > 0 => value.clamp(1, 10_000) as u32,
        _ => DEFAULT,
    }
}

fn env_nonempty(key: &str) -> Option<String> {
    let value = env_string(key);
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

/// Resolved runtime configuration for the gateway process.
#[derive(Debug, Clone)]
pub struct GatewayConfig {
    pub hostname: String,
    pub port: u16,
    /// Upstream Next.js origin used for every not-yet-migrated route.
    pub upstream_origin: String,
    pub require_auth: bool,
    pub demo_mode: bool,
    pub mc_api_token: Option<String>,
    pub auth_secret: String,
    pub principal_user_id: String,
    pub internal_token: String,
    pub nextauth_url: String,
    pub logs_db_path: String,
    pub messages_db_path: String,
    pub auth_db_path: String,
    pub gateway_config_db_path: String,
    /// `BETACLAW_CONFIG_BACKEND`, resolved with the same rules as `paths.ts`.
    pub gateway_config_backend: ConfigBackend,
    /// `BETACLAW_CONFIG_PATH` resolved to the JSON file used by the `file` backend.
    pub gateway_config_path: String,
    pub personas_db_path: String,
    pub personas_root_path: String,
    pub workspace_root: String,
    pub gateway_max_requests_per_minute: usize,
    pub websocket_max_payload_bytes: usize,
    pub websocket_max_connections_per_user: usize,
    /// `INBOX_V2_ENABLED`. Anything but `false` keeps the v2 inbox on. When off,
    /// v2 inbox requests answer 503.
    pub inbox_v2_enabled: bool,
    /// `INBOX_V2_EVENTS_ENABLED`, same rule, for `inbox.updated` events.
    pub inbox_events_enabled: bool,
    /// `INBOX_HTTP_RATE_LIMIT_PER_MINUTE`, default 120, clamped to 1..=10000.
    pub inbox_http_rate_limit_per_minute: u32,
}

pub const LEGACY_LOCAL_USER_ID: &str = "local-user";
const LOCAL_DEVELOPMENT_AUTH_SECRET: &str = "betaclaw-local-nextauth-secret";

impl GatewayConfig {
    /// Resolves configuration from the process environment.
    ///
    /// `NEXTAUTH_SECRET` is mandatory in production, matching
    /// `resolveAuthSecret()` in `server.ts:66-78` and
    /// `assertProductionAuthConfig()` in `src/server/auth/productionGuard.ts`.
    pub fn from_env() -> Result<Self, ConfigError> {
        let node_env = env::var("NODE_ENV").unwrap_or_default();
        let is_production = node_env == "production";

        let hostname = {
            let configured = env_string("HOSTNAME");
            if configured.is_empty() {
                "127.0.0.1".to_string()
            } else {
                configured
            }
        };
        let port = match env_nonempty("PORT") {
            Some(raw) => raw
                .parse::<u16>()
                .map_err(|_| ConfigError::InvalidPort(raw))?,
            None => 3000,
        };

        let auth_secret = match env_nonempty("NEXTAUTH_SECRET")
            .or_else(|| env_nonempty("AUTH_SECRET"))
        {
            Some(secret) => secret,
            None => {
                if is_production {
                    return Err(ConfigError::MissingAuthSecret);
                }
                tracing::warn!(
                    "[SECURITY WARNING] NEXTAUTH_SECRET is not configured. Falling back to a local development secret."
                );
                LOCAL_DEVELOPMENT_AUTH_SECRET.to_string()
            }
        };

        let upstream_origin = {
            let raw = env_nonempty("GATEWAY_UPSTREAM_ORIGIN")
                .or_else(|| env_nonempty("WEB_UI_ORIGIN"))
                .unwrap_or_else(|| "http://127.0.0.1:3001".to_string());
            raw.trim_end_matches('/').to_string()
        };

        let workspace_root = env_nonempty("WORKSPACE_ROOT")
            .or_else(|| env_nonempty("PWD"))
            .unwrap_or_else(|| ".".to_string());

        let gateway_config_paths = PathResolver::from_env();

        Ok(Self {
            hostname,
            port,
            upstream_origin,
            require_auth: env_bool("REQUIRE_AUTH", false),
            demo_mode: env_bool("DEMO_MODE", false),
            mc_api_token: env_nonempty("MC_API_TOKEN"),
            auth_secret,
            principal_user_id: env_nonempty("PRINCIPAL_USER_ID")
                .unwrap_or_else(|| LEGACY_LOCAL_USER_ID.to_string()),
            // `src/server/auth/internalRequest.ts` generates this per process.
            // Both processes must use the same value when they talk to each other.
            internal_token: env_nonempty("MC_INTERNAL_TOKEN")
                .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string()),
            nextauth_url: env_nonempty("NEXTAUTH_URL").unwrap_or_default(),
            logs_db_path: resolve_db_path("LOGS_DB_PATH", ".local/logs.db", &workspace_root),
            messages_db_path: resolve_db_path(
                "MESSAGES_DB_PATH",
                ".local/messages.db",
                &workspace_root,
            ),
            auth_db_path: resolve_db_path("AUTH_DB_PATH", ".local/auth.db", &workspace_root),
            // Not `resolve_db_path`: `resolveGatewayConfigDbPath` in
            // `paths.ts:61-68` resolves the default against the process cwd,
            // not the workspace root. The PathResolver mirrors that.
            gateway_config_db_path: gateway_config_paths.resolve_config_db_path(),
            gateway_config_backend: gateway_config_paths.resolve_backend(),
            gateway_config_path: gateway_config_paths.resolve_config_path(),
            personas_db_path: resolve_db_path(
                "PERSONAS_DB_PATH",
                ".local/personas.db",
                &workspace_root,
            ),
            personas_root_path: resolve_db_path(
                "PERSONAS_ROOT_PATH",
                ".local/personas",
                &workspace_root,
            ),
            workspace_root,
            gateway_max_requests_per_minute: resolve_max_requests_per_minute(),
            websocket_max_payload_bytes: 16 * 1024 * 1024,
            websocket_max_connections_per_user: 5,
            inbox_v2_enabled: !env_string("INBOX_V2_ENABLED").eq_ignore_ascii_case("false"),
            inbox_events_enabled: !env_string("INBOX_V2_EVENTS_ENABLED")
                .eq_ignore_ascii_case("false"),
            inbox_http_rate_limit_per_minute: resolve_inbox_http_rate_limit(),
        })
    }

    /// Secure cookie naming follows `next-auth/jwt`: the `__Secure-` prefix is
    /// used when the configured `NEXTAUTH_URL` is served over HTTPS.
    pub fn session_cookie_names(&self) -> Vec<String> {
        vec![
            crate::auth::session_cookie_name(crate::auth::use_secure_cookies(&self.nextauth_url))
                .to_string(),
        ]
    }
}

fn resolve_db_path(env_key: &str, default: &str, workspace_root: &str) -> String {
    match env_nonempty(env_key) {
        Some(path) if std::path::Path::new(&path).is_absolute() => path,
        Some(path) => {
            let joined = format!("{workspace_root}/{path}");
            normalize_path(&joined)
        }
        None => normalize_path(&format!("{workspace_root}/{default}")),
    }
}

/// Minimal lexical path cleanup. `std::fs::canonicalize` cannot be used because
/// the target file usually does not exist yet.
fn normalize_path(input: &str) -> String {
    let normalized = input.replace('\\', "/");
    let mut parts: Vec<&str> = Vec::new();
    for segment in normalized.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    if normalized.starts_with('/') {
        format!("/{}", parts.join("/"))
    } else {
        parts.join("/")
    }
}

/// `resolveMaxRequestsPerMinute()` from `src/server/gateway/connection-handler.ts:135-141`.
fn resolve_max_requests_per_minute() -> usize {
    const DEFAULT: usize = 600;
    const BASE: usize = 60;

    let raw = env_nonempty("AGENT_V2_MAX_REQUESTS_PER_MINUTE");
    let parsed = raw.and_then(|value| value.parse::<i64>().ok());
    match parsed {
        Some(value) if value > 0 => {
            let clamped = value.clamp(10, 10_000) as usize;
            clamped.max(BASE).max(0)
        }
        _ => BASE.max(DEFAULT),
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("PORT must be a valid TCP port, got `{0}`")]
    InvalidPort(String),
    #[error("NEXTAUTH_SECRET (or AUTH_SECRET) must be set in production.")]
    MissingAuthSecret,
}

/// True when `pathname` equals `prefix` or is nested below it.
pub fn has_path_prefix(pathname: &str, prefix: &str) -> bool {
    pathname == prefix || pathname.starts_with(&format!("{prefix}/"))
}

/// Ported from `isPublicApiPath()` in `proxy.ts:35-37`.
pub fn is_public_api_path(pathname: &str) -> bool {
    PUBLIC_API_PREFIXES
        .iter()
        .any(|prefix| has_path_prefix(pathname, prefix))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefix_match_requires_path_separator() {
        assert!(has_path_prefix("/api/auth", "/api/auth"));
        assert!(has_path_prefix("/api/auth/callback", "/api/auth"));
        // `/api/authentic` must not match `/api/auth`.
        assert!(!has_path_prefix("/api/authentic", "/api/auth"));
    }

    #[test]
    fn public_prefixes_cover_documented_endpoints() {
        assert!(is_public_api_path("/api/auth/session"));
        assert!(is_public_api_path("/api/channels/telegram/webhook"));
        assert!(is_public_api_path("/api/health/scheduler"));
        assert!(is_public_api_path(
            "/api/internal/model-hub/graphiti/v1/chat"
        ));
        assert!(!is_public_api_path("/api/logs"));
        assert!(!is_public_api_path("/api/master/notes"));
    }

    #[test]
    fn normalizes_relative_paths() {
        assert_eq!(normalize_path("./a/./b"), "a/b");
        assert_eq!(normalize_path("a/b/../c"), "a/c");
        assert_eq!(normalize_path("/var//lib/../lib/db"), "/var/lib/db");
    }
}
