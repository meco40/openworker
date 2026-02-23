import { beforeEach, describe, expect, it } from 'vitest';
import { ChannelType } from '@/shared/domain/types';
import { SqliteMessageRepository } from '@/server/channels/messages/sqliteMessageRepository';

describe('project repository persistence', () => {
  let repo: SqliteMessageRepository;
  const userId = 'user-projects';

  beforeEach(() => {
    repo = new SqliteMessageRepository(':memory:');
  });

  it('creates and lists persona-scoped projects', () => {
    const projectRepo = repo as unknown as {
      createProject: (input: {
        userId: string;
        personaId: string;
        name: string;
        workspacePath: string;
        workspaceRelativePath?: string;
      }) => { id: string; personaId: string; slug: string; name: string };
      listProjectsByPersona: (
        personaId: string,
        userId: string,
      ) => Array<{ id: string; personaId: string; name: string }>;
    };

    const created = projectRepo.createProject({
      userId,
      personaId: 'persona-a',
      name: 'Notes',
      workspacePath: 'D:/work/persona-a/projects/notes',
      workspaceRelativePath: 'personas/persona-a/projects/notes',
    });
    expect(created.name).toBe('Notes');
    expect(created.slug).toContain('notes');

    const listed = projectRepo.listProjectsByPersona('persona-a', userId);
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(created.id);
    expect(listed[0].personaId).toBe('persona-a');
  });

  it('stores active conversation project and guard state', () => {
    const projectRepo = repo as unknown as {
      createProject: (input: {
        userId: string;
        personaId: string;
        name: string;
        workspacePath: string;
      }) => { id: string };
      setActiveProjectForConversation: (
        conversationId: string,
        userId: string,
        projectId: string | null,
      ) => void;
      getConversationProjectState: (
        conversationId: string,
        userId: string,
      ) => { activeProjectId: string | null; guardApprovedWithoutProject: boolean };
      setConversationProjectGuardApproved: (
        conversationId: string,
        userId: string,
        approved: boolean,
      ) => void;
    };

    const conversation = repo.createConversation({
      channelType: ChannelType.WEBCHAT,
      externalChatId: 'default',
      userId,
      personaId: 'persona-a',
      title: 'Projects',
    });
    const project = projectRepo.createProject({
      userId,
      personaId: 'persona-a',
      name: 'Notes',
      workspacePath: 'D:/work/persona-a/projects/notes',
    });

    projectRepo.setConversationProjectGuardApproved(conversation.id, userId, true);
    let state = projectRepo.getConversationProjectState(conversation.id, userId);
    expect(state.guardApprovedWithoutProject).toBe(true);
    expect(state.activeProjectId).toBeNull();

    projectRepo.setActiveProjectForConversation(conversation.id, userId, project.id);
    state = projectRepo.getConversationProjectState(conversation.id, userId);
    expect(state.activeProjectId).toBe(project.id);
    expect(state.guardApprovedWithoutProject).toBe(false);
  });

  it('rejects assigning cross-persona project to conversation', () => {
    const projectRepo = repo as unknown as {
      createProject: (input: {
        userId: string;
        personaId: string;
        name: string;
        workspacePath: string;
      }) => { id: string };
      setActiveProjectForConversation: (
        conversationId: string,
        userId: string,
        projectId: string | null,
      ) => void;
    };

    const conversation = repo.createConversation({
      channelType: ChannelType.WEBCHAT,
      externalChatId: 'default',
      userId,
      personaId: 'persona-a',
      title: 'Projects',
    });
    const otherPersonaProject = projectRepo.createProject({
      userId,
      personaId: 'persona-b',
      name: 'Foreign',
      workspacePath: 'D:/work/persona-b/projects/foreign',
    });

    expect(() =>
      projectRepo.setActiveProjectForConversation(conversation.id, userId, otherPersonaProject.id),
    ).toThrow(/persona/i);
  });
});
