//! Port of `src/server/master/execution/runtime/toolContext.ts:1-18`.
//!
//! `buildToolContext` is a pure object literal. `ChannelType.WEBCHAT` is the
//! literal `'WebChat'` (`src/shared/domain/types.ts:6`); the port names it so the
//! wire value stays reviewable.

use serde::{Deserialize, Serialize};

use crate::master::workspace_scope::MasterWorkspaceBinding;

/// `ChannelType.WEBCHAT` — `shared/domain/types.ts:6`.
pub const WEBCHAT_PLATFORM: &str = "WebChat";

/// The object returned by `buildToolContext` — `toolContext.ts:9-17`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolContext {
    pub bypass_approval: bool,
    pub enforce_skill_activation: bool,
    pub workspace_cwd: String,
    pub conversation_id: String,
    pub user_id: String,
    pub platform: String,
    pub external_chat_id: String,
}

/// `buildToolContext` — `toolContext.ts:4-18`.
pub fn build_tool_context(
    scope: &MasterWorkspaceBinding,
    run_id: &str,
    bypass_approval: bool,
) -> ToolContext {
    ToolContext {
        bypass_approval,
        enforce_skill_activation: true,
        workspace_cwd: scope.workspace_cwd.clone(),
        conversation_id: format!("master:{run_id}"),
        user_id: scope.user_id.clone(),
        platform: WEBCHAT_PLATFORM.to_string(),
        external_chat_id: format!("master:{}", scope.workspace_id),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding() -> MasterWorkspaceBinding {
        MasterWorkspaceBinding {
            user_id: "u1".to_string(),
            workspace_id: "w1".to_string(),
            persona_id: "p1".to_string(),
            persona_workspace_root: "/root".to_string(),
            workspace_cwd: "/root/cwd".to_string(),
        }
    }

    #[test]
    fn the_context_is_built_from_the_binding() {
        let context = build_tool_context(&binding(), "run-1", false);
        assert_eq!(context.conversation_id, "master:run-1");
        assert_eq!(context.external_chat_id, "master:w1");
        assert_eq!(context.platform, "WebChat");
        assert_eq!(context.workspace_cwd, "/root/cwd");
        assert_eq!(context.user_id, "u1");
        assert!(context.enforce_skill_activation);
        assert!(!context.bypass_approval);
    }

    #[test]
    fn serde_keeps_the_camel_case_keys() {
        let json = serde_json::to_value(build_tool_context(&binding(), "run-1", true)).unwrap();
        assert_eq!(json["bypassApproval"], true);
        assert_eq!(json["conversationId"], "master:run-1");
        assert_eq!(json["externalChatId"], "master:w1");
    }
}
