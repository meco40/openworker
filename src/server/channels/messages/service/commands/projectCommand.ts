import type { ChannelType } from '@/shared/domain/types';
import type { Conversation, StoredMessage } from '@/server/channels/messages/repository';
import { getPersonaRepository } from '@/server/personas/personaRepository';
import {
  createPersonaProjectWorkspace,
  removePersonaProjectWorkspace,
} from '@/server/personas/personaProjectWorkspace';
import type { CommandHandlerDeps } from './types';

export async function handleProjectCommand(
  conversation: Conversation,
  payload: string,
  platform: ChannelType,
  externalChatId: string,
  repo: {
    createProject?: (input: {
      userId: string;
      personaId: string;
      name: string;
      workspacePath: string;
      workspaceRelativePath?: string;
    }) => { id: string; name: string; slug: string; workspacePath: string };
    listProjectsByPersona?: (
      personaId: string,
      userId: string,
    ) => Array<{ id: string; name: string; slug: string; workspacePath: string }>;
    getProjectByIdOrSlug?: (
      personaId: string,
      userId: string,
      idOrSlug: string,
    ) => { id: string; name: string; slug: string; workspacePath: string } | null;
    deleteProjectByIdOrSlug?: (
      personaId: string,
      userId: string,
      idOrSlug: string,
    ) => { id: string; name: string; slug: string; workspacePath: string } | null;
    setActiveProjectForConversation?: (
      conversationId: string,
      userId: string,
      projectId: string | null,
    ) => void;
    getConversationProjectState?: (
      conversationId: string,
      userId: string,
    ) => { activeProjectId: string | null };
  },
  sendResponse: CommandHandlerDeps['sendResponse'],
): Promise<StoredMessage> {
  if (!conversation.personaId) {
    return sendResponse(
      conversation,
      '⚠️ Kein Persona-Kontext aktiv. Bitte zuerst `/persona <name>` setzen.',
      platform,
      externalChatId,
    );
  }

  if (
    typeof repo.createProject !== 'function' ||
    typeof repo.listProjectsByPersona !== 'function' ||
    typeof repo.getProjectByIdOrSlug !== 'function' ||
    typeof repo.deleteProjectByIdOrSlug !== 'function' ||
    typeof repo.setActiveProjectForConversation !== 'function' ||
    typeof repo.getConversationProjectState !== 'function'
  ) {
    return sendResponse(
      conversation,
      '⚠️ Projektverwaltung ist in diesem Runtime-Modus nicht verfügbar.',
      platform,
      externalChatId,
    );
  }

  const trimmed = String(payload || '').trim();
  const [rawAction, ...restTokens] = trimmed.split(/\s+/).filter(Boolean);
  const action = String(rawAction || 'status').toLowerCase();
  const rest = restTokens.join(' ').trim();
  const listProjectsByPersona = (personaId: string, userId: string) =>
    repo.listProjectsByPersona!(personaId, userId);
  const getProjectByIdOrSlug = (personaId: string, userId: string, idOrSlug: string) =>
    repo.getProjectByIdOrSlug!(personaId, userId, idOrSlug);
  const deleteProjectByIdOrSlug = (personaId: string, userId: string, idOrSlug: string) =>
    repo.deleteProjectByIdOrSlug!(personaId, userId, idOrSlug);
  const setActiveProjectForConversation = (
    conversationId: string,
    userId: string,
    projectId: string | null,
  ) => repo.setActiveProjectForConversation!(conversationId, userId, projectId);
  const getConversationProjectState = (conversationId: string, userId: string) =>
    repo.getConversationProjectState!(conversationId, userId);
  const createProject = (input: {
    userId: string;
    personaId: string;
    name: string;
    workspacePath: string;
    workspaceRelativePath?: string;
  }) => repo.createProject!(input);
  const resolveProjectByIdentifier = (
    identifier: string,
  ): { id: string; name: string; slug: string; workspacePath: string } | null => {
    const normalized = String(identifier || '').trim();
    if (!normalized) return null;

    if (/^\d+$/.test(normalized)) {
      const index = Number.parseInt(normalized, 10);
      if (Number.isFinite(index) && index > 0) {
        const projects = listProjectsByPersona(conversation.personaId!, conversation.userId);
        return projects[index - 1] || null;
      }
    }

    return getProjectByIdOrSlug(conversation.personaId!, conversation.userId, normalized);
  };

  if (action === 'new') {
    const name = rest;
    if (!name) {
      return sendResponse(conversation, 'Usage: /project new <name>', platform, externalChatId);
    }
    const persona = getPersonaRepository().getPersona(conversation.personaId);
    if (!persona?.slug) {
      return sendResponse(
        conversation,
        '⚠️ Aktive Persona nicht gefunden.',
        platform,
        externalChatId,
      );
    }

    const workspace = createPersonaProjectWorkspace({
      personaSlug: persona.slug,
      task: name,
      requestedName: name,
    });
    const project = createProject({
      userId: conversation.userId,
      personaId: conversation.personaId,
      name,
      workspacePath: workspace.absolutePath,
      workspaceRelativePath: workspace.relativePath,
    });
    setActiveProjectForConversation(conversation.id, conversation.userId, project.id);

    return sendResponse(
      conversation,
      `✅ Projekt erstellt und aktiv: ${project.name}\nID: ${project.id}\nSlug: ${project.slug}`,
      platform,
      externalChatId,
    );
  }

  if (action === 'list') {
    const projects = listProjectsByPersona(conversation.personaId, conversation.userId);
    if (projects.length === 0) {
      return sendResponse(
        conversation,
        'Keine Projekte vorhanden. Erzeuge eines mit `/project new <name>`.',
        platform,
        externalChatId,
      );
    }
    const lines = ['📁 Projekte:', ''];
    projects.forEach((project, index) => {
      lines.push(`${index + 1}. ${project.name} (${project.slug})`);
    });
    return sendResponse(conversation, lines.join('\n'), platform, externalChatId);
  }

  if (action === 'use') {
    const identifier = rest;
    if (!identifier) {
      return sendResponse(
        conversation,
        'Usage: /project use <id|slug|index>',
        platform,
        externalChatId,
      );
    }
    const project = resolveProjectByIdentifier(identifier);
    if (!project) {
      return sendResponse(
        conversation,
        `⚠️ Projekt nicht gefunden: ${identifier}`,
        platform,
        externalChatId,
      );
    }
    setActiveProjectForConversation(conversation.id, conversation.userId, project.id);
    return sendResponse(
      conversation,
      `✅ Aktives Projekt: ${project.name} (${project.slug})`,
      platform,
      externalChatId,
    );
  }

  if (action === 'delete' || action === 'remove') {
    const identifier = rest;
    if (!identifier) {
      return sendResponse(
        conversation,
        'Usage: /project delete <id|slug|index>',
        platform,
        externalChatId,
      );
    }

    const persona = getPersonaRepository().getPersona(conversation.personaId);
    if (!persona?.slug) {
      return sendResponse(
        conversation,
        '⚠️ Aktive Persona nicht gefunden.',
        platform,
        externalChatId,
      );
    }

    const project = resolveProjectByIdentifier(identifier);
    if (!project) {
      return sendResponse(
        conversation,
        `⚠️ Projekt nicht gefunden: ${identifier}`,
        platform,
        externalChatId,
      );
    }

    const wasActiveInConversation =
      getConversationProjectState(conversation.id, conversation.userId).activeProjectId ===
      project.id;

    try {
      removePersonaProjectWorkspace({
        personaSlug: persona.slug,
        workspacePath: project.workspacePath,
      });
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : 'Workspace konnte nicht gelöscht werden.';
      return sendResponse(
        conversation,
        `⚠️ Projekt-Workspace konnte nicht gelöscht werden: ${detail}`,
        platform,
        externalChatId,
      );
    }

    const deleted = deleteProjectByIdOrSlug(
      conversation.personaId,
      conversation.userId,
      project.id,
    );
    if (!deleted) {
      return sendResponse(
        conversation,
        '⚠️ Projekt konnte nicht gelöscht werden.',
        platform,
        externalChatId,
      );
    }

    return sendResponse(
      conversation,
      wasActiveInConversation
        ? `🗑️ Projekt gelöscht: ${deleted.name} (${deleted.slug})\nAktives Projekt wurde entfernt.`
        : `🗑️ Projekt gelöscht: ${deleted.name} (${deleted.slug})`,
      platform,
      externalChatId,
    );
  }

  if (action === 'clear') {
    setActiveProjectForConversation(conversation.id, conversation.userId, null);
    return sendResponse(conversation, 'Aktives Projekt wurde entfernt.', platform, externalChatId);
  }

  const state = getConversationProjectState(conversation.id, conversation.userId);
  if (!state.activeProjectId) {
    return sendResponse(
      conversation,
      'Kein aktives Projekt gesetzt. Nutze `/project new <name>` oder `/project use <id|slug|index>`.',
      platform,
      externalChatId,
    );
  }

  const project = getProjectByIdOrSlug(
    conversation.personaId,
    conversation.userId,
    state.activeProjectId,
  );
  if (!project) {
    return sendResponse(
      conversation,
      'Aktives Projekt nicht mehr verfügbar.',
      platform,
      externalChatId,
    );
  }
  return sendResponse(
    conversation,
    `Aktives Projekt: ${project.name}\nID: ${project.id}\nSlug: ${project.slug}`,
    platform,
    externalChatId,
  );
}
