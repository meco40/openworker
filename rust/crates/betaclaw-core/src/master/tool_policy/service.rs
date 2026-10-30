//! Port of `src/server/master/toolPolicy/service.ts:1-222`.
//!
//! Load / save / resolve for the per-workspace tool policy. `security` is
//! `deny`/`allowlist`/`full` and `ask` is `off`/`on_miss`/`always`; the resolve
//! ladder reproduces the source branch by branch, including the `*` host and the
//! glob matching of allowlist targets.
//!
//! # The OP-S9-13 seam is closed here
//!
//! [`crate::master::execution::approval_policy::ToolPolicyResolver`] was the P4
//! seam for exactly this function. [`ToolPolicyServiceResolver`] implements it,
//! mapping [`ToolPolicyResolution`] onto the gate's narrower view. The gate trait
//! is infallible while [`resolve_tool_policy`] can fail on a repository error, so
//! the adapter *fails closed* (`deny`) rather than silently allowing — see
//! OP-S9-20. A repository error would have thrown in the TypeScript; the gate
//! cannot carry that failure, and denying never weakens a security boundary.

use std::collections::HashSet;

use crate::master::execution::approval_policy::{
    ToolPolicyDecision, ToolPolicyResolution as GateToolPolicyResolution,
    ToolPolicyResolutionInput, ToolPolicyResolver,
};
use crate::master::repository::tool_policy_store::MasterToolPolicyInput;
use crate::master::repository::MasterRepository;
use crate::master::types::{MasterToolPolicy, WorkspaceScope};

/// `KNOWN_POLICY_HOSTS` from `service.ts:4`.
const KNOWN_POLICY_HOSTS: &[&str] = &["gateway", "sandbox", "*"];

/// `input` of `loadToolPolicy` — `service.ts:6-10`.
pub struct LoadToolPolicyInput<'a> {
    pub repo: &'a dyn MasterRepository,
    pub scope: &'a WorkspaceScope,
    pub fallback_allowlist: Option<Vec<String>>,
}

/// `loadToolPolicy` — `service.ts:6-29`.
///
/// A stored row wins; otherwise the fallback allowlist synthesises a
/// `{ id: 'default', security: 'allowlist', ask: 'on_miss' }` policy with empty
/// `createdAt`/`updatedAt`. Without a fallback it is `None`.
pub fn load_tool_policy(
    input: &LoadToolPolicyInput<'_>,
) -> rusqlite::Result<Option<MasterToolPolicy>> {
    if let Some(existing) = input.repo.get_tool_policy(input.scope)? {
        return Ok(Some(existing));
    }
    let Some(fallback_allowlist) = &input.fallback_allowlist else {
        return Ok(None);
    };
    Ok(Some(MasterToolPolicy {
        id: "default".to_string(),
        user_id: input.scope.user_id.clone(),
        workspace_id: input.scope.workspace_id.clone(),
        security: "allowlist".to_string(),
        ask: "on_miss".to_string(),
        allowlist: fallback_allowlist.clone(),
        updated_by: None,
        created_at: String::new(),
        updated_at: String::new(),
    }))
}

/// `input` of `saveToolPolicy` — `service.ts:31-35`.
pub struct SaveToolPolicyInput<'a> {
    pub repo: &'a dyn MasterRepository,
    pub scope: &'a WorkspaceScope,
    /// `Omit<MasterToolPolicy, 'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt'>`.
    pub policy: &'a MasterToolPolicyInput,
}

/// `saveToolPolicy` — `service.ts:31-37`.
pub fn save_tool_policy(input: &SaveToolPolicyInput<'_>) -> rusqlite::Result<MasterToolPolicy> {
    input.repo.upsert_tool_policy(input.scope, input.policy)
}

/// `input` of `resolveToolPolicy` — `service.ts:120-128`.
pub struct ResolveToolPolicyInput<'a> {
    pub repo: &'a dyn MasterRepository,
    pub scope: &'a WorkspaceScope,
    pub action_type: &'a str,
    pub tool_name: Option<&'a str>,
    pub host: Option<&'a str>,
    pub target_context: Option<&'a str>,
    pub fingerprint: Option<&'a str>,
}

/// `ToolPolicyResolution` from `service.ts:106-111`.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolPolicyResolution {
    pub decision: ToolPolicyDecision,
    pub policy: Option<MasterToolPolicy>,
    pub matched_allowlist_entry: Option<String>,
    pub reason: Option<String>,
}

/// `resolveToolPolicy` — `service.ts:154-222`.
pub fn resolve_tool_policy(
    input: &ResolveToolPolicyInput<'_>,
) -> rusqlite::Result<ToolPolicyResolution> {
    let policy = load_tool_policy(&LoadToolPolicyInput {
        repo: input.repo,
        scope: input.scope,
        fallback_allowlist: None,
    })?;
    let Some(policy) = policy else {
        return Ok(ToolPolicyResolution {
            decision: ToolPolicyDecision::Allow,
            policy: None,
            matched_allowlist_entry: None,
            reason: None,
        });
    };

    if policy.security == "deny" {
        return Ok(ToolPolicyResolution {
            decision: ToolPolicyDecision::Deny,
            policy: Some(policy),
            matched_allowlist_entry: None,
            reason: Some(format!("Tool policy blocks {}.", input.action_type)),
        });
    }

    let matched_allowlist_entry = if policy.security == "full" {
        Some("*".to_string())
    } else {
        policy
            .allowlist
            .iter()
            .find(|entry| {
                matches_allowlist_entry(
                    entry,
                    input.action_type,
                    input.tool_name,
                    input.host,
                    input.target_context,
                    input.fingerprint,
                )
            })
            .cloned()
    };

    if policy.security == "allowlist" && matched_allowlist_entry.is_none() {
        if policy.ask == "off" {
            return Ok(ToolPolicyResolution {
                decision: ToolPolicyDecision::Deny,
                policy: Some(policy),
                matched_allowlist_entry: None,
                reason: Some(format!(
                    "Tool policy requires allowlist match for {}.",
                    input.action_type
                )),
            });
        }
        return Ok(ToolPolicyResolution {
            decision: ToolPolicyDecision::Ask,
            policy: Some(policy),
            matched_allowlist_entry: None,
            reason: Some(format!(
                "Tool policy approval required for {}.",
                input.action_type
            )),
        });
    }

    if policy.ask == "always" {
        return Ok(ToolPolicyResolution {
            decision: ToolPolicyDecision::Ask,
            policy: Some(policy),
            matched_allowlist_entry,
            reason: Some(format!(
                "Tool policy requires explicit approval for {}.",
                input.action_type
            )),
        });
    }

    Ok(ToolPolicyResolution {
        decision: ToolPolicyDecision::Allow,
        policy: Some(policy),
        matched_allowlist_entry,
        reason: None,
    })
}

/// A parsed allowlist entry — `parseAllowlistEntry` (`service.ts:77-105`).
struct ParsedAllowlistEntry {
    subject: String,
    host: Option<String>,
    target: String,
}

/// `parseAllowlistEntry` — `service.ts:77-105`.
fn parse_allowlist_entry(entry: &str) -> Option<ParsedAllowlistEntry> {
    let trimmed = entry.trim();
    if trimmed.is_empty() {
        return None;
    }

    let Some(first_colon) = trimmed.find(':') else {
        return Some(ParsedAllowlistEntry {
            subject: trimmed.to_string(),
            host: None,
            target: "*".to_string(),
        });
    };

    let subject = trimmed[..first_colon].trim().to_string();
    let remainder = &trimmed[first_colon + 1..];
    if let Some(second_colon) = remainder.find(':') {
        let host_candidate = remainder[..second_colon].trim();
        if KNOWN_POLICY_HOSTS.contains(&host_candidate) {
            let target = remainder[second_colon + 1..].trim();
            return Some(ParsedAllowlistEntry {
                subject,
                host: Some(host_candidate.to_string()),
                target: if target.is_empty() {
                    "*".to_string()
                } else {
                    target.to_string()
                },
            });
        }
    }

    let target = remainder.trim();
    Some(ParsedAllowlistEntry {
        subject,
        host: None,
        target: if target.is_empty() {
            "*".to_string()
        } else {
            target.to_string()
        },
    })
}

/// `matchesAllowlistEntry` — `service.ts:107-145`.
fn matches_allowlist_entry(
    entry: &str,
    action_type: &str,
    tool_name: Option<&str>,
    host: Option<&str>,
    target_context: Option<&str>,
    fingerprint: Option<&str>,
) -> bool {
    let Some(parsed) = parse_allowlist_entry(entry) else {
        return false;
    };

    let subjects: HashSet<String> = [Some(action_type), tool_name, Some("*")]
        .into_iter()
        .flatten()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect();
    if !subjects.contains(&parsed.subject) {
        return false;
    }

    let host = host.unwrap_or("").trim();
    if let Some(parsed_host) = &parsed.host {
        if parsed_host != "*" && parsed_host != host {
            return false;
        }
    }

    let target_raw = target_context.unwrap_or("");
    let fingerprint_raw = fingerprint.unwrap_or("");
    let joined = [target_raw, fingerprint_raw]
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join(":");
    let target_candidates: Vec<String> = [target_raw, fingerprint_raw, joined.as_str()]
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect();

    if parsed.target == "*" {
        return true;
    }
    target_candidates
        .iter()
        .any(|candidate| match_glob(&parsed.target, candidate))
}

/// `matchGlob` — `service.ts:39-75`.
///
/// Both sides are lower-cased. A single `*` matches everything; otherwise the
/// pattern splits on `*` and each part must be found in order, with the first and
/// last parts anchored unless the pattern starts/ends with `*`.
fn match_glob(pattern: &str, value: &str) -> bool {
    let pattern = pattern.to_lowercase();
    let value = value.to_lowercase();
    if pattern == "*" {
        return true;
    }

    let parts: Vec<&str> = pattern.split('*').collect();
    if parts.len() == 1 {
        return value == pattern;
    }

    let mut cursor = 0usize;
    let mut is_first_part = true;
    for part in &parts {
        if part.is_empty() {
            is_first_part = false;
            continue;
        }
        let Some(found) = value.get(cursor..).and_then(|rest| rest.find(part)) else {
            return false;
        };
        let index = cursor + found;
        if is_first_part && !pattern.starts_with('*') && index != 0 {
            return false;
        }
        cursor = index + part.len();
        is_first_part = false;
    }

    let last_part = parts.last().copied().unwrap_or("");
    if !last_part.is_empty() && !pattern.ends_with('*') && !value.ends_with(last_part) {
        return false;
    }

    true
}

/// The gate adapter for `resolveToolPolicy` (OP-S9-13, OP-S9-20).
#[derive(Debug, Clone, Copy, Default)]
pub struct ToolPolicyServiceResolver;

impl ToolPolicyResolver for ToolPolicyServiceResolver {
    fn resolve_tool_policy(
        &self,
        input: &ToolPolicyResolutionInput<'_>,
    ) -> GateToolPolicyResolution {
        match resolve_tool_policy(&ResolveToolPolicyInput {
            repo: input.repo,
            scope: input.scope,
            action_type: input.action_type,
            tool_name: input.tool_name,
            host: input.host,
            target_context: input.target_context,
            fingerprint: input.fingerprint,
        }) {
            Ok(resolution) => GateToolPolicyResolution {
                decision: resolution.decision,
                reason: resolution.reason,
            },
            Err(_) => GateToolPolicyResolution {
                decision: ToolPolicyDecision::Deny,
                reason: Some("Tool policy could not be loaded.".to_string()),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::master::repository::sqlite_master_repository::SqliteMasterRepository;

    fn scope() -> WorkspaceScope {
        WorkspaceScope {
            user_id: "u1".to_string(),
            workspace_id: "w1".to_string(),
        }
    }

    fn store(
        repo: &SqliteMasterRepository,
        security: &str,
        ask: &str,
        allowlist: Vec<&str>,
    ) -> MasterToolPolicy {
        save_tool_policy(&SaveToolPolicyInput {
            repo,
            scope: &scope(),
            policy: &MasterToolPolicyInput {
                security: security.to_string(),
                ask: ask.to_string(),
                allowlist: allowlist.into_iter().map(str::to_string).collect(),
                updated_by: None,
            },
        })
        .unwrap()
    }

    fn resolve(
        repo: &SqliteMasterRepository,
        action_type: &str,
        host: Option<&str>,
        target_context: Option<&str>,
    ) -> ToolPolicyResolution {
        resolve_tool_policy(&ResolveToolPolicyInput {
            repo,
            scope: &scope(),
            action_type,
            tool_name: None,
            host,
            target_context,
            fingerprint: None,
        })
        .unwrap()
    }

    #[test]
    fn no_policy_allows() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let resolution = resolve(&repo, "file.write", None, None);
        assert_eq!(resolution.decision, ToolPolicyDecision::Allow);
        assert!(resolution.policy.is_none());
    }

    #[test]
    fn load_falls_back_to_the_allowlist() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let policy = load_tool_policy(&LoadToolPolicyInput {
            repo: &repo,
            scope: &scope(),
            fallback_allowlist: Some(vec!["file.write".to_string()]),
        })
        .unwrap()
        .expect("fallback policy");
        assert_eq!(policy.id, "default");
        assert_eq!(policy.security, "allowlist");
        assert_eq!(policy.ask, "on_miss");
        assert_eq!(policy.allowlist, vec!["file.write".to_string()]);
        assert_eq!(policy.created_at, "");
    }

    #[test]
    fn save_then_load_round_trips() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        store(&repo, "allowlist", "on_miss", vec!["file.write"]);
        let policy = load_tool_policy(&LoadToolPolicyInput {
            repo: &repo,
            scope: &scope(),
            fallback_allowlist: None,
        })
        .unwrap()
        .expect("stored policy");
        assert_eq!(policy.allowlist, vec!["file.write".to_string()]);
    }

    #[test]
    fn a_deny_policy_blocks() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        store(&repo, "deny", "off", vec![]);
        let resolution = resolve(&repo, "file.write", None, None);
        assert_eq!(resolution.decision, ToolPolicyDecision::Deny);
        assert_eq!(
            resolution.reason.as_deref(),
            Some("Tool policy blocks file.write.")
        );
    }

    #[test]
    fn an_allowlist_miss_with_ask_off_denies() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        store(&repo, "allowlist", "off", vec!["notes.create"]);
        let resolution = resolve(&repo, "file.write", None, None);
        assert_eq!(resolution.decision, ToolPolicyDecision::Deny);
        assert_eq!(
            resolution.reason.as_deref(),
            Some("Tool policy requires allowlist match for file.write.")
        );
    }

    #[test]
    fn an_allowlist_miss_asks() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        store(&repo, "allowlist", "on_miss", vec!["notes.create"]);
        let resolution = resolve(&repo, "file.write", None, None);
        assert_eq!(resolution.decision, ToolPolicyDecision::Ask);
        assert_eq!(
            resolution.reason.as_deref(),
            Some("Tool policy approval required for file.write.")
        );
    }

    #[test]
    fn an_allowlist_hit_allows_with_the_matched_entry() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        store(&repo, "allowlist", "on_miss", vec!["file.write"]);
        let resolution = resolve(&repo, "file.write", None, None);
        assert_eq!(resolution.decision, ToolPolicyDecision::Allow);
        assert_eq!(
            resolution.matched_allowlist_entry.as_deref(),
            Some("file.write")
        );
    }

    #[test]
    fn full_allows_with_the_star_entry() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        store(&repo, "full", "on_miss", vec![]);
        let resolution = resolve(&repo, "file.write", None, None);
        assert_eq!(resolution.decision, ToolPolicyDecision::Allow);
        assert_eq!(resolution.matched_allowlist_entry.as_deref(), Some("*"));
    }

    #[test]
    fn ask_always_escalates_even_on_a_match() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        store(&repo, "allowlist", "always", vec!["file.write"]);
        let resolution = resolve(&repo, "file.write", None, None);
        assert_eq!(resolution.decision, ToolPolicyDecision::Ask);
        assert_eq!(
            resolution.reason.as_deref(),
            Some("Tool policy requires explicit approval for file.write.")
        );
    }

    #[test]
    fn a_host_restricted_entry_only_matches_its_host() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        store(
            &repo,
            "allowlist",
            "on_miss",
            vec!["file.write:gateway:/tmp"],
        );
        let on_gateway = resolve(&repo, "file.write", Some("gateway"), Some("/tmp"));
        assert_eq!(on_gateway.decision, ToolPolicyDecision::Allow);
        let on_sandbox = resolve(&repo, "file.write", Some("sandbox"), Some("/tmp"));
        assert_eq!(on_sandbox.decision, ToolPolicyDecision::Ask);
    }

    #[test]
    fn match_glob_follows_the_source_anchoring_rules() {
        assert!(match_glob("*", "anything"));
        assert!(match_glob("file.write", "file.write"));
        assert!(!match_glob("file.write", "file.read"));
        // An unanchored pattern must match a substring anywhere.
        assert!(match_glob("*write", "file.write"));
        assert!(match_glob("file*", "file.write"));
        assert!(!match_glob("write*", "file.write"));
        assert!(match_glob("*.write", "/tmp/a.write"));
        // Case-insensitive.
        assert!(match_glob("FILE.*", "file.write"));
        // An empty middle part is skipped.
        assert!(match_glob("a**b", "aXXb"));
        assert!(!match_glob("a**z", "aXXb"));
    }

    #[test]
    fn the_gate_adapter_reads_the_stored_policy() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        store(&repo, "deny", "off", vec![]);
        let resolver = ToolPolicyServiceResolver;
        let resolution = resolver.resolve_tool_policy(&ToolPolicyResolutionInput {
            repo: &repo,
            scope: &scope(),
            action_type: "file.write",
            tool_name: None,
            host: None,
            target_context: None,
            fingerprint: None,
        });
        assert_eq!(resolution.decision, ToolPolicyDecision::Deny);
        assert_eq!(
            resolution.reason.as_deref(),
            Some("Tool policy blocks file.write.")
        );
    }

    #[test]
    fn the_gate_adapter_allows_when_no_policy_exists() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let resolver = ToolPolicyServiceResolver;
        let resolution = resolver.resolve_tool_policy(&ToolPolicyResolutionInput {
            repo: &repo,
            scope: &scope(),
            action_type: "file.write",
            tool_name: None,
            host: None,
            target_context: None,
            fingerprint: None,
        });
        assert_eq!(resolution.decision, ToolPolicyDecision::Allow);
        assert!(resolution.reason.is_none());
    }
}
