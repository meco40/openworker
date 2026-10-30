//! Port of `src/server/master/execution/runtime/capabilityControl.ts:1-31`.
//!
//! Two pure builders. `buildSystemCommand` embeds the contract's JSON as the
//! argument of an `echo`, truncated to 120 characters; `buildCapabilityControl`
//! maps a capability to the approval descriptor the runtime uses.

use crate::master::types::MasterRun;

use super::types::{Capability, CapabilityControl};

/// `buildSystemCommand` — `capabilityControl.ts:4-6`.
///
/// `JSON.stringify(contract).slice(0, 120)` — the slice is by UTF-16 code unit,
/// reproduced here by taking the first 120 `char`s of an ASCII-safe JSON string
/// (the UUID-escaped contract is ASCII except for literal non-ASCII input).
pub fn build_system_command(contract: &str) -> String {
    let json = serde_json::to_string(contract).unwrap_or_else(|_| "\"\"".to_string());
    let truncated: String = json.chars().take(120).collect();
    format!("echo {truncated}")
}

/// `buildCapabilityControl` — `capabilityControl.ts:8-31`.
pub fn build_capability_control(capability: Capability, run: &MasterRun) -> CapabilityControl {
    match capability {
        Capability::CodeGeneration => CapabilityControl {
            requires_approval: true,
            action_type: "file.write".to_string(),
            fingerprint: "file.write".to_string(),
            file_path: Some(format!("master-output/{}-solution.md", run.id)),
            command: None,
        },
        Capability::SystemOps => CapabilityControl {
            requires_approval: true,
            action_type: "shell.exec".to_string(),
            fingerprint: "shell.exec".to_string(),
            file_path: None,
            command: Some(build_system_command(&run.contract)),
        },
        other => CapabilityControl {
            requires_approval: false,
            action_type: other.as_str().to_string(),
            fingerprint: other.as_str().to_string(),
            file_path: None,
            command: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::master::types::MasterRun;

    fn run(id: &str, contract: &str) -> MasterRun {
        MasterRun {
            id: id.to_string(),
            user_id: "u1".to_string(),
            workspace_id: "w1".to_string(),
            title: "t".to_string(),
            contract: contract.to_string(),
            status: "IDLE".to_string(),
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

    #[test]
    fn code_generation_writes_into_master_output() {
        let control = build_capability_control(Capability::CodeGeneration, &run("r1", "c"));
        assert!(control.requires_approval);
        assert_eq!(control.action_type, "file.write");
        assert_eq!(
            control.file_path.as_deref(),
            Some("master-output/r1-solution.md")
        );
    }

    #[test]
    fn system_ops_shells_out_and_the_others_are_free() {
        let control = build_capability_control(Capability::SystemOps, &run("r1", "hi"));
        assert_eq!(control.action_type, "shell.exec");
        assert_eq!(control.command.as_deref(), Some("echo \"hi\""));

        let notes = build_capability_control(Capability::Notes, &run("r1", "c"));
        assert!(!notes.requires_approval);
        assert_eq!(notes.action_type, "notes");
        assert!(notes.file_path.is_none());
    }

    #[test]
    fn the_system_command_is_truncated_to_120_characters() {
        let command = build_system_command(&"a".repeat(300));
        assert!(command.starts_with("echo \""));
        assert_eq!(command.len(), "echo ".len() + 120);
    }
}
