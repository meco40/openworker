//! Port of `src/server/model-hub/Models/openai-codex/mappers/toolMapper.ts`.
//!
//! The Responses API wants a flat function tool
//! (`{ type: 'function', name, description?, parameters?, strict? }`), while the
//! gateway request may carry either that shape already or the OpenAI-style
//! nested one (`{ type: 'function', function: { … } }`). The mapper accepts
//! both, prefers the flat fields, and drops anything that cannot produce a
//! trimmed name.

use serde_json::{Map, Value};

use super::super::utils::{to_non_empty_string, to_string_or_null};

/// `value && typeof value === 'object' && !Array.isArray(value)`.
fn as_non_array_object(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| value.is_object())
}

/// The `function` member of a nested tool definition, when it is an object.
fn nested_function(raw_tool: &Value) -> Option<&Value> {
    raw_tool.get("function").filter(|value| value.is_object())
}

/// `mapCodexFunctionTool` from `toolMapper.ts:3-57`.
///
/// Returns `None` for a non-object, an array, a `type` other than `function`,
/// and for a tool without a trimmed name. `description` and `strict` keep an
/// empty string and an explicit `false` respectively — only an absent or
/// mistyped value is dropped.
pub fn map_codex_function_tool(raw_tool: Option<&Value>) -> Option<Value> {
    let raw_tool = raw_tool.filter(|value| value.is_object())?;
    if raw_tool.get("type").and_then(Value::as_str) != Some("function") {
        return None;
    }

    let name = to_non_empty_string(raw_tool.get("name")).or_else(|| {
        to_non_empty_string(nested_function(raw_tool).and_then(|function| function.get("name")))
    })?;

    let description = to_string_or_null(raw_tool.get("description")).or_else(|| {
        to_string_or_null(
            nested_function(raw_tool).and_then(|function| function.get("description")),
        )
    });

    let parameters = as_non_array_object(raw_tool.get("parameters"))
        .or_else(|| {
            as_non_array_object(
                nested_function(raw_tool).and_then(|function| function.get("parameters")),
            )
        })
        .cloned();

    let strict = raw_tool.get("strict").and_then(Value::as_bool).or_else(|| {
        nested_function(raw_tool)
            .and_then(|function| function.get("strict"))
            .and_then(Value::as_bool)
    });

    let mut mapped = Map::new();
    mapped.insert("type".to_string(), Value::from("function"));
    mapped.insert("name".to_string(), Value::from(name));
    if let Some(description) = description {
        mapped.insert("description".to_string(), Value::from(description));
    }
    if let Some(parameters) = parameters {
        mapped.insert("parameters".to_string(), parameters);
    }
    if let Some(strict) = strict {
        mapped.insert("strict".to_string(), Value::from(strict));
    }
    Some(Value::Object(mapped))
}

/// `mapCodexTools` from `toolMapper.ts:59-64`.
///
/// `request.tools` is optional in the gateway request, so the port takes the
/// slice instead of the array.
pub fn map_codex_tools(tools: Option<&[Value]>) -> Vec<Value> {
    let Some(tools) = tools.filter(|tools| !tools.is_empty()) else {
        return Vec::new();
    };
    tools
        .iter()
        .filter_map(|tool| map_codex_function_tool(Some(tool)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_flat_function_tool_is_normalised() {
        let mapped = map_codex_function_tool(Some(&json!({
            "type": "function",
            "name": " lookup ",
            "description": "finds things",
            "parameters": { "type": "object" },
            "strict": false
        })))
        .expect("mapped");
        assert_eq!(
            mapped,
            json!({
                "type": "function",
                "name": "lookup",
                "description": "finds things",
                "parameters": { "type": "object" },
                "strict": false
            })
        );
    }

    #[test]
    fn a_nested_function_tool_is_flattened() {
        let mapped = map_codex_function_tool(Some(&json!({
            "type": "function",
            "function": {
                "name": "lookup",
                "description": "finds things",
                "parameters": { "type": "object" },
                "strict": true
            }
        })))
        .expect("mapped");
        assert_eq!(
            mapped,
            json!({
                "type": "function",
                "name": "lookup",
                "description": "finds things",
                "parameters": { "type": "object" },
                "strict": true
            })
        );
    }

    /// The flat name wins over the nested one, while `strict` falls back to the
    /// nested definition independently — and a field neither shape supplies is
    /// omitted rather than sent as `null`.
    #[test]
    fn flat_fields_win_and_absent_ones_are_omitted() {
        let mapped = map_codex_function_tool(Some(&json!({
            "type": "function",
            "name": "flat",
            "function": { "name": "nested", "strict": true }
        })))
        .expect("mapped");
        assert_eq!(
            mapped,
            json!({ "type": "function", "name": "flat", "strict": true })
        );

        let nested_only = map_codex_function_tool(Some(&json!({
            "type": "function",
            "function": { "name": "nested" }
        })))
        .expect("mapped");
        assert_eq!(nested_only, json!({ "type": "function", "name": "nested" }));
    }

    #[test]
    fn only_function_tools_with_a_name_survive() {
        assert_eq!(map_codex_function_tool(None), None);
        assert_eq!(map_codex_function_tool(Some(&json!([]))), None);
        assert_eq!(map_codex_function_tool(Some(&json!("function"))), None);
        assert_eq!(
            map_codex_function_tool(Some(&json!({ "type": "custom", "name": "x" }))),
            None
        );
        assert_eq!(
            map_codex_function_tool(Some(&json!({ "type": "function", "name": "   " }))),
            None
        );
        assert_eq!(
            map_codex_function_tool(Some(&json!({ "type": "function" }))),
            None
        );
    }

    /// `description` must be a string — an empty one is kept, a mistyped one is
    /// dropped; `parameters` must be a non-array object.
    #[test]
    fn description_and_parameters_follow_the_type_guards() {
        let empty_description = map_codex_function_tool(Some(&json!({
            "type": "function",
            "name": "x",
            "description": "",
            "parameters": [1, 2]
        })))
        .expect("mapped");
        assert_eq!(
            empty_description,
            json!({ "type": "function", "name": "x", "description": "" })
        );

        let mistyped = map_codex_function_tool(Some(&json!({
            "type": "function",
            "name": "x",
            "description": 7,
            "parameters": "nope",
            "strict": "yes"
        })))
        .expect("mapped");
        assert_eq!(mistyped, json!({ "type": "function", "name": "x" }));
    }

    /// A non-object top-level `parameters` falls back to the nested one.
    #[test]
    fn parameters_fall_back_to_the_nested_definition() {
        let mapped = map_codex_function_tool(Some(&json!({
            "type": "function",
            "name": "x",
            "parameters": [],
            "function": { "parameters": { "type": "object" } }
        })))
        .expect("mapped");
        assert_eq!(
            mapped,
            json!({
                "type": "function",
                "name": "x",
                "parameters": { "type": "object" }
            })
        );
    }

    #[test]
    fn the_tool_list_drops_unmappable_entries() {
        assert_eq!(map_codex_tools(None), Vec::<Value>::new());
        assert_eq!(map_codex_tools(Some(&[])), Vec::<Value>::new());
        let tools = map_codex_tools(Some(&[
            json!({ "type": "custom", "name": "skipped" }),
            json!({ "type": "function", "name": "kept" }),
        ]));
        assert_eq!(tools, vec![json!({ "type": "function", "name": "kept" })]);
    }
}
