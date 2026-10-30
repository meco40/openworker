//! Port of `src/server/gateway/exec-approval-manager.ts`.
//!
//! Approvals live in a JSON file (`<cwd>/.local/exec-approvals.json` by default), keyed
//! by the SHA-256 fingerprint of the normalised command. Reads never fail: a missing,
//! unreadable or wrong-version file is an empty store, as in TypeScript.
//!
//! [`enforce_exec_approval`] is the gate the shell, python, process and playwright
//! handlers call. It applies only when `BETACLAW_EXEC_APPROVALS_REQUIRED` is `true`,
//! which is the TypeScript default.
//!
//! Listing sorts by byte order. TypeScript used `localeCompare`, so the order of
//! mixed-case commands can differ. Nothing depends on that order.

use std::fs;
use std::io;
use std::path::PathBuf;

use serde::Serialize;
use serde_json::{json, Value};

use super::node_command_policy::{
    command_fingerprint, evaluate_node_command_policy, normalize_command,
};
use super::types::{SkillDispatchContext, SkillEnv, SkillError};
use crate::safe_error_message;

const STORE_VERSION: f64 = 1.0;

/// One approved command, as stored in the JSON file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRecord {
    pub fingerprint: String,
    pub command: String,
    pub updated_at: String,
}

/// Failures of the approval store. The messages carry no command text.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ApprovalStoreError {
    /// `approveCommand` refuses what the command policy blocks.
    #[error("{0}")]
    Blocked(String),
    #[error("exec approval store: {0}")]
    Io(String),
}

impl From<io::Error> for ApprovalStoreError {
    fn from(error: io::Error) -> Self {
        Self::Io(safe_error_message(&error))
    }
}

/// The approval file. Holds only its path; every call reads or rewrites the file, as the
/// TypeScript module does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecApprovalStore {
    path: PathBuf,
}

impl ExecApprovalStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// `resolveApprovalStorePath` without an explicit path: `<cwd>/.local/exec-approvals.json`.
    pub fn in_current_dir() -> io::Result<Self> {
        Ok(Self::new(
            std::env::current_dir()?
                .join(".local")
                .join("exec-approvals.json"),
        ))
    }

    /// `listApprovedCommands`.
    pub fn list(&self) -> Vec<ApprovalRecord> {
        let mut records = self.load();
        records.sort_by(|a, b| a.command.cmp(&b.command));
        records
    }

    /// `clearApprovedCommands`.
    pub fn clear(&self) -> Result<(), ApprovalStoreError> {
        self.save(&[])
    }

    /// `approveCommand`. Replaces an existing record with the same fingerprint.
    pub fn approve(&self, command: &str) -> Result<(), ApprovalStoreError> {
        let policy = evaluate_node_command_policy(command);
        if !policy.allowed {
            return Err(ApprovalStoreError::Blocked(
                policy.reason.unwrap_or_default().to_string(),
            ));
        }

        let fingerprint = command_fingerprint(command);
        let record = ApprovalRecord {
            fingerprint: fingerprint.clone(),
            command: normalize_command(command),
            updated_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        };
        let mut records = self.load();
        match records
            .iter_mut()
            .find(|entry| entry.fingerprint == fingerprint)
        {
            Some(entry) => *entry = record,
            None => records.push(record),
        }
        self.save(&records)
    }

    /// `revokeCommand`. Returns `Ok(false)` when the command was not approved.
    pub fn revoke(&self, command: &str) -> Result<bool, ApprovalStoreError> {
        let fingerprint = command_fingerprint(command);
        let mut records = self.load();
        let before = records.len();
        records.retain(|entry| entry.fingerprint != fingerprint);
        if records.len() == before {
            return Ok(false);
        }
        self.save(&records)?;
        Ok(true)
    }

    /// `isCommandApproved`.
    pub fn is_approved(&self, command: &str) -> bool {
        let fingerprint = command_fingerprint(command);
        self.load()
            .iter()
            .any(|entry| entry.fingerprint == fingerprint)
    }

    fn load(&self) -> Vec<ApprovalRecord> {
        let Ok(raw) = fs::read_to_string(&self.path) else {
            return Vec::new();
        };
        let Ok(Value::Object(root)) = serde_json::from_str::<Value>(&raw) else {
            return Vec::new();
        };
        let version_ok = root.get("version").and_then(Value::as_f64) == Some(STORE_VERSION);
        let Some(Value::Array(entries)) = root.get("approvals") else {
            return Vec::new();
        };
        if !version_ok {
            return Vec::new();
        }
        // Entries missing one of the three string fields are dropped, as in TypeScript.
        entries.iter().filter_map(parse_record).collect()
    }

    fn save(&self, records: &[ApprovalRecord]) -> Result<(), ApprovalStoreError> {
        if let Some(parent) = self.path.parent().filter(|p| !p.as_os_str().is_empty()) {
            fs::create_dir_all(parent)?;
        }
        let document = json!({ "version": 1, "approvals": records });
        let text = serde_json::to_string_pretty(&document)
            .map_err(|error| ApprovalStoreError::Io(safe_error_message(&error)))?;
        fs::write(&self.path, text)?;
        Ok(())
    }
}

fn parse_record(entry: &Value) -> Option<ApprovalRecord> {
    let object = entry.as_object()?;
    Some(ApprovalRecord {
        fingerprint: object.get("fingerprint")?.as_str()?.to_string(),
        command: normalize_command(object.get("command")?.as_str()?),
        updated_at: object.get("updatedAt")?.as_str()?.to_string(),
    })
}

/// The approval gate of the exec handlers.
///
/// Passes when approvals are not required, the dispatch context bypasses them, or the
/// command is already approved. `cli_hint` appends the CLI instruction that the shell,
/// process and playwright handlers show. The python handler does not show it.
pub fn enforce_exec_approval(
    env: &SkillEnv,
    ctx: &SkillDispatchContext,
    command: &str,
    cli_hint: bool,
) -> Result<(), SkillError> {
    if !env.exec.approvals_required || ctx.bypass_approval || env.approvals.is_approved(command) {
        return Ok(());
    }
    let mut message = format!(
        "Command requires approval. Fingerprint: {}",
        command_fingerprint(command)
    );
    if cli_hint {
        message.push_str(" Approve via CLI: npm run cli -- node approve --command \"<command>\"");
    }
    Err(SkillError(message))
}

#[cfg(test)]
mod tests {
    use super::super::types::test_support::TempDir;
    use super::*;

    fn approvals_file(dir: &TempDir) -> PathBuf {
        dir.0.join(".local").join("exec-approvals.json")
    }

    fn store_of(dir: &TempDir) -> ExecApprovalStore {
        ExecApprovalStore::new(approvals_file(dir))
    }

    #[test]
    fn approve_then_check_ignores_whitespace_and_revoke_reports_misses() {
        let dir = TempDir::new();
        let store = store_of(&dir);
        assert!(!store.is_approved("ls  -la"));

        store.approve("  ls   -la ").expect("approve");
        assert!(store.is_approved("ls -la"));
        assert_eq!(
            store.list()[0].command,
            "ls -la",
            "stored in normalised form"
        );

        assert!(store.revoke("ls -la").expect("revoke"));
        assert!(!store.revoke("ls -la").expect("second revoke"));
        assert!(!store.is_approved("ls -la"));
    }

    #[test]
    fn approve_refuses_blocked_commands_and_writes_nothing() {
        let dir = TempDir::new();
        let store = store_of(&dir);
        match store.approve("rm -rf /") {
            Err(ApprovalStoreError::Blocked(reason)) => {
                assert_eq!(reason, "Command blocked by security policy.");
            }
            other => panic!("expected Blocked, got {other:?}"),
        }
        assert!(store.list().is_empty());
    }

    #[test]
    fn corrupt_or_wrong_version_files_read_as_empty() {
        let dir = TempDir::new();
        let store = store_of(&dir);
        fs::create_dir_all(dir.0.join(".local")).expect("dir");

        fs::write(approvals_file(&dir), "{not json").expect("write");
        assert!(store.list().is_empty());

        fs::write(
            approvals_file(&dir),
            r#"{"version":2,"approvals":[{"fingerprint":"a","command":"x","updatedAt":"t"}]}"#,
        )
        .expect("write");
        assert!(store.list().is_empty(), "wrong version is an empty store");

        fs::write(
            approvals_file(&dir),
            r#"{"version":1,"approvals":[{"fingerprint":"a","command":"x"},{"fingerprint":"b","command":"y","updatedAt":"t"}]}"#,
        )
        .expect("write");
        let records = store.list();
        assert_eq!(records.len(), 1, "entries without updatedAt are dropped");
        assert_eq!(records[0].fingerprint, "b");
    }

    #[test]
    fn gate_is_off_by_default_and_names_the_cli_only_for_shell_style_handlers() {
        let dir = TempDir::new();
        let ctx = SkillDispatchContext::default();

        assert!(enforce_exec_approval(&dir.env(false), &ctx, "ls", true).is_ok());

        let env = dir.env(true);
        let err = enforce_exec_approval(&env, &ctx, "ls", true).expect_err("unapproved");
        assert!(err
            .0
            .starts_with("Command requires approval. Fingerprint: "));
        assert!(err
            .0
            .ends_with("npm run cli -- node approve --command \"<command>\""));

        let err = enforce_exec_approval(&env, &ctx, "ls", false).expect_err("unapproved");
        assert!(!err.0.contains("npm run cli"));

        let bypass = SkillDispatchContext {
            bypass_approval: true,
            ..SkillDispatchContext::default()
        };
        assert!(enforce_exec_approval(&env, &bypass, "ls", true).is_ok());

        env.approvals.approve("ls").expect("approve");
        assert!(enforce_exec_approval(&env, &ctx, "ls", true).is_ok());
    }
}
