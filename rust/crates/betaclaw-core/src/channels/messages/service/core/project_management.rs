//! Port of `src/server/channels/messages/service/core/projectManagement.ts`.
//!
//! The TypeScript `CreatedProject` has the same fields as the store's
//! `PersonaProjectRecord` projection, so the port returns [`ProjectRecord`].
//! `typeof repo.x === 'function'` guards are dropped, because the port trait is total.

use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::json;

use crate::channels::messages::service::subagent::utils::object;

use crate::channels::messages::service::conversation::ports::MessageRepositoryPort;
use crate::channels::messages::service::core::types::lock;
use crate::channels::messages::service::execution::ports::PortResult;
use crate::channels::messages::service::ports::{
    NewProject, PersonaPort, ProjectRecord, SendResponse,
};
use crate::channels::messages::service::project_guard::{
    build_project_clarification_prompt, is_project_required_intent,
    resolve_project_name_from_clarification_reply, GuardProjectSuggestion,
};
use crate::channels::messages::service::utils::js_regex::slice_utf16;
use crate::messages_store::types::{now_iso, ChannelType, Conversation, StoredMessage};

/// `PendingProjectClarification` (`projectManagement.ts:23-28`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingProjectClarification {
    pub requested_at: String,
    pub original_task: String,
    pub platform: ChannelType,
    pub external_chat_id: String,
}

/// Result of `resolveConversationWorkspace` (`projectManagement.ts:50-88`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConversationWorkspace {
    pub project_id: String,
    pub workspace_path: String,
    pub workspace_relative_path: Option<String>,
}

/// Result of `maybeConsumeProjectClarificationReply` (`projectManagement.ts:233-242`).
#[derive(Debug, Clone, PartialEq)]
pub enum ClarificationOutcome {
    /// A reply was sent (a request for a name, or a failure). The turn ends.
    Message(StoredMessage),
    /// The project was created; the original task is replayed.
    Replay {
        replay_task_input: String,
        project_name: String,
    },
}

/// The dependencies that the clarification helpers share.
pub struct ProjectDeps<'a> {
    pub repo: &'a dyn MessageRepositoryPort,
    pub personas: &'a dyn PersonaPort,
    pub send: &'a dyn SendResponse,
    pub pending: &'a Mutex<HashMap<String, PendingProjectClarification>>,
}

/// `getProjectClarificationKey(conversation)` (`projectManagement.ts:43-45`).
pub fn get_project_clarification_key(conversation: &Conversation) -> String {
    format!("{}::{}", conversation.id, conversation.user_id)
}

/// `resolveConversationWorkspace(conversation, repo)` (`projectManagement.ts:50-88`).
pub fn resolve_conversation_workspace(
    conversation: &Conversation,
    repo: &dyn MessageRepositoryPort,
) -> PortResult<Option<ConversationWorkspace>> {
    let Some(persona_id) = conversation.persona_id.as_deref() else {
        return Ok(None);
    };
    let state = repo.get_conversation_project_state(&conversation.id, &conversation.user_id)?;
    let Some(active_project_id) = state.active_project_id else {
        return Ok(None);
    };
    let Some(project) =
        repo.get_project_by_id_or_slug(persona_id, &conversation.user_id, &active_project_id)?
    else {
        return Ok(None);
    };
    Ok(Some(ConversationWorkspace {
        project_id: project.id,
        workspace_path: project.workspace_path,
        workspace_relative_path: project
            .workspace_relative_path
            .filter(|path| !path.is_empty()),
    }))
}

/// `resolveConversationWorkspaceCwd(conversation, repo)` (`projectManagement.ts:93-98`).
pub fn resolve_conversation_workspace_cwd(
    conversation: &Conversation,
    repo: &dyn MessageRepositoryPort,
) -> PortResult<Option<String>> {
    Ok(resolve_conversation_workspace(conversation, repo)?.map(|ws| ws.workspace_path))
}

/// `createAndActivateProjectForConversation` (`projectManagement.ts:103-146`).
///
/// Returns `None` when the conversation has no persona, the persona has no slug, or
/// the sanitised name is empty.
pub fn create_and_activate_project_for_conversation(
    conversation: &Conversation,
    requested_name: &str,
    repo: &dyn MessageRepositoryPort,
    personas: &dyn PersonaPort,
) -> PortResult<Option<ProjectRecord>> {
    let Some(persona_id) = conversation.persona_id.as_deref() else {
        return Ok(None);
    };
    let Some(persona) = personas.get_persona(persona_id)? else {
        return Ok(None);
    };
    if persona.slug.is_empty() {
        return Ok(None);
    }

    // `String(name).trim().replace(/\s+/g, ' ').slice(0, 80)`
    let collapsed = requested_name
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let project_name = slice_utf16(&collapsed, 80).to_string();
    if project_name.is_empty() {
        return Ok(None);
    }

    let workspace =
        personas.create_project_workspace(&persona.slug, &project_name, &project_name)?;

    let project = repo.create_project(&NewProject {
        user_id: conversation.user_id.clone(),
        persona_id: persona_id.to_string(),
        name: project_name,
        workspace_path: workspace.absolute_path,
        workspace_relative_path: Some(workspace.relative_path),
    })?;
    repo.set_active_project_for_conversation(
        &conversation.id,
        &conversation.user_id,
        Some(&project.id),
    )?;
    Ok(Some(project))
}

/// `maybeRequestProjectClarification` (`projectManagement.ts:151-214`). Asks for a
/// project name when build intent arrives with no active project.
pub async fn maybe_request_project_clarification(
    deps: &ProjectDeps<'_>,
    conversation: &Conversation,
    platform: ChannelType,
    external_chat_id: &str,
    content: &str,
) -> PortResult<Option<StoredMessage>> {
    let Some(persona_id) = conversation.persona_id.as_deref() else {
        return Ok(None);
    };
    if !is_project_required_intent(content) {
        return Ok(None);
    }

    let state = deps
        .repo
        .get_conversation_project_state(&conversation.id, &conversation.user_id)?;
    if state.active_project_id.is_some() {
        return Ok(None);
    }

    let key = get_project_clarification_key(conversation);
    {
        let mut pending = lock(deps.pending);
        if pending.contains_key(&key) {
            return Ok(None);
        }
        pending.insert(
            key,
            PendingProjectClarification {
                requested_at: now_iso(),
                original_task: content.trim().to_string(),
                platform,
                external_chat_id: external_chat_id.to_string(),
            },
        );
    }

    let projects: Vec<GuardProjectSuggestion> = deps
        .repo
        .list_projects_by_persona(persona_id, &conversation.user_id)?
        .into_iter()
        .take(5)
        .map(|project| GuardProjectSuggestion {
            name: project.name,
            slug: project.slug,
        })
        .collect();
    let prompt = build_project_clarification_prompt(&projects);
    let message = deps
        .send
        .send_response(
            conversation,
            &prompt,
            platform,
            external_chat_id,
            Some(object(json!({
                "ok": false,
                "runtime": "project-workspace-clarification",
                "status": "project_clarification_required",
            }))),
        )
        .await?;
    Ok(Some(message))
}

/// `maybeConsumeProjectClarificationReply` (`projectManagement.ts:219-302`).
pub async fn maybe_consume_project_clarification_reply(
    deps: &ProjectDeps<'_>,
    conversation: &Conversation,
    platform: ChannelType,
    external_chat_id: &str,
    content: &str,
) -> PortResult<Option<ClarificationOutcome>> {
    let key = get_project_clarification_key(conversation);
    let pending = {
        let guard = lock(deps.pending);
        guard.get(&key).cloned()
    };
    let Some(pending) = pending else {
        return Ok(None);
    };

    let Some(project_name) =
        resolve_project_name_from_clarification_reply(content, &pending.original_task)
    else {
        let message = deps
            .send
            .send_response(
                conversation,
                "Bitte nenne den Projektnamen (z. B. `Notes`) oder antworte mit `auto`.",
                platform,
                external_chat_id,
                Some(object(json!({
                    "ok": false,
                    "status": "project_clarification_required",
                    "runtime": "project-workspace-clarification",
                }))),
            )
            .await?;
        return Ok(Some(ClarificationOutcome::Message(message)));
    };

    let project = create_and_activate_project_for_conversation(
        conversation,
        &project_name,
        deps.repo,
        deps.personas,
    )?;
    let Some(project) = project else {
        lock(deps.pending).remove(&key);
        let message = deps
            .send
            .send_response(
                conversation,
                "Projekt konnte nicht erstellt werden. Bitte pruefe Persona/Projekt-Setup und versuche es erneut.",
                platform,
                external_chat_id,
                Some(object(json!({
                    "ok": false,
                    "status": "project_clarification_failed",
                    "runtime": "project-workspace-clarification",
                }))),
            )
            .await?;
        return Ok(Some(ClarificationOutcome::Message(message)));
    };

    lock(deps.pending).remove(&key);
    Ok(Some(ClarificationOutcome::Replay {
        replay_task_input: pending.original_task,
        project_name: project.name,
    }))
}
