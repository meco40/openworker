//! Port of `src/server/master/execution/runtime/codeGeneration.ts:1-86`.
//!
//! `buildCodeGenerationContent` asks the runtime persona's model for
//! `{ files, patchPlan, testPlan, summary }`, picks the first file entry with a
//! string `content` and renders it; every failure falls back to a fixed draft
//! (the source's bare `catch`).
//!
//! `input.filePath` (`codeGeneration.ts:9`) is declared by the source and never
//! read; the port keeps the parameter for signature parity and documents that it
//! is unused.
//!
//! # The model hub call is a seam
//!
//! See [`super::execution_plan::MasterModelDispatch`]; the encryption-key
//! resolution lives in the implementation (OP-S9-8).

use serde_json::Value;

use crate::master::execution::runtime::execution_plan::{
    MasterModelDispatch, MasterModelMessage, MasterModelRequest,
};
use crate::master::execution::runtime::json_parsing::extract_json_object_from_text;
use crate::master::feature_flags::MasterEnv;
use crate::master::runtime_persona::{
    get_master_runtime_persona_config, MasterRuntimePersonaInput,
};
use crate::master::types::MasterRun;
use crate::personas::repository::PersonaRepository;

use super::types::RuntimeMode;

/// `{ content, mode, degradedMode }` — `codeGeneration.ts:11`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodeGenerationContent {
    pub content: String,
    pub mode: RuntimeMode,
    pub degraded_mode: bool,
}

/// `input` of `buildCodeGenerationContent` — `codeGeneration.ts:7-11`.
pub struct CodeGenerationInput<'a> {
    pub run: &'a MasterRun,
    /// Declared but unread by the source; kept for parity.
    pub file_path: Option<&'a str>,
    pub scope: &'a MasterRuntimePersonaInput,
}

fn fallback_content(run: &MasterRun) -> String {
    [
        "# Master Generated Program Draft",
        "",
        &format!("Contract: {}", run.contract),
        "",
        "## Proposed implementation",
        "- Define a small module boundary first.",
        "- Add automated tests for the critical path.",
        "- Verify with typecheck, lint, and focused test runs.",
    ]
    .join("\n")
}

/// `buildCodeGenerationContent` — `codeGeneration.ts:7-86`.
pub fn build_code_generation_content(
    input: &CodeGenerationInput<'_>,
    persona_repo: &PersonaRepository,
    env: &MasterEnv,
    model: &dyn MasterModelDispatch,
) -> CodeGenerationContent {
    generated(input, persona_repo, env, model).unwrap_or_else(|| CodeGenerationContent {
        content: fallback_content(input.run),
        mode: RuntimeMode::Fallback,
        degraded_mode: true,
    })
}

fn generated(
    input: &CodeGenerationInput<'_>,
    persona_repo: &PersonaRepository,
    env: &MasterEnv,
    model: &dyn MasterModelDispatch,
) -> Option<CodeGenerationContent> {
    let runtime_persona = get_master_runtime_persona_config(input.scope, persona_repo, env).ok()?;

    let mut parts: Vec<String> = Vec::new();
    if let Some(instruction) = &runtime_persona.system_instruction {
        if !instruction.is_empty() {
            parts.push(instruction.clone());
        }
    }
    if let Some(preferred) = &runtime_persona.preferred_model_id {
        if !preferred.is_empty() {
            parts.push(format!("Preferred model hint: {preferred}"));
        }
    }
    parts.push("You generate implementation drafts for coding tasks.".to_string());
    parts.push("Return JSON only with keys:".to_string());
    parts.push("- files: [{ path: string, content: string }]".to_string());
    parts.push("- patchPlan: string[]".to_string());
    parts.push("- testPlan: string[]".to_string());
    parts.push("- summary: string".to_string());
    parts.push("Do not return markdown fences.".to_string());

    let request = MasterModelRequest {
        messages: vec![
            MasterModelMessage {
                role: "system".to_string(),
                content: parts.join("\n\n"),
            },
            MasterModelMessage {
                role: "user".to_string(),
                content: format!("Contract:\n{}", input.run.contract),
            },
        ],
        temperature: 0.3,
        max_tokens: 1000,
        audit_context: serde_json::json!({ "kind": "worker_executor", "taskId": input.run.id }),
    };
    let response = model
        .dispatch_with_fallback(&runtime_persona.model_hub_profile_id, &request)
        .ok()?;
    if !response.ok {
        return None;
    }

    let parsed = extract_json_object_from_text(&response.text)?;
    let files = parsed
        .get("files")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let file_content = files
        .iter()
        .find_map(|entry| {
            entry
                .as_object()
                .and_then(|object| object.get("content"))
                .and_then(Value::as_str)
        })
        .map(|content| content.trim().to_string())
        .unwrap_or_default();
    if file_content.is_empty() {
        return None;
    }

    let summary = parsed
        .get("summary")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let content = if summary.is_empty() {
        file_content
    } else {
        format!("{file_content}\n\n---\n\nSummary: {summary}")
    };
    Some(CodeGenerationContent {
        content,
        mode: RuntimeMode::Model,
        degraded_mode: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::master::execution::runtime::execution_plan::{
        MasterModelDispatch, MasterModelRequest, MasterModelResponse,
    };
    use crate::personas::repository::PersonaRepository;
    use crate::personas::workspace::PersonaWorkspace;

    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn new() -> Self {
            let unique = uuid::Uuid::new_v4().simple().to_string();
            let path = std::env::temp_dir().join(format!("betaclaw-master-codegen-{unique}"));
            std::fs::create_dir_all(&path).expect("create temp dir");
            Self(path)
        }

        fn repo(&self) -> PersonaRepository {
            PersonaRepository::open_with_workspace(
                self.0.join("personas.db").to_string_lossy().as_ref(),
                PersonaWorkspace::new(self.0.join("personas")),
            )
            .expect("open persona repository")
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    struct StubModel(Result<MasterModelResponse, String>);

    impl MasterModelDispatch for StubModel {
        fn dispatch_with_fallback(
            &self,
            _profile_id: &str,
            _request: &MasterModelRequest,
        ) -> Result<MasterModelResponse, String> {
            self.0.clone()
        }
    }

    fn run() -> MasterRun {
        MasterRun {
            id: "run-1".to_string(),
            user_id: "u1".to_string(),
            workspace_id: "w1".to_string(),
            title: "t".to_string(),
            contract: "Build a parser".to_string(),
            status: "EXECUTING".to_string(),
            progress: 0,
            verification_passed: false,
            result_bundle: None,
            created_at: "t".to_string(),
            updated_at: "t".to_string(),
            last_error: None,
            paused_for_approval: false,
            pending_approval_action_type: None,
            cancelled_at: None,
            cancel_reason: None,
            owner_id: None,
            lease_expires_at: None,
            heartbeat_at: None,
        }
    }

    fn input<'a>(
        run: &'a MasterRun,
        scope: &'a MasterRuntimePersonaInput,
    ) -> CodeGenerationInput<'a> {
        CodeGenerationInput {
            run,
            file_path: Some("ignored.md"),
            scope,
        }
    }

    fn scope() -> MasterRuntimePersonaInput {
        MasterRuntimePersonaInput {
            user_id: "u1".to_string(),
            persona_id: None,
        }
    }

    #[test]
    fn a_failing_model_returns_the_fallback_draft() {
        let dir = TempDir::new();
        let repo = dir.repo();
        let run = run();
        let scope = scope();
        let content = build_code_generation_content(
            &input(&run, &scope),
            &repo,
            &MasterEnv::new(),
            &StubModel(Err("boom".to_string())),
        );
        assert_eq!(content.mode, RuntimeMode::Fallback);
        assert!(content.degraded_mode);
        assert!(content
            .content
            .starts_with("# Master Generated Program Draft"));
        assert!(content.content.contains("Contract: Build a parser"));
    }

    #[test]
    fn a_successful_model_uses_the_first_file_and_appends_the_summary() {
        let dir = TempDir::new();
        let repo = dir.repo();
        let run = run();
        let scope = scope();
        let model = StubModel(Ok(MasterModelResponse {
            ok: true,
            error: None,
            text: r#"{"files":[{"path":"a","content":"  print(1)  "}],"summary":"done"}"#
                .to_string(),
        }));
        let content =
            build_code_generation_content(&input(&run, &scope), &repo, &MasterEnv::new(), &model);
        assert_eq!(content.mode, RuntimeMode::Model);
        assert!(!content.degraded_mode);
        assert_eq!(content.content, "print(1)\n\n---\n\nSummary: done");
    }

    #[test]
    fn an_empty_model_file_falls_back() {
        let dir = TempDir::new();
        let repo = dir.repo();
        let run = run();
        let scope = scope();
        let model = StubModel(Ok(MasterModelResponse {
            ok: true,
            error: None,
            text: r#"{"files":[{"path":"a","content":"  "}]}"#.to_string(),
        }));
        let content =
            build_code_generation_content(&input(&run, &scope), &repo, &MasterEnv::new(), &model);
        assert_eq!(content.mode, RuntimeMode::Fallback);
    }
}
