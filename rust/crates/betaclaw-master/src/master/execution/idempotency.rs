//! Port of `src/server/master/execution/idempotency.ts:1-15`.
//!
//! `buildIdempotencyKey` is the composition the orchestrator's
//! `executeSideEffect` depends on: `sha256(actionPayload)` as lower-case hex,
//! truncated to its first 16 characters, joined as
//! `runId:stepId:actionType:hash`.

use sha2::{Digest, Sha256};

use crate::master::orchestrator::BuildIdempotencyKeyInput;

/// `buildIdempotencyKey` — `idempotency.ts:3-11`.
pub fn build_idempotency_key(input: &BuildIdempotencyKeyInput<'_>) -> String {
    let digest = Sha256::digest(input.action_payload.as_bytes());
    let hex = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let hash = &hex[..16];
    format!(
        "{}:{}:{}:{}",
        input.run_id, input.step_id, input.action_type, hash
    )
}

/// `isCommittedState` — `idempotency.ts:13-15`.
pub fn is_committed_state(state: &str) -> bool {
    state == "committed"
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::master::orchestrator::BuildIdempotencyKeyInput;

    fn input<'a>(payload: &'a str) -> BuildIdempotencyKeyInput<'a> {
        BuildIdempotencyKeyInput {
            run_id: "run-1",
            step_id: "step-1",
            action_type: "file.write",
            action_payload: payload,
        }
    }

    #[test]
    fn the_hash_is_the_first_sixteen_hex_chars_of_sha256() {
        // sha256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
        let key = build_idempotency_key(&input("abc"));
        assert_eq!(key, "run-1:step-1:file.write:ba7816bf8f01cfea");
    }

    #[test]
    fn an_empty_payload_still_hashes() {
        // sha256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
        assert_eq!(
            build_idempotency_key(&input("")),
            "run-1:step-1:file.write:e3b0c44298fc1c14"
        );
    }

    #[test]
    fn committed_state_is_the_only_committed_one() {
        assert!(is_committed_state("committed"));
        assert!(!is_committed_state("started"));
        assert!(!is_committed_state("failed"));
    }
}
