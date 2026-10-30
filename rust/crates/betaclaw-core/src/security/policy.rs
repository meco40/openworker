//! Effective policy snapshot.
//!
//! Port of `buildEffectivePolicyExplainSnapshot()` in
//! `src/server/security/policyExplain.ts`. The snapshot is derived from the
//! gateway configuration, which lives in `.local/gateway-config.db`.

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
pub struct EffectivePolicyExplainSnapshot {
    #[serde(rename = "generatedAt")]
    pub generated_at: String,
    pub revision: String,
    pub source: String,
    pub runtime: RuntimeInfo,
    pub channels: ChannelFlags,
    pub tools: ToolFlags,
}

#[derive(Debug, Clone, Serialize)]
pub struct RuntimeInfo {
    pub mode: &'static str,
    #[serde(rename = "workerRemoved")]
    pub worker_removed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChannelFlags {
    #[serde(rename = "webchatEnabled")]
    pub webchat_enabled: bool,
    #[serde(rename = "telegramEnabled")]
    pub telegram_enabled: bool,
    #[serde(rename = "slackEnabled")]
    pub slack_enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolFlags {
    #[serde(rename = "browserManaged")]
    pub browser_managed: bool,
    #[serde(rename = "browserHeadless")]
    pub browser_headless: bool,
    #[serde(rename = "sandboxEnabled")]
    pub sandbox_enabled: bool,
    #[serde(rename = "sandboxType")]
    pub sandbox_type: Option<String>,
}

fn nested<'a>(root: &'a Value, key: &str) -> Option<&'a Value> {
    root.get(key).filter(|value| value.is_object())
}

fn boolean(root: Option<&Value>, key: &str) -> bool {
    root.and_then(|value| value.get(key))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn string(root: Option<&Value>, key: &str) -> Option<String> {
    root.and_then(|value| value.get(key))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// Builds the snapshot from a loaded gateway configuration.
///
/// `revision` and `source` come from the configuration loader
/// (`src/server/config/gateway/gatewayConfig.ts`).
pub fn build_effective_policy_explain_snapshot(
    config: &Value,
    revision: &str,
    source: &str,
) -> EffectivePolicyExplainSnapshot {
    let channels = nested(config, "channels");
    let tools = nested(config, "tools");

    let webchat = channels.and_then(|value| nested(value, "webchat"));
    let telegram = channels.and_then(|value| nested(value, "telegram"));
    let slack = channels.and_then(|value| nested(value, "slack"));
    let browser = tools.and_then(|value| nested(value, "browser"));
    let sandbox = tools.and_then(|value| nested(value, "sandbox"));

    EffectivePolicyExplainSnapshot {
        generated_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        revision: revision.to_string(),
        source: source.to_string(),
        runtime: RuntimeInfo {
            mode: "main-chat-only",
            worker_removed: true,
        },
        channels: ChannelFlags {
            webchat_enabled: boolean(webchat, "enabled"),
            telegram_enabled: boolean(telegram, "enabled"),
            slack_enabled: boolean(slack, "enabled"),
        },
        tools: ToolFlags {
            browser_managed: boolean(browser, "managed"),
            browser_headless: boolean(browser, "headless"),
            sandbox_enabled: boolean(sandbox, "enabled"),
            sandbox_type: string(sandbox, "type"),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_flags_from_config() {
        let config = json!({
            "channels": {
                "webchat": { "enabled": true },
                "telegram": { "enabled": true },
                "slack": { "enabled": false }
            },
            "tools": {
                "browser": { "managed": true, "headless": false },
                "sandbox": { "enabled": true, "type": "docker" }
            }
        });
        let snapshot = build_effective_policy_explain_snapshot(&config, "abc123", "db");
        assert_eq!(snapshot.revision, "abc123");
        assert_eq!(snapshot.source, "db");
        assert!(snapshot.channels.webchat_enabled);
        assert!(snapshot.channels.telegram_enabled);
        assert!(!snapshot.channels.slack_enabled);
        assert!(snapshot.tools.browser_managed);
        assert!(!snapshot.tools.browser_headless);
        assert!(snapshot.tools.sandbox_enabled);
        assert_eq!(snapshot.tools.sandbox_type.as_deref(), Some("docker"));
        assert_eq!(snapshot.runtime.mode, "main-chat-only");
        assert!(snapshot.runtime.worker_removed);
    }

    #[test]
    fn missing_sections_default_to_disabled() {
        let snapshot = build_effective_policy_explain_snapshot(&json!({}), "rev", "default");
        assert!(!snapshot.channels.webchat_enabled);
        assert!(!snapshot.tools.sandbox_enabled);
        assert!(snapshot.tools.sandbox_type.is_none());
    }

    #[test]
    fn non_boolean_values_fall_back_to_false() {
        let config = json!({ "channels": { "webchat": { "enabled": "yes" } } });
        let snapshot = build_effective_policy_explain_snapshot(&config, "rev", "db");
        assert!(!snapshot.channels.webchat_enabled);
    }

    #[test]
    fn serializes_with_contract_field_names() {
        let snapshot = build_effective_policy_explain_snapshot(&json!({}), "rev", "db");
        let value = serde_json::to_value(&snapshot).unwrap();

        assert!(value["generatedAt"].is_string());
        assert_eq!(value["revision"], "rev");
        assert_eq!(value["source"], "db");

        // Channel and tool flags are nested, exactly as the UI reads them.
        for field in ["webchatEnabled", "telegramEnabled", "slackEnabled"] {
            assert!(
                value["channels"].get(field).is_some(),
                "channels.{field} must be present"
            );
        }
        for field in [
            "browserManaged",
            "browserHeadless",
            "sandboxEnabled",
            "sandboxType",
        ] {
            assert!(
                value["tools"].get(field).is_some(),
                "tools.{field} must be present"
            );
        }
        assert_eq!(value["runtime"]["mode"], "main-chat-only");
        assert_eq!(value["runtime"]["workerRemoved"], true);
    }
}
