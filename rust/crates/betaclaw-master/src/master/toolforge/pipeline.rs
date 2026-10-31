//! Port of `src/server/master/toolforge/pipeline.ts:1-35`.
//!
//! The toolforge admission pipeline: validate the spec, ask the sandbox for a
//! verdict, persist the artifact (`awaiting_approval` when the sandbox passed,
//! `denied` otherwise) and, when the sandbox passed *and* the caller approved,
//! publish it.
//!
//! # The sandbox verdict arrives through a seam
//!
//! `pipeline.ts:4,15` imports `runToolForgeSandboxChecks` directly. Because that
//! execution path is S11's (OP-S9-2, see [`super::sandbox_runner`]), the port
//! takes a `&dyn ToolForgeSandboxRunner` parameter instead of importing or
//! stubbing it.

use crate::master::repository::toolforge_store::{MasterToolForgeArtifactInput, ToolForgePatch};
use crate::master::repository::MasterRepository;
use crate::master::toolforge::sandbox_runner::{ToolForgeSandboxInput, ToolForgeSandboxRunner};
use crate::master::toolforge::validator::validate_tool_forge_spec;
use crate::master::types::{MasterToolForgeArtifact, WorkspaceScope};

/// `input` of `executeToolForgePipeline` — `pipeline.ts:9`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolForgePipelineInput {
    pub name: String,
    pub spec: String,
    pub publish_globally: Option<bool>,
    pub approved: Option<bool>,
}

/// The `throw` of `pipeline.ts:13` plus the wrapped repository error.
#[derive(Debug, thiserror::Error)]
pub enum ToolForgePipelineError {
    #[error("Invalid tool spec: {0}")]
    InvalidSpec(String),
    #[error(transparent)]
    Repository(#[from] rusqlite::Error),
}

/// `executeToolForgePipeline` — `pipeline.ts:6-35`.
///
/// `manifest` is `JSON.stringify({ name, version: '0.1.0' })`. The publish step
/// mirrors `repo.updateToolForgeArtifact(...) || artifact`: a `None` patch result
/// falls back to the freshly created artifact.
pub fn execute_tool_forge_pipeline(
    repo: &dyn MasterRepository,
    scope: &WorkspaceScope,
    sandbox: &dyn ToolForgeSandboxRunner,
    input: &ToolForgePipelineInput,
) -> Result<MasterToolForgeArtifact, ToolForgePipelineError> {
    let validation = validate_tool_forge_spec(&input.spec);
    if !validation.valid {
        return Err(ToolForgePipelineError::InvalidSpec(
            validation.reason.unwrap_or_default(),
        ));
    }

    let sandbox_result = sandbox.run_sandbox_checks(&ToolForgeSandboxInput {
        name: input.name.clone(),
        spec: input.spec.clone(),
    });

    let manifest = serde_json::json!({ "name": input.name, "version": "0.1.0" }).to_string();
    let artifact = repo.create_toolforge_artifact(
        scope,
        &MasterToolForgeArtifactInput {
            name: input.name.clone(),
            spec: input.spec.clone(),
            manifest,
            test_summary: sandbox_result.summary,
            risk_report: sandbox_result.risk_report,
            status: if sandbox_result.passed {
                "awaiting_approval".to_string()
            } else {
                "denied".to_string()
            },
            published_globally: false,
        },
    )?;

    if sandbox_result.passed && input.approved.unwrap_or(false) {
        let patch = ToolForgePatch {
            status: Some("published".to_string()),
            published_globally: Some(input.publish_globally.unwrap_or(false)),
            ..ToolForgePatch::default()
        };
        if let Some(updated) = repo.update_toolforge_artifact(scope, &artifact.id, &patch)? {
            return Ok(updated);
        }
        return Ok(artifact);
    }
    Ok(artifact)
}

#[cfg(test)]
mod tests {
    use super::super::sandbox_runner::ToolForgeSandboxResult;
    use super::*;
    use crate::master::repository::sqlite_master_repository::SqliteMasterRepository;

    fn scope() -> WorkspaceScope {
        WorkspaceScope {
            user_id: "u1".to_string(),
            workspace_id: "w1".to_string(),
        }
    }

    struct FixedRunner {
        passed: bool,
    }

    impl ToolForgeSandboxRunner for FixedRunner {
        fn run_sandbox_checks(&self, _input: &ToolForgeSandboxInput) -> ToolForgeSandboxResult {
            if self.passed {
                ToolForgeSandboxResult {
                    passed: true,
                    summary: "Sandbox checks passed".to_string(),
                    risk_report: "low: no dangerous patterns detected".to_string(),
                }
            } else {
                ToolForgeSandboxResult {
                    passed: false,
                    summary: "Sandbox checks failed".to_string(),
                    risk_report: "high: dangerous command patterns detected".to_string(),
                }
            }
        }
    }

    fn input(approved: Option<bool>, publish_globally: Option<bool>) -> ToolForgePipelineInput {
        ToolForgePipelineInput {
            name: "tool-x".to_string(),
            spec: "{\"name\":\"tool-x\"}".to_string(),
            publish_globally,
            approved,
        }
    }

    #[test]
    fn an_invalid_spec_is_rejected_before_the_sandbox_runs() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let runner = FixedRunner { passed: true };
        let mut invalid = input(None, None);
        invalid.spec = "no braces".to_string();
        let error = execute_tool_forge_pipeline(&repo, &scope(), &runner, &invalid).unwrap_err();
        assert_eq!(
            error.to_string(),
            "Invalid tool spec: spec_must_be_json_like"
        );
    }

    #[test]
    fn a_failed_sandbox_denies_the_artifact() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let runner = FixedRunner { passed: false };
        let artifact =
            execute_tool_forge_pipeline(&repo, &scope(), &runner, &input(Some(true), Some(true)))
                .unwrap();
        assert_eq!(artifact.status, "denied");
        assert!(!artifact.published_globally);
        assert_eq!(artifact.test_summary, "Sandbox checks failed");
        assert_eq!(
            artifact.manifest,
            "{\"name\":\"tool-x\",\"version\":\"0.1.0\"}"
        );
    }

    #[test]
    fn a_passed_sandbox_without_approval_awaits_approval() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let runner = FixedRunner { passed: true };
        let artifact =
            execute_tool_forge_pipeline(&repo, &scope(), &runner, &input(None, None)).unwrap();
        assert_eq!(artifact.status, "awaiting_approval");
        assert!(!artifact.published_globally);
    }

    #[test]
    fn a_passed_sandbox_and_approval_publishes() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let runner = FixedRunner { passed: true };
        let artifact =
            execute_tool_forge_pipeline(&repo, &scope(), &runner, &input(Some(true), Some(true)))
                .unwrap();
        assert_eq!(artifact.status, "published");
        assert!(artifact.published_globally);
        assert_eq!(repo.list_global_toolforge_artifacts(10).unwrap().len(), 1);
    }

    #[test]
    fn publish_globally_defaults_to_false() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let runner = FixedRunner { passed: true };
        let artifact =
            execute_tool_forge_pipeline(&repo, &scope(), &runner, &input(Some(true), None))
                .unwrap();
        assert_eq!(artifact.status, "published");
        assert!(!artifact.published_globally);
    }
}
