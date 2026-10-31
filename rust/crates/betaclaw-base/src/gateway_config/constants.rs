//! Port of `src/server/config/gateway/constants.ts`.
//!
//! The `gateway_config_state` DDL is byte-for-byte the TypeScript string so the
//! same `.local/gateway-config.db` file is usable from both implementations.

use serde_json::{json, Value};

/// `REDACTED_SECRET_VALUE` from `constants.ts:5`.
pub const REDACTED_SECRET_VALUE: &str = "__REDACTED__";

/// `GATEWAY_CONFIG_DB_ROW_ID` from `constants.ts:10`. The table is a singleton:
/// every read and write addresses row `id = 1`.
pub const GATEWAY_CONFIG_DB_ROW_ID: i64 = 1;

/// `GATEWAY_CONFIG_DB_TABLE_SQL` from `constants.ts:11-17`.
pub const GATEWAY_CONFIG_DB_TABLE_SQL: &str = r"
  CREATE TABLE IF NOT EXISTS gateway_config_state (
    id INTEGER PRIMARY KEY,
    config_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
";

/// `SECRET_PATHS` from `constants.ts:19-22`.
///
/// Values stored under these paths are replaced by `__REDACTED__` before the
/// config leaves the process and are restored from the stored value on save.
pub const SECRET_PATHS: &[&[&str]] = &[
    &["channels", "telegram", "token"],
    &["gateway", "auth", "token"],
];

/// `gateway.logLevel` allow-list, inlined from `normalize.ts:226`.
pub const ALLOWED_LOG_LEVELS: &[&str] = &["debug", "info", "warn", "error"];

/// `ALLOWED_UI_DEFAULT_VIEWS` from `src/shared/config/uiSchema.ts:3`, which is
/// `Object.values(View)` from `src/shared/domain/types.ts`.
pub const ALLOWED_UI_DEFAULT_VIEWS: &[&str] = &[
    "dashboard",
    "chat",
    "config",
    "skills",
    "channels",
    "logs",
    "stats",
    "security",
    "profile",
    "tasks",
    "models",
    "personas",
    "memory",
    "knowledge",
    "cron",
    "instances",
    "sessions",
    "nodes",
    "debugger",
    "master",
    "agent-room",
];

/// `ALLOWED_UI_DENSITIES` from `src/shared/config/uiSchema.ts:4`.
pub const ALLOWED_UI_DENSITIES: &[&str] = &["comfortable", "compact"];

/// `ALLOWED_UI_TIME_FORMATS` from `src/shared/config/uiSchema.ts:5`.
pub const ALLOWED_UI_TIME_FORMATS: &[&str] = &["12h", "24h"];

pub fn is_allowed_ui_default_view(value: &str) -> bool {
    ALLOWED_UI_DEFAULT_VIEWS.contains(&value)
}

pub fn is_allowed_ui_density(value: &str) -> bool {
    ALLOWED_UI_DENSITIES.contains(&value)
}

pub fn is_allowed_ui_time_format(value: &str) -> bool {
    ALLOWED_UI_TIME_FORMATS.contains(&value)
}

/// `DEFAULT_GATEWAY_CONFIG` from `constants.ts:24-52`.
///
/// Key order is significant: `computeGatewayConfigRevision` hashes the
/// `JSON.stringify` output, and `serde_json` is compiled with `preserve_order` in
/// `rust/Cargo.toml:28` so `serde_json::json!` literals keep the same insertion
/// order that the TypeScript object literal produces.
pub fn default_gateway_config() -> Value {
    json!({
        "gateway": {
            "port": 8080,
            "host": "0.0.0.0",
            "bind": "all",
            "logLevel": "info"
        },
        "provider": {
            "primary": "gemini-3-flash-preview",
            "fallback": "gemini-3-pro-preview",
            "rotation": true
        },
        "channels": {
            "webchat": { "enabled": true },
            "telegram": { "enabled": true, "token": "ENV_T_TOKEN" },
            "slack": { "enabled": false }
        },
        "tools": {
            "browser": { "managed": true, "headless": true },
            "sandbox": { "type": "docker", "enabled": false }
        },
        "ui": {
            "defaultView": "dashboard",
            "density": "comfortable",
            "language": "de-DE",
            "timeFormat": "24h",
            "showAdvancedDebug": false
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_matches_the_typescript_literal() {
        let config = default_gateway_config();
        assert_eq!(config["gateway"]["port"], 8080);
        assert_eq!(config["gateway"]["host"], "0.0.0.0");
        assert_eq!(config["gateway"]["bind"], "all");
        assert_eq!(config["gateway"]["logLevel"], "info");
        assert_eq!(config["provider"]["primary"], "gemini-3-flash-preview");
        assert_eq!(config["provider"]["fallback"], "gemini-3-pro-preview");
        assert_eq!(config["provider"]["rotation"], true);
        assert_eq!(config["channels"]["webchat"]["enabled"], true);
        assert_eq!(config["channels"]["telegram"]["token"], "ENV_T_TOKEN");
        assert_eq!(config["channels"]["slack"]["enabled"], false);
        assert_eq!(config["tools"]["browser"]["managed"], true);
        assert_eq!(config["tools"]["browser"]["headless"], true);
        assert_eq!(config["tools"]["sandbox"]["type"], "docker");
        assert_eq!(config["tools"]["sandbox"]["enabled"], false);
        assert_eq!(config["ui"]["defaultView"], "dashboard");
        assert_eq!(config["ui"]["density"], "comfortable");
        assert_eq!(config["ui"]["language"], "de-DE");
        assert_eq!(config["ui"]["timeFormat"], "24h");
        assert_eq!(config["ui"]["showAdvancedDebug"], false);
    }

    #[test]
    fn default_config_keeps_javascript_key_order() {
        // The revision hash is taken over `JSON.stringify`, which follows
        // insertion order. `preserve_order` must keep the same sequence or the
        // Rust and TypeScript revisions diverge for identical content.
        let serialized = serde_json::to_string(&default_gateway_config()).expect("serialize");
        let expected = concat!(
            r#"{"gateway":{"port":8080,"host":"0.0.0.0","bind":"all","logLevel":"info"},"#,
            r#""provider":{"primary":"gemini-3-flash-preview","fallback":"gemini-3-pro-preview","rotation":true},"#,
            r#""channels":{"webchat":{"enabled":true},"telegram":{"enabled":true,"token":"ENV_T_TOKEN"},"#,
            r#""slack":{"enabled":false}},"#,
            r#""tools":{"browser":{"managed":true,"headless":true},"sandbox":{"type":"docker","enabled":false}},"#,
            r#""ui":{"defaultView":"dashboard","density":"comfortable","language":"de-DE","timeFormat":"24h","showAdvancedDebug":false}}"#
        );
        assert_eq!(serialized, expected);
    }

    #[test]
    fn secret_paths_match_the_typescript_tuples() {
        assert_eq!(SECRET_PATHS.len(), 2);
        assert_eq!(SECRET_PATHS[0], ["channels", "telegram", "token"]);
        assert_eq!(SECRET_PATHS[1], ["gateway", "auth", "token"]);
    }

    #[test]
    fn ui_allow_lists_match_the_shared_schema() {
        assert_eq!(ALLOWED_UI_DEFAULT_VIEWS.len(), 21);
        assert!(is_allowed_ui_default_view("dashboard"));
        assert!(is_allowed_ui_default_view("agent-room"));
        assert!(!is_allowed_ui_default_view("nope"));
        assert!(is_allowed_ui_density("compact"));
        assert!(!is_allowed_ui_density("cozy"));
        assert!(is_allowed_ui_time_format("12h"));
        assert!(!is_allowed_ui_time_format("24H"));
    }
}
