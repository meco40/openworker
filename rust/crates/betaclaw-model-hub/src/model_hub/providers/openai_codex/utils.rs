//! Port of `src/server/model-hub/Models/openai-codex/utils/typeGuards.ts` and
//! `.../utils/models.ts`.
//!
//! | Rust | TypeScript |
//! | --- | --- |
//! | [`to_non_empty_string`] | `toNonEmptyString` (`typeGuards.ts:1-3`) |
//! | [`to_string_or_null`] | `toStringOrNull` (`typeGuards.ts:5-7`) |
//! | [`to_number_or_null`] | `toNumberOrNull` (`typeGuards.ts:9-11`) |
//! | [`map_default_models`] | `mapDefaultModels` (`utils/models.ts:4-10`) |
//! | [`merge_unique_models`] | `mergeUniqueModels` (`utils/models.ts:12-24`) |
//! | [`build_codex_seed_models`] | `buildCodexSeedModels` (`utils/models.ts:26-29`) |
//! | [`is_truthy`] | the truthiness checks of `requestMapper.ts:22` |
//! | [`js_string_value`] | `String(typed.json_schema.name)` (`requestMapper.ts:25`) |
//! | [`js_int`] | the `GatewayUsage` number fields |
//!
//! The three guards accept `Option<&Value>` rather than `&Value`, because every
//! call site in the TypeScript is a property read or an optional chain that can
//! be absent.

use serde_json::Value;

use super::constants::CODEX_MODEL_SEED;
use crate::model_hub::types::FetchedModel;

/// `toNonEmptyString` from `typeGuards.ts:1-3`.
///
/// `typeof value === 'string' && value.trim() ? value.trim() : null` — the
/// trimmed value is returned, so `'  gpt-5  '` becomes `'gpt-5'` and a
/// whitespace-only string becomes `None`.
pub fn to_non_empty_string(value: Option<&Value>) -> Option<String> {
    let text = value.and_then(Value::as_str)?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// `toStringOrNull` from `typeGuards.ts:5-7` — the string is returned verbatim,
/// so an empty string is kept.
pub fn to_string_or_null(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_string)
}

/// `toNumberOrNull` from `typeGuards.ts:9-11`.
///
/// `Number.isFinite` rejects `NaN` and the infinities; neither can come out of
/// `JSON.parse`, so the check only matters for callers that build the value by
/// hand.
pub fn to_number_or_null(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
}

/// The `if (value)` truthiness test used by `mapResponseFormat`
/// (`requestMapper.ts:22`, `:25`).
///
/// JavaScript treats `0`, `NaN`, `''`, `null`, `undefined` and `false` as falsy
/// and everything else — including `{}` and `[]` — as truthy.
pub fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|parsed| parsed != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `String(value)` for a non-nullish JSON value, used by
/// `String(typed.json_schema.name)` (`requestMapper.ts:25`).
///
/// Scalars stringify identically in both languages, except that JavaScript
/// prints `5` for the JSON number `5.0` while `serde_json` keeps the literal
/// `5.0`; an object or array is serialised as JSON here where JavaScript would
/// print `[object Object]`.
pub fn js_string_value(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

/// A `number` for one of the integral fields of
/// [`crate::model_hub::types::GatewayUsage`].
///
/// TypeScript keeps the fraction (`{ prompt_tokens: 2.5 }` survives
/// `JSON.stringify`), while the shared `GatewayUsage` field is an `i64`, so the
/// fraction is truncated toward zero. The Codex backend reports integers, and
/// `openai_compatible/response.rs` reads the same field with `as_i64`.
pub fn js_int(value: Option<f64>) -> i64 {
    value.unwrap_or(0.0) as i64
}

/// `mapDefaultModels` from `utils/models.ts:4-10`.
///
/// `provider: 'openai-codex'` is the adapter id from `index.ts:7`.
pub fn map_default_models(default_models: &[String]) -> Vec<FetchedModel> {
    default_models
        .iter()
        .map(|id| FetchedModel {
            id: id.clone(),
            name: id.clone(),
            provider: super::PROVIDER_ID.to_string(),
            owned_by: None,
            context_window: None,
            created: None,
            billing: None,
        })
        .collect()
}

/// `mergeUniqueModels` from `utils/models.ts:12-24`.
///
/// The first occurrence wins and an empty id is skipped — the `!model?.id`
/// guard of `:19`. A `null` element cannot exist in Rust, so only the id test
/// remains.
pub fn merge_unique_models(
    primary: Vec<FetchedModel>,
    secondary: Vec<FetchedModel>,
) -> Vec<FetchedModel> {
    let mut seen: Vec<String> = Vec::new();
    let mut merged: Vec<FetchedModel> = Vec::new();
    for model in primary.into_iter().chain(secondary) {
        if model.id.is_empty() || seen.contains(&model.id) {
            continue;
        }
        seen.push(model.id.clone());
        merged.push(model);
    }
    merged
}

/// `buildCodexSeedModels` from `utils/models.ts:26-29`:
/// `[...new Set([...defaultModels, ...CODEX_MODEL_SEED])]`.
///
/// The catalog's list comes first, so an id present in both keeps the catalog
/// position.
pub fn build_codex_seed_models(default_models: &[String]) -> Vec<FetchedModel> {
    let mut merged_defaults: Vec<String> = Vec::new();
    for id in default_models
        .iter()
        .cloned()
        .chain(CODEX_MODEL_SEED.iter().map(|id| (*id).to_string()))
    {
        if !merged_defaults.contains(&id) {
            merged_defaults.push(id);
        }
    }
    map_default_models(&merged_defaults)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn non_empty_string_trims_and_rejects_blank() {
        assert_eq!(
            to_non_empty_string(Some(&json!(" gpt-5 "))),
            Some("gpt-5".to_string())
        );
        assert_eq!(to_non_empty_string(Some(&json!("   "))), None);
        assert_eq!(to_non_empty_string(Some(&json!(7))), None);
        assert_eq!(to_non_empty_string(None), None);
    }

    #[test]
    fn string_or_null_keeps_the_empty_string() {
        assert_eq!(to_string_or_null(Some(&json!(""))), Some(String::new()));
        assert_eq!(to_string_or_null(Some(&json!({ "a": 1 }))), None);
    }

    #[test]
    fn number_or_null_rejects_non_numbers() {
        assert_eq!(to_number_or_null(Some(&json!(2.5))), Some(2.5));
        assert_eq!(to_number_or_null(Some(&json!("2.5"))), None);
        assert_eq!(to_number_or_null(Some(&json!(null))), None);
    }

    #[test]
    fn truthiness_matches_javascript() {
        assert!(!is_truthy(&json!(null)));
        assert!(!is_truthy(&json!(false)));
        assert!(!is_truthy(&json!(0)));
        assert!(!is_truthy(&json!("")));
        assert!(is_truthy(&json!({})));
        assert!(is_truthy(&json!([])));
        assert!(is_truthy(&json!("x")));
    }

    #[test]
    fn js_string_value_follows_string_coercion() {
        assert_eq!(js_string_value(&json!("name")), "name");
        assert_eq!(js_string_value(&json!(5)), "5");
        assert_eq!(js_string_value(&json!(true)), "true");
        assert_eq!(js_string_value(&json!({ "a": 1 })), "{\"a\":1}");
    }

    /// `openai-codex-models.test.ts:22-65`: an empty catalog list still yields
    /// the full seed, in seed order.
    #[test]
    fn an_empty_catalog_list_yields_the_seed() {
        let models = build_codex_seed_models(&[]);
        let ids: Vec<&str> = models.iter().map(|model| model.id.as_str()).collect();
        assert_eq!(ids, CODEX_MODEL_SEED.to_vec());
        assert_eq!(models[0].name, "gpt-5.6");
        assert_eq!(models[0].provider, "openai-codex");
        assert_eq!(models[0].owned_by, None);
    }

    /// `openai-codex-models.test.ts:67-88`: a custom catalog model survives and
    /// precedes the seed without duplicating a seed id.
    #[test]
    fn a_custom_default_model_precedes_the_seed_without_duplicates() {
        let models = build_codex_seed_models(&[
            "custom-codex-preview".to_string(),
            "gpt-5.3-codex".to_string(),
        ]);
        let ids: Vec<&str> = models.iter().map(|model| model.id.as_str()).collect();
        assert_eq!(ids[0], "custom-codex-preview");
        assert_eq!(ids[1], "gpt-5.3-codex");
        assert_eq!(ids.iter().filter(|id| **id == "gpt-5.3-codex").count(), 1);
        assert_eq!(ids.len(), CODEX_MODEL_SEED.len() + 1);
    }

    #[test]
    fn merge_unique_models_drops_empty_and_repeated_ids() {
        let primary = map_default_models(&[String::new(), "a".to_string()]);
        let secondary = map_default_models(&["a".to_string(), "b".to_string()]);
        let merged = merge_unique_models(primary, secondary);
        let ids: Vec<&str> = merged.iter().map(|model| model.id.as_str()).collect();
        assert_eq!(ids, vec!["a", "b"]);
    }
}
