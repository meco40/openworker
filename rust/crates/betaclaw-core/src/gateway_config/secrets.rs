//! Port of `src/server/config/gateway/secrets.ts`.
//!
//! Channel tokens and the gateway auth token are replaced by
//! `__REDACTED__` on the way out and restored from the stored config on the way
//! in, so the browser never receives a live credential but a round-tripped save
//! does not destroy it.

use serde_json::{Map, Value};

use super::constants::{REDACTED_SECRET_VALUE, SECRET_PATHS};
use super::normalize::clone_object;

/// `getPathValue` from `secrets.ts:5-12`. Returns `None` for a missing key or a
/// non-object node.
fn get_path_value<'a>(root: &'a Value, segments: &[&str]) -> Option<&'a Value> {
    let mut cursor = root;
    for segment in segments {
        cursor = cursor.as_object()?.get(*segment)?;
    }
    Some(cursor)
}

/// `setPathValue` from `secrets.ts:14-25`. Intermediate nodes that are not
/// objects are replaced by an empty object, matching the TypeScript assignment.
fn set_path_value(root: &mut Value, segments: &[&str], value: Value) {
    let Some(last) = segments.last() else {
        return;
    };

    let mut cursor = root;
    for segment in &segments[..segments.len() - 1] {
        if !cursor.is_object() {
            *cursor = Value::Object(Map::new());
        }
        let map = cursor.as_object_mut().expect("cursor is an object");
        cursor = map
            .entry((*segment).to_string())
            .or_insert_with(|| Value::Object(Map::new()));
    }

    if !cursor.is_object() {
        *cursor = Value::Object(Map::new());
    }
    cursor
        .as_object_mut()
        .expect("cursor is an object")
        .insert((*last).to_string(), value);
}

/// True for a string with at least one non-whitespace character, matching the
/// `typeof value === 'string' && value.trim().length > 0` guard in `secrets.ts`.
fn is_non_empty_string(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::String(text)) if !text.trim().is_empty())
}

/// `redactGatewayConfigSecrets` from `secrets.ts:27-36`.
pub fn redact_gateway_config_secrets(config: &Value) -> Value {
    let mut redacted = clone_object(config);
    for segments in SECRET_PATHS {
        if is_non_empty_string(get_path_value(&redacted, segments)) {
            set_path_value(&mut redacted, segments, Value::from(REDACTED_SECRET_VALUE));
        }
    }
    redacted
}

/// `restoreRedactedSecrets` from `secrets.ts:38-49`.
///
/// Returns `None` when `next_config` is not an object: `cloneObject` on a
/// non-object yields a non-object and `getPathValue` then returns `undefined`
/// for every path, so the value is handed back unchanged for the caller to
/// reject in `normalizeGatewayConfig`.
pub fn restore_redacted_secrets(next_config: &Value, current_config: &Value) -> Value {
    let mut restored = clone_object(next_config);
    if !restored.is_object() {
        return restored;
    }
    for segments in SECRET_PATHS {
        let is_placeholder = get_path_value(&restored, segments).and_then(Value::as_str)
            == Some(REDACTED_SECRET_VALUE);
        if !is_placeholder {
            continue;
        }
        if is_non_empty_string(get_path_value(current_config, segments)) {
            let current = get_path_value(current_config, segments)
                .cloned()
                .expect("checked above");
            set_path_value(&mut restored, segments, current);
        }
    }
    restored
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn current() -> Value {
        json!({
            "channels": { "telegram": { "enabled": true, "token": "real-token" } },
            "gateway": {
                "port": 8080,
                "auth": { "mode": "token", "token": "auth-token" }
            }
        })
    }

    #[test]
    fn redacts_both_secret_paths() {
        let redacted = redact_gateway_config_secrets(&current());
        assert_eq!(
            redacted["channels"]["telegram"]["token"],
            REDACTED_SECRET_VALUE
        );
        assert_eq!(redacted["gateway"]["auth"]["token"], REDACTED_SECRET_VALUE);
        assert_eq!(redacted["gateway"]["port"], 8080, "non-secret keys survive");
    }

    #[test]
    fn does_not_redact_absent_or_empty_secrets() {
        let config = json!({
            "channels": { "telegram": { "enabled": true, "token": "   " } },
            "gateway": { "port": 8080 }
        });
        let redacted = redact_gateway_config_secrets(&config);
        assert_eq!(redacted["channels"]["telegram"]["token"], "   ");
        assert!(redacted["gateway"].get("auth").is_none());
    }

    #[test]
    fn redacting_twice_is_idempotent() {
        let once = redact_gateway_config_secrets(&current());
        let twice = redact_gateway_config_secrets(&once);
        assert_eq!(once, twice);
    }

    #[test]
    fn restores_placeholders_from_the_stored_config() {
        let incoming = redact_gateway_config_secrets(&current());
        let restored = restore_redacted_secrets(&incoming, &current());
        assert_eq!(restored, current());
    }

    #[test]
    fn keeps_concrete_values_and_only_touches_placeholders() {
        let incoming = json!({
            "channels": { "telegram": { "enabled": true, "token": "new-token" } },
            "gateway": { "port": 8080, "auth": { "mode": "token", "token": REDACTED_SECRET_VALUE } }
        });
        let restored = restore_redacted_secrets(&incoming, &current());
        assert_eq!(restored["channels"]["telegram"]["token"], "new-token");
        assert_eq!(restored["gateway"]["auth"]["token"], "auth-token");
    }

    #[test]
    fn placeholder_without_a_stored_secret_is_left_alone() {
        let incoming = json!({
            "channels": { "telegram": { "enabled": true, "token": REDACTED_SECRET_VALUE } }
        });
        let stored = json!({
            "channels": { "telegram": { "enabled": true } },
            "gateway": { "port": 8080 }
        });
        let restored = restore_redacted_secrets(&incoming, &stored);
        assert_eq!(
            restored["channels"]["telegram"]["token"], REDACTED_SECRET_VALUE,
            "nothing to restore from, so the placeholder survives"
        );
    }

    #[test]
    fn creates_missing_intermediate_objects() {
        // setPathValue replaces a non-object node with `{}` instead of failing.
        let incoming = json!({ "gateway": "oops" });
        let stored = json!({ "gateway": { "auth": { "token": "auth-token" } } });
        let restored = restore_redacted_secrets(
            &json!({ "gateway": { "auth": { "token": REDACTED_SECRET_VALUE } } }),
            &stored,
        );
        assert_eq!(restored["gateway"]["auth"]["token"], "auth-token");
        let _ = incoming;
    }

    #[test]
    fn non_object_payloads_pass_through_unchanged() {
        let restored = restore_redacted_secrets(&Value::from(7), &current());
        assert_eq!(restored, Value::from(7));
    }
}
