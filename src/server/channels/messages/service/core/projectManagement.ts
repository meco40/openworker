/**
 * Project management utilities for MessageService
 * Extracted from the monolithic index.ts
 */

import type {
  Conversation,
  MessageRepository,
  StoredMessage,
} from '@/server/channels/messages/repository';
import type { ChannelType } from '@/shared/domain/types';
import { getPersonaRepository } from '@/server/personas/personaRepository';
import { createPersonaProjectWorkspace } from '@/server/personas/personaProjectWorkspace';
import {
  buildProjectClarificationPrompt,
  isProjectRequiredIntent,
  resolveProjectNameFromClarificationReply,
} from '../projectGuard';

/**
 * Project clarification request info
 */
export interface PendingProjectClarification {
  requestedAt: string;
  originalTask: string;
  platform: ChannelType;
  externalChatId: string;
}

/**
 * Project creation result
 */
export interface CreatedProject {
  id: string;
  name: string;
  slug: string;
  workspacePath: string;
}

/**
 * Get the project clarification key for a conversation
 */
export function getProjectClarificationKey(conversation: Conversation): string {
  return `${conversation.id}::${conversation.userId}`;
}

/**
 * Resolve conversation workspace
 */
export function resolveConversationWorkspace(
  conversation: Conversation,
  repo: MessageRepository,
): {
  projectId?: string;
  workspacePath?: string;
  workspaceRelativePath?: string;
} | null {
  if (
    typeof repo.getConversationProjectState !== 'function' ||
    typeof repo.getProjectByIdOrSlug !== 'function'
  ) {
    return null;
  }

  if (!conversation.personaId) {
    return null;
  }

  const projectState = repo.getConversationProjectState(conversation.id, conversation.userId);
  if (!projectState.activeProjectId) {
    return null;
  }

  const project = repo.getProjectByIdOrSlug(
    conversation.personaId,
    conversation.userId,
    projectState.activeProjectId,
  );
  if (!project) {
    return null;
  }

  return {
    projectId: project.id,
    workspacePath: project.workspacePath,
    workspaceRelativePath: project.workspaceRelativePath || undefined,
  };
}

/**
 * Resolve conversation workspace CWD
 */
export function resolveConversationWorkspaceCwd(
  conversation: Conversation,
  repo: MessageRepository,
): string | undefined {
  return resolveConversationWorkspace(conversation, repo)?.workspacePath;
}

/**
 * Create and activate a project for a conversation
 */
export function createAndActivateProjectForConversation(
  conversation: Conversation,
  requestedName: string,
  repo: MessageRepository,
): CreatedProject | null {
  if (!conversation.personaId) {
    return null;
  }
  if (
    typeof repo.createProject !== 'function' ||
    typeof repo.setActiveProjectForConversation !== 'function'
  ) {
    return null;
  }

  const persona = getPersonaRepository().getPersona(conversation.personaId);
  if (!persona?.slug) {
    return null;
  }

  const projectName = String(requestedName || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 80);
  if (!projectName) {
    return null;
  }

  const workspace = createPersonaProjectWorkspace({
    personaSlug: persona.slug,
    task: projectName,
    requestedName: projectName,
  });

  const project = repo.createProject({
    userId: conversation.userId,
    personaId: conversation.personaId,
    name: projectName,
    workspacePath: workspace.absolutePath,
    workspaceRelativePath: workspace.relativePath,
  });
  repo.setActiveProjectForConversation(conversation.id, conversation.userId, project.id);
  return project;
}

/**
 * Check if we should request project clarification
 */
export async function maybeRequestProjectClarification(params: {
  conversation: Conversation;
  platform: ChannelType;
  externalChatId: string;
  content: string;
  repo: MessageRepository;
  pendingProjectClarifications: Map<string, PendingProjectClarification>;
  sendResponse: (
    conversation: Conversation,
    content: string,
    platform: ChannelType,
    externalChatId: string,
    metadata?: Record<string, unknown>,
  ) => Promise<StoredMessage>;
}): Promise<StoredMessage | null> {
  const {
    conversation,
    platform,
    externalChatId,
    content,
    repo,
    pendingProjectClarifications,
    sendResponse,
  } = params;

  if (!conversation.personaId || !isProjectRequiredIntent(content)) {
    return null;
  }

  if (
    typeof repo.getConversationProjectState !== 'function' ||
    typeof repo.listProjectsByPersona !== 'function'
  ) {
    return null;
  }

  const projectState = repo.getConversationProjectState(conversation.id, conversation.userId);
  if (projectState.activeProjectId) {
    return null;
  }

  const clarificationKey = getProjectClarificationKey(conversation);
  if (pendingProjectClarifications.has(clarificationKey)) {
    return null;
  }

  pendingProjectClarifications.set(clarificationKey, {
    requestedAt: new Date().toISOString(),
    originalTask: String(content || '').trim(),
    platform,
    externalChatId,
  });

  const projects = repo
    .listProjectsByPersona(conversation.personaId, conversation.userId)
    .slice(0, 5)
    .map((project) => ({ name: project.name, slug: project.slug }));
  const prompt = buildProjectClarificationPrompt({ projects });
  return sendResponse(conversation, prompt, platform, externalChatId, {
    ok: false,
    runtime: 'project-workspace-clarification',
    status: 'project_clarification_required',
  });
}

/**
 * Consume project clarification reply
 */
export async function maybeConsumeProjectClarificationReply(params: {
  conversation: Conversation;
  platform: ChannelType;
  externalChatId: string;
  content: string;
  repo: MessageRepository;
  pendingProjectClarifications: Map<string, PendingProjectClarification>;
  sendResponse: (
    conversation: Conversation,
    content: string,
    platform: ChannelType,
    externalChatId: string,
    metadata?: Record<string, unknown>,
  ) => Promise<StoredMessage>;
}): Promise<
  | {
      replayTaskInput: string;
      projectName: string;
    }
  | {
      message: StoredMessage;
    }
  | null
> {
  const {
    conversation,
    platform,
    externalChatId,
    content,
    repo,
    pendingProjectClarifications,
    sendResponse,
  } = params;

  const clarificationKey = getProjectClarificationKey(conversation);
  const pending = pendingProjectClarifications.get(clarificationKey);
  if (!pending) {
    return null;
  }

  const projectName = resolveProjectNameFromClarificationReply({
    reply: content,
    originalTask: pending.originalTask,
  });
  if (!projectName) {
    return {
      message: await sendResponse(
        conversation,
        'Bitte nenne den Projektnamen (z. B. `Notes`) oder antworte mit `auto`.',
        platform,
        externalChatId,
        {
          ok: false,
          status: 'project_clarification_required',
          runtime: 'project-workspace-clarification',
        },
      ),
    };
  }

  const project = createAndActivateProjectForConversation(conversation, projectName, repo);
  if (!project) {
    pendingProjectClarifications.delete(clarificationKey);
    return {
      message: await sendResponse(
        conversation,
        'Projekt konnte nicht erstellt werden. Bitte pruefe Persona/Projekt-Setup und versuche es erneut.',
        platform,
        externalChatId,
        {
          ok: false,
          status: 'project_clarification_failed',
          runtime: 'project-workspace-clarification',
        },
      ),
    };
  }

  pendingProjectClarifications.delete(clarificationKey);
  return {
    replayTaskInput: pending.originalTask,
    projectName: project.name,
  };
}
