//! Security routes.
//!
//! Port of `app/api/security/status/route.ts` and
//! `app/api/security/policy-explain/route.ts`. Both spread their snapshot into
//! the top level of the response, i.e. `{ ok: true, ...snapshot }`, and report
//! failures as `{ ok: false, error }` with status 500.

use std::path::{Path, PathBuf};

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use betaclaw_core::security::policy::{
    build_effective_policy_explain_snapshot, EffectivePolicyExplainSnapshot,
};
use betaclaw_core::security::status::{
    build_security_status_snapshot, CommandPermission, SecurityStatusSnapshot, SnapshotInput,
};

use crate::state::SharedState;

/// `GET /api/security/status` response.
///
/// Mirrors `NextResponse.json({ ok: true, ...snapshot })`: the snapshot fields
/// are spread at the top level, not nested under a `snapshot` key. The frontend
/// type `SecurityStatusResponse` in `src/components/SecurityView.tsx` reads
/// `checks` and `generatedAt` from the top level.
#[derive(Serialize)]
struct StatusResponse {
    ok: bool,
    #[serde(flatten)]
    snapshot: SecurityStatusSnapshot,
}

/// `GET /api/security/policy-explain` response.
///
/// Same spread shape as `StatusResponse`, matching
/// `NextResponse.json({ ok: true, ...snapshot })`.
#[derive(Serialize)]
struct PolicyExplainResponse {
    ok: bool,
    #[serde(flatten)]
    snapshot: EffectivePolicyExplainSnapshot,
}

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/api/security/status", get(status))
        .route("/api/security/policy-explain", get(policy_explain))
}

/// `GET /api/security/status`
async fn status(State(state): State<SharedState>) -> Response {
    // TypeScript answers 500 `{ ok: false, error }` when the rule source cannot
    // be read. Returning 200 with an empty rule list would silently degrade the
    // security panel, so the failure is propagated instead.
    let commands = match load_security_rules() {
        Ok(commands) => commands,
        Err(error) => return internal_error(&error),
    };
    let app_url = std::env::var("APP_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            std::env::var("NEXT_PUBLIC_APP_URL")
                .ok()
                .filter(|value| !value.trim().is_empty())
        })
        .unwrap_or_default();

    let messages_db_path = PathBuf::from(&state.config.messages_db_path);
    let snapshot = build_security_status_snapshot(&SnapshotInput {
        commands: &commands,
        app_url: &app_url,
        messages_db_path: &messages_db_path,
        // The Rust gateway always has the crypto primitives linked in, so
        // WebCrypto availability is a constant true here.
        secure_crypto: true,
        channel_secret_configured: &|channel: &str, key: &str| {
            channel_secret_configured(&state, channel, key)
        },
    });

    Json(StatusResponse { ok: true, snapshot }).into_response()
}

/// `GET /api/security/policy-explain`
async fn policy_explain(State(state): State<SharedState>) -> Response {
    let loaded = match state.gateway_config.load() {
        Ok(loaded) => loaded,
        Err(error) => return internal_error(&error.to_string()),
    };

    let snapshot = build_effective_policy_explain_snapshot(
        &loaded.config,
        &loaded.revision,
        loaded.source.as_str(),
    );
    Json(PolicyExplainResponse { ok: true, snapshot }).into_response()
}

/// Mirrors the `{ ok: false, error }` + 500 shape of the TypeScript routes.
fn internal_error(message: &str) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(serde_json::json!({ "ok": false, "error": message })),
    )
        .into_response()
}

/// Loads the command permission rules from the generated fixture.
///
/// The fixture is produced from `src/shared/domain/constants.ts` by
/// `scripts/ci/export-security-rules.mjs`, so the two implementations cannot
/// drift apart silently.
fn load_security_rules() -> Result<Vec<CommandPermission>, String> {
    serde_json::from_str::<Vec<CommandPermission>>(include_str!("../fixtures/security-rules.json"))
        .map_err(|error| {
            tracing::error!(error = %error, "Failed to parse embedded security rules fixture");
            format!("Failed to read security rules: {error}")
        })
}

/// Reads a channel credential from the store, matching
/// `hasConfiguredSecret` in `src/server/security/status.ts:152-165`.
fn channel_secret_configured(state: &SharedState, channel: &str, key: &str) -> bool {
    if let Ok(value) = std::env::var(format!("{}_WEBHOOK_SECRET", channel.to_ascii_uppercase())) {
        if !value.trim().is_empty() {
            return true;
        }
    }
    if channel == "discord" {
        if let Ok(value) = std::env::var("DISCORD_PUBLIC_KEY") {
            if !value.trim().is_empty() {
                return true;
            }
        }
    }
    lookup_channel_credential(&state.config.messages_db_path, channel, key).is_some()
}

fn lookup_channel_credential(db_path: &str, channel: &str, key: &str) -> Option<String> {
    if !Path::new(db_path).exists() {
        return None;
    }
    let connection = Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    let exists: Option<i64> = connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='channel_credentials'",
            [],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten();
    exists?;
    connection
        .query_row(
            "SELECT value FROM channel_credentials WHERE channel = ?1 AND key = ?2",
            params![channel, key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten()
        .filter(|value| !value.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Method;
    use betaclaw_core::gateway_config::{default_gateway_config, ConfigBackend};

    use crate::routes::test_support::{send, state_in, state_with, ScratchDir};

    #[test]
    fn loads_the_generated_rule_fixture() {
        let rules = load_security_rules().expect("fixture must parse");
        assert_eq!(rules.len(), 24);
        assert!(rules.iter().any(|rule| rule.risk == "High"));
    }

    #[test]
    fn status_response_spreads_the_snapshot_at_the_top_level() {
        let config = default_gateway_config();
        let snapshot = build_effective_policy_explain_snapshot(&config, "rev", "default");
        let value = serde_json::to_value(PolicyExplainResponse { ok: true, snapshot })
            .expect("serializable");

        assert_eq!(value["ok"], true);
        assert!(
            value.get("snapshot").is_none(),
            "snapshot must be spread, not nested"
        );
        assert_eq!(value["runtime"]["mode"], "main-chat-only");
        assert!(value["channels"].get("webchatEnabled").is_some());
    }

    #[test]
    fn default_config_snapshot_matches_expected_flags() {
        let config = default_gateway_config();
        let snapshot = build_effective_policy_explain_snapshot(&config, "rev", "default");
        assert!(snapshot.channels.webchat_enabled);
        assert!(snapshot.channels.telegram_enabled);
        assert!(!snapshot.channels.slack_enabled);
        assert!(snapshot.tools.browser_managed);
        assert!(snapshot.tools.browser_headless);
        assert!(!snapshot.tools.sandbox_enabled);
        assert_eq!(snapshot.tools.sandbox_type.as_deref(), Some("docker"));
    }

    #[tokio::test]
    async fn policy_explain_reads_the_file_backend() {
        let scratch = ScratchDir::new();
        let file = scratch.path_string("betaclaw.json");
        // Load mode requires a `gateway` object, as in TypeScript.
        std::fs::write(
            &file,
            r#"{"gateway":{"port":8080,"host":"0.0.0.0","bind":"all","logLevel":"info"},"channels":{"slack":{"enabled":true}}}"#,
        )
        .expect("write config file");
        let state = state_with(&scratch, |config| {
            config.gateway_config_backend = ConfigBackend::File;
            config.gateway_config_path = file.clone();
        });

        let (status, body) = send(
            &state,
            Method::GET,
            "/api/security/policy-explain",
            None,
            None,
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["ok"], true);
        assert_eq!(body["source"], "file");
        assert_eq!(body["channels"]["slackEnabled"], true);
        assert!(
            !std::path::Path::new(&scratch.path_string("gateway-config.db")).exists(),
            "the file backend must not create or touch the database"
        );
    }

    #[tokio::test]
    async fn policy_explain_creates_a_missing_config_db_with_defaults() {
        let scratch = ScratchDir::new();
        let state = state_in(&scratch);
        let database = std::path::PathBuf::from(scratch.path_string("gateway-config.db"));
        assert!(!database.exists(), "the scratch directory starts empty");

        let (status, body) = send(
            &state,
            Method::GET,
            "/api/security/policy-explain",
            None,
            None,
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["ok"], true);
        assert_eq!(body["source"], "default");
        assert_eq!(body["revision"].as_str().map(str::len), Some(16));
        assert!(
            database.exists(),
            "loading the default config creates the database, as GET /api/config does"
        );
    }

    #[test]
    fn channel_credential_lookup_tolerates_missing_db() {
        assert!(lookup_channel_credential(
            "/nonexistent/messages.db",
            "telegram",
            "webhook_secret"
        )
        .is_none());
    }
}
