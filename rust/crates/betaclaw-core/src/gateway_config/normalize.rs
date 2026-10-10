//! Port of `src/server/config/gateway/normalize.ts`.
//!
//! `normalizeGatewayConfig` is the validation boundary for the gateway config.
//! In `load` mode it repairs invalid values and appends a
//! [`GatewayConfigWarning`]; in `save` mode it rejects them with a
//! [`GatewayConfigError::Validation`]. The order in which sections are checked is
//! preserved, because the first failing check decides the error message.

use serde_json::{Map, Value};

use super::constants::{
    is_allowed_ui_default_view, is_allowed_ui_density, is_allowed_ui_time_format,
    ALLOWED_LOG_LEVELS, ALLOWED_UI_DEFAULT_VIEWS,
};
use super::types::{GatewayConfigError, GatewayConfigWarning, NormalizeMode};

/// Return value of [`normalize_gateway_config`].
#[derive(Debug, Clone)]
pub struct NormalizationResult {
    pub config: Value,
    pub warnings: Vec<GatewayConfigWarning>,
}

/// `cloneObject` from `normalize.ts:16-18`.
///
/// `JSON.parse(JSON.stringify(value))` drops `undefined` and non-JSON values.
/// `serde_json::Value` never holds those, so an owned clone is equivalent.
pub fn clone_object(value: &Value) -> Value {
    value.clone()
}

/// `cloneDefaultConfig` from `normalize.ts:20-22`.
pub fn clone_default_config() -> Value {
    super::constants::default_gateway_config()
}

/// `Number.isInteger` semantics for a JSON value.
///
/// `serde_json` stores `80.0` as a float where JavaScript would have collapsed it
/// to the integer `80` during `JSON.parse`, so an integral float is accepted.
fn exact_integer(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Number(number) => number.as_i64().or_else(|| {
            let float = number.as_f64()?;
            (float.is_finite() && float.fract() == 0.0).then_some(float as i64)
        }),
        _ => None,
    }
}

/// `ensureObject` from `normalize.ts:24-29`.
fn ensure_object<'a>(
    value: Option<&'a Value>,
    label: &str,
) -> Result<&'a Map<String, Value>, GatewayConfigError> {
    match value {
        Some(Value::Object(map)) => Ok(map),
        _ => Err(GatewayConfigError::validation(format!(
            "{label} must be an object."
        ))),
    }
}
/// Mutable variant of [`ensure_object`]; `normalize.ts` mutates in place.
fn ensure_object_mut<'a>(
    value: &'a mut Value,
    label: &str,
) -> Result<&'a mut Map<String, Value>, GatewayConfigError> {
    match value {
        Value::Object(map) => Ok(map),
        _ => Err(GatewayConfigError::validation(format!(
            "{label} must be an object."
        ))),
    }
}

/// `ensureString` from `normalize.ts:31-36`.
fn ensure_string(value: Option<&Value>, label: &str) -> Result<String, GatewayConfigError> {
    match value {
        Some(Value::String(text)) if !text.trim().is_empty() => Ok(text.trim().to_string()),
        _ => Err(GatewayConfigError::validation(format!(
            "{label} must be a non-empty string."
        ))),
    }
}

/// `ensureOptionalString` from `normalize.ts:38-41`.
///
/// Only an absent key is optional; an explicit JSON `null` fails the check,
/// exactly like `typeof null !== 'string'` in TypeScript.
fn ensure_optional_string(
    value: Option<&Value>,
    label: &str,
) -> Result<Option<String>, GatewayConfigError> {
    match value {
        None => Ok(None),
        other => ensure_string(other, label).map(Some),
    }
}

/// `ensureBoolean` from `normalize.ts:43-48`.
fn ensure_boolean(value: Option<&Value>, label: &str) -> Result<bool, GatewayConfigError> {
    match value {
        Some(Value::Bool(flag)) => Ok(*flag),
        _ => Err(GatewayConfigError::validation(format!(
            "{label} must be a boolean."
        ))),
    }
}

/// `ensureIntInRange` from `normalize.ts:50-57`.
fn ensure_int_in_range(
    value: Option<&Value>,
    label: &str,
    min: i64,
    max: i64,
) -> Result<i64, GatewayConfigError> {
    match exact_integer(value) {
        Some(number) if number >= min && number <= max => Ok(number),
        _ => Err(GatewayConfigError::validation(format!(
            "{label} must be an integer between {min} and {max}."
        ))),
    }
}

/// `normalizeHostFromBind` from `normalize.ts:59-63`.
fn normalize_host_from_bind(bind: &str) -> String {
    match bind {
        "loopback" => "127.0.0.1".to_string(),
        "all" => "0.0.0.0".to_string(),
        other => other.to_string(),
    }
}

/// `normalizeBindFromHost` from `normalize.ts:65-69`.
fn normalize_bind_from_host(host: &str) -> String {
    match host {
        "127.0.0.1" | "localhost" => "loopback".to_string(),
        "0.0.0.0" => "all".to_string(),
        other => other.to_string(),
    }
}

/// `withWarning` from `normalize.ts:71-73`.
fn with_warning(warnings: &mut Vec<GatewayConfigWarning>, code: &str, message: String) {
    warnings.push(GatewayConfigWarning::new(code, message));
}

/// Non-empty trimmed string of an optional value, mirroring the
/// `typeof x === 'string' ? x.trim() : ''` idiom used throughout `normalizeUiConfig`.
fn trimmed_or_empty(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.trim().to_string(),
        _ => String::new(),
    }
}

/// `normalizeUiConfig` from `normalize.ts:75-168`.
fn normalize_ui_config(
    ui: &mut Map<String, Value>,
    mode: NormalizeMode,
    warnings: &mut Vec<GatewayConfigWarning>,
) -> Result<(), GatewayConfigError> {
    if let Some(existing) = ui.get("defaultView") {
        let raw = trimmed_or_empty(Some(existing));
        if raw.is_empty() {
            if mode == NormalizeMode::Save {
                return Err(GatewayConfigError::validation(
                    "ui.defaultView must be a non-empty string.",
                ));
            }
            ui.insert("defaultView".into(), Value::from("dashboard"));
            with_warning(
                warnings,
                "ui.defaultView.defaulted_from_invalid",
                "ui.defaultView was invalid. Defaulted to dashboard.".to_string(),
            );
        } else if !is_allowed_ui_default_view(&raw) {
            if mode == NormalizeMode::Save {
                return Err(GatewayConfigError::validation(format!(
                    "ui.defaultView must be one of: {}.",
                    ALLOWED_UI_DEFAULT_VIEWS.join(", ")
                )));
            }
            ui.insert("defaultView".into(), Value::from("dashboard"));
            with_warning(
                warnings,
                "ui.defaultView.defaulted_from_invalid",
                format!("ui.defaultView ({raw}) is unsupported. Defaulted to dashboard."),
            );
        } else {
            ui.insert("defaultView".into(), Value::from(raw));
        }
    }

    if let Some(existing) = ui.get("density") {
        let density = trimmed_or_empty(Some(existing));
        if density.is_empty() || !is_allowed_ui_density(&density) {
            if mode == NormalizeMode::Save {
                return Err(GatewayConfigError::validation(
                    "ui.density must be one of: comfortable, compact.",
                ));
            }
            ui.insert("density".into(), Value::from("comfortable"));
            with_warning(
                warnings,
                "ui.density.defaulted_from_invalid",
                "ui.density was invalid. Defaulted to comfortable.".to_string(),
            );
        } else {
            ui.insert("density".into(), Value::from(density));
        }
    }

    if let Some(existing) = ui.get("language") {
        let language = trimmed_or_empty(Some(existing));
        if language.is_empty() {
            if mode == NormalizeMode::Save {
                return Err(GatewayConfigError::validation(
                    "ui.language must be a non-empty string.",
                ));
            }
            ui.insert("language".into(), Value::from("de-DE"));
            with_warning(
                warnings,
                "ui.language.defaulted_from_invalid",
                "ui.language was invalid. Defaulted to de-DE.".to_string(),
            );
        } else {
            ui.insert("language".into(), Value::from(language));
        }
    }

    if let Some(existing) = ui.get("timeFormat") {
        let time_format = trimmed_or_empty(Some(existing));
        if time_format.is_empty() || !is_allowed_ui_time_format(&time_format) {
            if mode == NormalizeMode::Save {
                return Err(GatewayConfigError::validation(
                    "ui.timeFormat must be one of: 12h, 24h.",
                ));
            }
            ui.insert("timeFormat".into(), Value::from("24h"));
            with_warning(
                warnings,
                "ui.timeFormat.defaulted_from_invalid",
                "ui.timeFormat was invalid. Defaulted to 24h.".to_string(),
            );
        } else {
            ui.insert("timeFormat".into(), Value::from(time_format));
        }
    }

    if let Some(existing) = ui.get("showAdvancedDebug") {
        if !matches!(existing, Value::Bool(_)) {
            if mode == NormalizeMode::Save {
                return Err(GatewayConfigError::validation(
                    "ui.showAdvancedDebug must be a boolean.",
                ));
            }
            ui.insert("showAdvancedDebug".into(), Value::Bool(false));
            with_warning(
                warnings,
                "ui.showAdvancedDebug.defaulted_from_invalid",
                "ui.showAdvancedDebug was invalid. Defaulted to false.".to_string(),
            );
        }
    }

    Ok(())
}

/// `normalizeGatewayConfig` from `normalize.ts:170-288`.
pub fn normalize_gateway_config(
    raw_config: &Value,
    mode: NormalizeMode,
) -> Result<NormalizationResult, GatewayConfigError> {
    let mut warnings: Vec<GatewayConfigWarning> = Vec::new();
    let mut root = clone_object(raw_config);
    ensure_object(Some(&root), "config")?;

    // ── gateway ────────────────────────────────────────────────────────────
    {
        let gateway_value = root
            .get_mut("gateway")
            .ok_or_else(|| GatewayConfigError::validation("gateway must be an object."))?;
        let gateway = ensure_object_mut(gateway_value, "gateway")?;
        ensure_int_in_range(gateway.get("port"), "gateway.port", 1, 65535)?;

        let mut host = match gateway.get("host") {
            Some(Value::String(text)) if !text.trim().is_empty() => Some(text.trim().to_string()),
            _ => None,
        };
        let mut bind = match gateway.get("bind") {
            Some(Value::String(text)) if !text.trim().is_empty() => Some(text.trim().to_string()),
            _ => None,
        };

        if let (Some(current_host), None) = (host.as_ref(), bind.as_ref()) {
            bind = Some(normalize_bind_from_host(current_host));
            with_warning(
                &mut warnings,
                "gateway.bind.derived_from_host",
                format!(
                    "gateway.bind was missing. Derived from gateway.host ({current_host}) => {}.",
                    bind.as_deref().unwrap_or_default()
                ),
            );
        }
        if let (None, Some(current_bind)) = (host.as_ref(), bind.as_ref()) {
            host = Some(normalize_host_from_bind(current_bind));
            with_warning(
                &mut warnings,
                "gateway.host.derived_from_bind",
                format!(
                    "gateway.host was missing. Derived from gateway.bind ({current_bind}) => {}.",
                    host.as_deref().unwrap_or_default()
                ),
            );
        }
        if host.is_none() && bind.is_none() {
            host = Some("127.0.0.1".to_string());
            bind = Some("loopback".to_string());
            with_warning(
                &mut warnings,
                "gateway.host_bind.defaulted",
                "gateway.host and gateway.bind were missing. Defaulted to 127.0.0.1/loopback."
                    .to_string(),
            );
        }

        gateway.insert("host".into(), Value::from(host.unwrap_or_default()));
        gateway.insert("bind".into(), Value::from(bind.unwrap_or_default()));

        let log_level_raw = gateway.get("logLevel").cloned();
        let log_level = match &log_level_raw {
            Some(Value::String(text)) if !text.trim().is_empty() => text.trim().to_string(),
            _ => "info".to_string(),
        };
        if log_level_raw.is_none() {
            with_warning(
                &mut warnings,
                "gateway.logLevel.defaulted",
                "gateway.logLevel was missing. Defaulted to info.".to_string(),
            );
        }
        if !ALLOWED_LOG_LEVELS.contains(&log_level.as_str()) {
            return Err(GatewayConfigError::validation(
                "gateway.logLevel must be one of: debug, info, warn, error.",
            ));
        }
        gateway.insert("logLevel".into(), Value::from(log_level));
    }

    // ── provider ───────────────────────────────────────────────────────────
    if let Some(provider_value) = root.get_mut("provider") {
        let provider = ensure_object_mut(provider_value, "provider")?;
        ensure_string(provider.get("primary"), "provider.primary")?;
        ensure_optional_string(provider.get("fallback"), "provider.fallback")?;
        if provider.get("rotation").is_some() {
            ensure_boolean(provider.get("rotation"), "provider.rotation")?;
        }
    }

    // ── channels ───────────────────────────────────────────────────────────
    if let Some(channels_value) = root.get_mut("channels") {
        match channels_value {
            Value::Object(channels) => {
                if let Some(value) = channels.get_mut("webchat") {
                    let webchat = ensure_object_mut(value, "channels.webchat")?;
                    ensure_boolean(webchat.get("enabled"), "channels.webchat.enabled")?;
                }
                if let Some(value) = channels.get_mut("telegram") {
                    let telegram = ensure_object_mut(value, "channels.telegram")?;
                    ensure_boolean(telegram.get("enabled"), "channels.telegram.enabled")?;
                    ensure_optional_string(telegram.get("token"), "channels.telegram.token")?;
                }
                if let Some(value) = channels.get_mut("slack") {
                    let slack = ensure_object_mut(value, "channels.slack")?;
                    ensure_boolean(slack.get("enabled"), "channels.slack.enabled")?;
                }
            }
            _ => {
                return Err(GatewayConfigError::validation(
                    "channels must be an object.",
                ))
            }
        }
    }

    // ── tools ──────────────────────────────────────────────────────────────
    if let Some(tools_value) = root.get_mut("tools") {
        match tools_value {
            Value::Object(tools) => {
                if let Some(value) = tools.get_mut("browser") {
                    let browser = ensure_object_mut(value, "tools.browser")?;
                    ensure_boolean(browser.get("managed"), "tools.browser.managed")?;
                    ensure_boolean(browser.get("headless"), "tools.browser.headless")?;
                }
                if let Some(value) = tools.get_mut("sandbox") {
                    let sandbox = ensure_object_mut(value, "tools.sandbox")?;
                    ensure_string(sandbox.get("type"), "tools.sandbox.type")?;
                    ensure_boolean(sandbox.get("enabled"), "tools.sandbox.enabled")?;
                }
            }
            _ => return Err(GatewayConfigError::validation("tools must be an object.")),
        }
    }

    // ── ui ─────────────────────────────────────────────────────────────────
    // The TypeScript source validates `ui` before `gateway.auth`, so a config
    // with both sections broken reports the `ui` error first.
    if let Some(ui_value) = root.get_mut("ui") {
        let ui = ensure_object_mut(ui_value, "ui")?;
        normalize_ui_config(ui, mode, &mut warnings)?;
    }

    // ── gateway.auth / gateway.tailscale ──────────────────────────────────
    {
        let gateway_value = root
            .get_mut("gateway")
            .ok_or_else(|| GatewayConfigError::validation("gateway must be an object."))?;
        let gateway = ensure_object_mut(gateway_value, "gateway")?;

        if let Some(value) = gateway.get_mut("auth") {
            let auth = ensure_object_mut(value, "gateway.auth")?;
            ensure_string(auth.get("mode"), "gateway.auth.mode")?;
            ensure_optional_string(auth.get("token"), "gateway.auth.token")?;
        }
        if let Some(value) = gateway.get_mut("tailscale") {
            let tailscale = ensure_object_mut(value, "gateway.tailscale")?;
            ensure_string(tailscale.get("mode"), "gateway.tailscale.mode")?;
            if tailscale.get("resetOnExit").is_some() {
                ensure_boolean(
                    tailscale.get("resetOnExit"),
                    "gateway.tailscale.resetOnExit",
                )?;
            }
        }
    }

    Ok(NormalizationResult {
        config: root,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn load(value: &Value) -> Result<NormalizationResult, GatewayConfigError> {
        normalize_gateway_config(value, NormalizeMode::Load)
    }

    fn save(value: &Value) -> Result<NormalizationResult, GatewayConfigError> {
        normalize_gateway_config(value, NormalizeMode::Save)
    }

    fn error_message(result: Result<NormalizationResult, GatewayConfigError>) -> String {
        match result {
            Ok(_) => panic!("expected a validation error"),
            Err(error) => error.to_string(),
        }
    }

    fn warning_codes(result: &NormalizationResult) -> Vec<&str> {
        result
            .warnings
            .iter()
            .map(|warning| warning.code.as_str())
            .collect()
    }

    #[test]
    fn accepts_the_default_config_without_warnings() {
        let result = load(&clone_default_config()).expect("default config is valid");
        assert!(result.warnings.is_empty());
        assert_eq!(result.config, clone_default_config());
    }

    #[test]
    fn rejects_non_object_config() {
        assert_eq!(
            error_message(load(&json_value(1))),
            "config must be an object."
        );
        assert_eq!(
            error_message(load(&Value::Array(vec![]))),
            "config must be an object."
        );
    }

    fn json_value(raw: i64) -> Value {
        Value::from(raw)
    }

    #[test]
    fn requires_the_gateway_section() {
        assert_eq!(
            error_message(load(&serde_json::json!({}))),
            "gateway must be an object."
        );
        assert_eq!(
            error_message(load(&serde_json::json!({ "gateway": "nope" }))),
            "gateway must be an object."
        );
    }

    #[test]
    fn validates_the_port_range() {
        let rejected = [
            Value::from(0i64),
            Value::from(65536i64),
            serde_json::json!(80.5),
            Value::String("8080".into()),
        ];
        for port in rejected {
            let config = serde_json::json!({ "gateway": { "port": port } });
            assert_eq!(
                error_message(load(&config)),
                "gateway.port must be an integer between 1 and 65535.",
                "port must be rejected"
            );
        }
        let result =
            load(&serde_json::json!({ "gateway": { "port": 1 } })).expect("port 1 allowed");
        assert_eq!(result.config["gateway"]["port"], 1);
    }

    #[test]
    fn derives_bind_from_host_and_warns() {
        let result = load(&serde_json::json!({ "gateway": { "port": 80, "host": "127.0.0.1", "logLevel": "info" } }))
            .expect("host only config");
        assert_eq!(result.config["gateway"]["bind"], "loopback");
        assert_eq!(
            warning_codes(&result),
            vec!["gateway.bind.derived_from_host"]
        );
        assert_eq!(
            result.warnings[0].message,
            "gateway.bind was missing. Derived from gateway.host (127.0.0.1) => loopback."
        );
    }

    #[test]
    fn derives_host_from_bind_and_warns() {
        let result = load(
            &serde_json::json!({ "gateway": { "port": 80, "bind": "all", "logLevel": "info" } }),
        )
        .expect("bind only config");
        assert_eq!(result.config["gateway"]["host"], "0.0.0.0");
        assert_eq!(
            warning_codes(&result),
            vec!["gateway.host.derived_from_bind"]
        );
    }

    #[test]
    fn defaults_host_and_bind_together() {
        let result = load(&serde_json::json!({ "gateway": { "port": 80, "logLevel": "info" } }))
            .expect("bare gateway");
        assert_eq!(result.config["gateway"]["host"], "127.0.0.1");
        assert_eq!(result.config["gateway"]["bind"], "loopback");
        assert_eq!(warning_codes(&result), vec!["gateway.host_bind.defaulted"]);
    }

    #[test]
    fn defaults_log_level_only_when_the_key_is_absent() {
        let missing = load(&serde_json::json!({ "gateway": { "port": 80 } })).expect("no logLevel");
        assert!(missing
            .warnings
            .iter()
            .any(|warning| warning.code == "gateway.logLevel.defaulted"));

        // An explicit `null` does not produce the "missing" warning, matching
        // `logLevelRaw === undefined` in normalize.ts:219.
        let explicit_null =
            load(&serde_json::json!({ "gateway": { "port": 80, "logLevel": Value::Null } }))
                .expect("null logLevel falls back to info");
        assert_eq!(explicit_null.config["gateway"]["logLevel"], "info");
        assert!(!explicit_null
            .warnings
            .iter()
            .any(|warning| warning.code == "gateway.logLevel.defaulted"));
    }

    #[test]
    fn rejects_an_unknown_log_level_in_both_modes() {
        let config = serde_json::json!({ "gateway": { "port": 80, "logLevel": "verbose" } });
        let expected = "gateway.logLevel must be one of: debug, info, warn, error.";
        assert_eq!(error_message(load(&config)), expected);
        assert_eq!(error_message(save(&config)), expected);
    }

    #[test]
    fn validates_provider_channels_and_tools() {
        assert_eq!(
            error_message(load(&serde_json::json!({
                "gateway": { "port": 80 },
                "provider": { "primary": "  " }
            }))),
            "provider.primary must be a non-empty string."
        );
        assert_eq!(
            error_message(load(&serde_json::json!({
                "gateway": { "port": 80 },
                "provider": { "primary": "p", "rotation": "yes" }
            }))),
            "provider.rotation must be a boolean."
        );
        assert_eq!(
            error_message(load(&serde_json::json!({
                "gateway": { "port": 80 },
                "channels": { "telegram": { "enabled": true, "token": Value::Null } }
            }))),
            "channels.telegram.token must be a non-empty string."
        );
        assert_eq!(
            error_message(load(&serde_json::json!({
                "gateway": { "port": 80 },
                "tools": { "sandbox": { "type": "docker" } }
            }))),
            "tools.sandbox.enabled must be a boolean."
        );
    }

    #[test]
    fn validates_gateway_auth_and_tailscale() {
        assert_eq!(
            error_message(load(&serde_json::json!({
                "gateway": { "port": 80, "auth": { "token": "t" } }
            }))),
            "gateway.auth.mode must be a non-empty string."
        );
        assert_eq!(
            error_message(load(&serde_json::json!({
                "gateway": { "port": 80, "tailscale": { "mode": "off", "resetOnExit": 1 } }
            }))),
            "gateway.tailscale.resetOnExit must be a boolean."
        );
        let ok = load(&serde_json::json!({
            "gateway": {
                "port": 80,
                "host": "0.0.0.0",
                "bind": "all",
                "logLevel": "info",
                "auth": { "mode": "token", "token": "abc" },
                "tailscale": { "mode": "on", "resetOnExit": true }
            }
        }))
        .expect("auth and tailscale are valid");
        assert!(
            ok.warnings.is_empty(),
            "a fully specified config produces no warnings, got {:?}",
            warning_codes(&ok)
        );
    }

    #[test]
    fn repairs_ui_values_on_load_and_rejects_them_on_save() {
        let broken = serde_json::json!({
            "gateway": { "port": 80, "host": "0.0.0.0", "bind": "all", "logLevel": "info" },
            "ui": {
                "defaultView": "does-not-exist",
                "density": "cozy",
                "language": 5,
                "timeFormat": "36h",
                "showAdvancedDebug": "true"
            }
        });

        let repaired = load(&broken).expect("load repairs");
        assert_eq!(repaired.config["ui"]["defaultView"], "dashboard");
        assert_eq!(repaired.config["ui"]["density"], "comfortable");
        assert_eq!(repaired.config["ui"]["language"], "de-DE");
        assert_eq!(repaired.config["ui"]["timeFormat"], "24h");
        assert_eq!(repaired.config["ui"]["showAdvancedDebug"], false);
        assert_eq!(
            warning_codes(&repaired),
            vec![
                "ui.defaultView.defaulted_from_invalid",
                "ui.density.defaulted_from_invalid",
                "ui.language.defaulted_from_invalid",
                "ui.timeFormat.defaulted_from_invalid",
                "ui.showAdvancedDebug.defaulted_from_invalid",
            ]
        );

        assert_eq!(
            error_message(save(&broken)),
            "ui.defaultView must be one of: dashboard, chat, config, skills, channels, logs, stats, security, profile, tasks, models, personas, memory, knowledge, cron, instances, sessions, nodes, debugger, master, agent-room."
        );
    }

    #[test]
    fn ui_is_checked_before_gateway_auth() {
        // Order matters: normalize.ts calls normalizeUiConfig at line 273 and the
        // gateway.auth block at line 275.
        let config = serde_json::json!({
            "gateway": { "port": 80, "logLevel": "info", "auth": {} },
            "ui": { "density": "cozy" }
        });
        assert_eq!(
            error_message(save(&config)),
            "ui.density must be one of: comfortable, compact."
        );
    }

    #[test]
    fn ui_warnings_name_the_offending_value() {
        let result = load(&serde_json::json!({
            "gateway": { "port": 80, "host": "0.0.0.0", "bind": "all", "logLevel": "info" },
            "ui": { "defaultView": "nope" }
        }))
        .expect("load repairs");
        assert_eq!(
            result.warnings[0].message,
            "ui.defaultView (nope) is unsupported. Defaulted to dashboard."
        );
    }

    #[test]
    fn normalisation_does_not_mutate_the_input() {
        let input = clone_default_config();
        let before = input.clone();
        let _ = load(&input).expect("valid");
        assert_eq!(input, before);
    }

    #[test]
    fn rewrite_of_existing_keys_keeps_their_position() {
        // `gateway.host = host` in normalize.ts:213 updates an existing key in
        // place, it does not append. The revision hash depends on that order.
        let result = load(&clone_default_config()).expect("valid");
        let keys: Vec<&String> = result.config["gateway"]
            .as_object()
            .expect("gateway object")
            .keys()
            .collect();
        assert_eq!(keys, vec!["port", "host", "bind", "logLevel"]);
    }
}
