//! Port of `src/server/world-model/retrieval/`.
//!
//! One module per TypeScript file; the submodules are declared by the work
//! package that ports them, so this file lists exactly what exists.
//!
//! | Rust | TypeScript |
//! | --- | --- |
//! | [`assertions`] | `retrieval/assertions.ts` |
//! | [`fulltext`] | `retrieval/fulltext.ts` |
//! | [`hybrid_ranker`] | `retrieval/hybridRanker.ts` |
//! | [`index`] | `retrieval/index.ts` |
//! | [`open_loops`] | `retrieval/openLoops.ts` |
//! | [`query_planner`] | `retrieval/queryPlanner.ts` |
//! | [`relations`] | `retrieval/relations.ts` |
//! | [`structured`] | `retrieval/structured.ts` |
//! | [`tasks`] | `retrieval/tasks.ts` |
//! | [`vector`] | `retrieval/vector.ts` |
//!
//! # Shared seam helpers (Rust only)
//!
//! Every module of this package reads untyped [`PgRow`] columns, and the same
//! three reads recur in eight of them, so they live here once. They are
//! plumbing, not ported behaviour, and `pub(crate)` so no other slice depends
//! on them. `crate::js` (`js_round`, `js_number_str`) is reused but not
//! extended — it belongs to S4/S5. The statement constants of the modules name
//! the TypeScript template literal they copy; the indentation *inside* a
//! template literal is not part of the contract, and the TypeScript tests
//! compare SQL text with collapsed whitespace
//! (`tests/unit/world-model/*.test.ts`).
pub mod assertions;
pub mod fulltext;
pub mod hybrid_ranker;
pub mod index;
pub mod open_loops;
pub mod query_planner;
pub mod relations;
pub mod structured;
pub mod tasks;
pub mod vector;

use serde_json::Value;

use crate::js::js_number_str;
use crate::world_model::db::PgRow;

/// `row.<column>` for a text column — `String(value)`.
///
/// `pg` hands a `TEXT`/`UUID`/enum column over as a string and a missing or
/// `NULL` value as `null`/`undefined`; the reads of this package pair the
/// property either with `?? undefined` (see [`row_optional_string`]) or with a
/// template interpolation, which writes `null`/`undefined` for those two cases.
/// Only the second group uses this helper, where both spellings of "absent"
/// become the empty string (compare `crate::memory::types::js_string`). A
/// driver hands `timestamptz` over as `Date#toISOString()` text
/// (`world_model/driver.rs:36-38`).
pub(crate) fn row_string(row: &PgRow, column: &str) -> String {
    match row.get(column) {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
    }
}

/// `row.<column> ?? undefined` — a `null` column is an absent optional property.
///
/// An **empty string stays `Some("")`**: `??` only falls through for
/// `null`/`undefined`, which is why `fulltext.ts:69` can write
/// `row.object_value ?? ''` while `structured.ts:117` would keep a `''`.
pub(crate) fn row_optional_string(row: &PgRow, column: &str) -> Option<String> {
    match row.get(column) {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => Some(text.clone()),
        Some(other) => Some(other.to_string()),
    }
}

/// `Number(row.<column>)`.
///
/// `Number(null)` is `0`, `Number(undefined)` is `NaN` and `Number('')` is `0`;
/// a text value goes through [`js_number_str`], so `'0x10'`, `'  12  '` and
/// `'Infinity'` behave like the source. A JSON array or object is `NaN` here
/// whereas `Number([])` would be `0`; no column of the ported statements is
/// array- or object-valued (deviation, unreachable).
pub(crate) fn row_number(row: &PgRow, column: &str) -> f64 {
    match row.get(column) {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::Bool(flag)) => {
            if *flag {
                1.0
            } else {
                0.0
            }
        }
        Some(Value::String(text)) => js_number_str(text),
        Some(_) => f64::NAN,
    }
}

/// `Math.min(50, Math.max(1, options.limit ?? fallback))` — the clamp of
/// `assertions.ts:41`, `tasks.ts:33`, `relations.ts:36` and `openLoops.ts:22`.
///
/// The source `limit` is a JavaScript `number`; the port takes an `i64` because
/// every caller derives it from `Math.floor` (`index.ts:103`) and PostgreSQL
/// rejects a fractional `LIMIT` in any case — a fractional limit from a direct
/// caller is the one unreachable deviation. The `??` default belongs to the
/// call site, not to the clamp: `0 ?? 10` is `0` and then clamps to `1`.
pub(crate) fn clamp_limit(limit: i64) -> i64 {
    limit.clamp(1, 50)
}

/// The tenant triple every module test uses.
#[cfg(test)]
pub(crate) fn test_scope() -> crate::world_model::db::NormalizedScope {
    crate::world_model::db::NormalizedScope {
        user_id: "u1".to_string(),
        persona_id: "p1".to_string(),
        workspace_id: "w1".to_string(),
    }
}

/// The config double of the module tests — the real resolver of
/// `config.rs:177` with the two gate flags set.
#[cfg(test)]
pub(crate) fn test_config(
    enabled: bool,
    e2e_enabled: bool,
) -> crate::world_model::config::WorldModelConfig {
    let mut env = std::collections::HashMap::new();
    env.insert("WORLD_MODEL_ENABLED".to_string(), enabled.to_string());
    env.insert("WORLD_MODEL_E2E".to_string(), e2e_enabled.to_string());
    crate::world_model::config::resolve_world_model_config(&env)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn row_reads_follow_the_null_and_undefined_rules() {
        let row = json!({
            "text": "value",
            "empty": "",
            "nothing": null,
            "count": "12",
            "real": 0.5,
        })
        .as_object()
        .unwrap()
        .clone();
        assert_eq!(row_string(&row, "text"), "value");
        assert_eq!(row_string(&row, "empty"), "");
        assert_eq!(row_string(&row, "nothing"), "");
        assert_eq!(row_string(&row, "absent"), "");
        assert_eq!(row_optional_string(&row, "empty"), Some(String::new()));
        assert_eq!(row_optional_string(&row, "nothing"), None);
        assert_eq!(row_optional_string(&row, "absent"), None);
        assert_eq!(row_number(&row, "count"), 12.0, "`Number('12')`");
        assert_eq!(row_number(&row, "real"), 0.5);
        assert_eq!(row_number(&row, "nothing"), 0.0, "`Number(null)` is 0");
        assert!(
            row_number(&row, "absent").is_nan(),
            "`Number(undefined)` is NaN"
        );
    }

    #[test]
    fn the_limit_clamp_matches_math_min_max() {
        assert_eq!(clamp_limit(10), 10);
        assert_eq!(clamp_limit(80), 50);
        assert_eq!(clamp_limit(-3), 1);
        assert_eq!(clamp_limit(0), 1, "`Math.max(1, 0)` is 1");
        assert_eq!(clamp_limit(1), 1);
        assert_eq!(clamp_limit(50), 50);
    }
}
