//! Port of `src/core/memory/gemini.ts:1-61` — the Gemini function declarations
//! the core memory tools advertise.
//!
//! | TypeScript                              | Rust |
//! | --------------------------------------- | ---- |
//! | `gemini.ts:3-27` (`memoryStoreSpec`)    | [`MEMORY_STORE_SPEC`] |
//! | `gemini.ts:29-40` (`memoryRecallSpec`)  | [`MEMORY_RECALL_SPEC`] |
//! | `gemini.ts:42-57` (`taskScheduleSpec`)  | [`TASK_SCHEDULE_SPEC`] |
//! | `gemini.ts:59-61` (`CORE_MEMORY_TOOLS`) | [`CORE_MEMORY_TOOLS`] |
//!
//! The TypeScript builds the declarations from the `@google/genai` `Type` enum.
//! `betaclaw-core` has no Gemini SDK, so the same objects are the JSON the SDK
//! serialises: `Type.OBJECT` is `"OBJECT"`, `Type.STRING` is `"STRING"`,
//! `Type.NUMBER` is `"NUMBER"`. The keys are inserted in the source order, which
//! `serde_json`'s `preserve_order` feature keeps
//! (`rust/Cargo.toml:61`).

use std::sync::LazyLock;

use serde_json::{json, Value};

/// `memoryStoreSpec` — `gemini.ts:3-27`.
pub static MEMORY_STORE_SPEC: LazyLock<Value> = LazyLock::new(|| {
    json!({
        "name": "core_memory_store",
        "description": "INTERNAL CORE: Persist critical information, user preferences, or 'lessons learned' to the system's long-term memory graph.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "type": {
                    "type": "STRING",
                    "enum": [
                        "fact",
                        "preference",
                        "avoidance",
                        "lesson",
                        "personality_trait",
                        "workflow_pattern"
                    ],
                    "description": "The category of memory."
                },
                "content": { "type": "STRING", "description": "The information to be remembered." },
                "importance": { "type": "NUMBER", "description": "Priority level (1-5)." }
            },
            "required": ["type", "content"]
        }
    })
});

/// `memoryRecallSpec` — `gemini.ts:29-40`.
pub static MEMORY_RECALL_SPEC: LazyLock<Value> = LazyLock::new(|| {
    json!({
        "name": "core_memory_recall",
        "description": "INTERNAL CORE: Retrieve historical data or context from the system's long-term memory graph based on a semantic query.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "query": { "type": "STRING", "description": "The topic or fact to search for in memory." }
            },
            "required": ["query"]
        }
    })
});

/// `taskScheduleSpec` — `gemini.ts:42-57`.
pub static TASK_SCHEDULE_SPEC: LazyLock<Value> = LazyLock::new(|| {
    json!({
        "name": "core_task_schedule",
        "description": "Schedule a reminder or a proactive message for a specific future time. Use this for appointments, deadlines, or when the user asks to be reminded.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "time_iso": {
                    "type": "STRING",
                    "description": "The exact ISO 8601 timestamp for the reminder (e.g., 2025-05-20T10:00:00Z)."
                },
                "message": { "type": "STRING", "description": "The content of the reminder to be sent." }
            },
            "required": ["time_iso", "message"]
        }
    })
});

/// `CORE_MEMORY_TOOLS` — `gemini.ts:59-61`.
///
/// One tool group carrying the three declarations, in source order.
pub static CORE_MEMORY_TOOLS: LazyLock<Value> = LazyLock::new(|| {
    json!([
        {
            "functionDeclarations": [
                (*MEMORY_STORE_SPEC).clone(),
                (*MEMORY_RECALL_SPEC).clone(),
                (*TASK_SCHEDULE_SPEC).clone()
            ]
        }
    ])
});

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_spec_matches_the_typescript_literal() {
        let spec = &*MEMORY_STORE_SPEC;
        assert_eq!(spec["name"], json!("core_memory_store"));
        assert_eq!(spec["parameters"]["type"], json!("OBJECT"));
        assert_eq!(spec["parameters"]["required"], json!(["type", "content"]));
        assert_eq!(
            spec["parameters"]["properties"]["type"]["enum"],
            json!([
                "fact",
                "preference",
                "avoidance",
                "lesson",
                "personality_trait",
                "workflow_pattern"
            ])
        );
        assert_eq!(
            spec["parameters"]["properties"]["importance"]["type"],
            json!("NUMBER")
        );
    }

    #[test]
    fn recall_spec_requires_a_query() {
        let spec = &*MEMORY_RECALL_SPEC;
        assert_eq!(spec["name"], json!("core_memory_recall"));
        assert_eq!(spec["parameters"]["required"], json!(["query"]));
        assert_eq!(
            spec["parameters"]["properties"]["query"]["description"],
            json!("The topic or fact to search for in memory.")
        );
    }

    #[test]
    fn schedule_spec_requires_time_and_message() {
        let spec = &*TASK_SCHEDULE_SPEC;
        assert_eq!(spec["name"], json!("core_task_schedule"));
        assert_eq!(
            spec["parameters"]["required"],
            json!(["time_iso", "message"])
        );
    }

    #[test]
    fn core_memory_tools_wraps_the_three_specs_in_order() {
        let declarations = &CORE_MEMORY_TOOLS[0]["functionDeclarations"];
        let names: Vec<&str> = declarations
            .as_array()
            .expect("array")
            .iter()
            .map(|entry| entry["name"].as_str().expect("name"))
            .collect();
        assert_eq!(
            names,
            vec![
                "core_memory_store",
                "core_memory_recall",
                "core_task_schedule"
            ]
        );
        assert_eq!(CORE_MEMORY_TOOLS.as_array().expect("array").len(), 1);
    }
}
