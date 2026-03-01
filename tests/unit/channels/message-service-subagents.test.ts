import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType } from '@/shared/domain/types';
import type { Conversation } from '@/shared/domain/types';
import type {
  MessageRepository,
  PersonaProjectRecord,
  StoredMessage,
} from '@/server/channels/messages/repository';
import { resetSubagentRegistryForTests } from '@/server/agents/subagentRegistry';
import { getTestArtifactsRoot } from '../../helpers/testArtifacts';

const dispatchWithFallbackMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/server/model-hub/runtime', () => ({
  getModelHubService: () => ({
    dispatchWithFallback: dispatchWithFallbackMock,
  }),
  getModelHubEncryptionKey: () => 'test-key',
}));

vi.mock('../../../src/server/channels/outbound/router', () => ({
  deliverOutbound: vi.fn(async () => {}),
}));

vi.mock('../../../src/server/gateway/broadcast', () => ({
  broadcastToUser: vi.fn(),
}));

vi.mock('../../../src/server/memory/runtime', () => ({
  getMemoryService: () => ({
    recallDetailed: vi.fn(async () => ({ context: '', matches: [] })),
    store: vi.fn(async () => ({ id: 'mem-1' })),
    updateFeedback: vi.fn(async () => {}),
  }),
}));

vi.mock('../../../src/server/personas/personaRepository', async () => {
  const actual = await vi.importActual('../../../src/server/personas/personaRepository');
  return {
    ...actual,
    getPersonaRepository: () => ({
      getPersonaSystemInstruction: () => 'You are a specialist persona.',
      getPersona: () => ({
        id: 'persona-1',
        slug: 'persona_1',
        userId: 'user-1',
        preferredModelId: 'gpt-4o-mini',
        modelHubProfileId: 'p9',
      }),
    }),
  };
});

vi.mock('../../../src/server/skills/skillRepository', () => ({
  getSkillRepository: async () => ({
    listSkills: () => [
      {
        id: 'shell-access',
        name: 'Safe Shell',
        description: 'Shell skill',
        category: 'Automation',
        version: '1.0.0',
        installed: true,
        functionName: 'shell_execute',
        source: 'built-in',
        sourceUrl: null,
      },
      {
        id: 'subagents',
        name: 'Subagents',
        description: 'Subagent orchestration',
        category: 'Automation',
        version: '1.0.0',
        installed: true,
        functionName: 'subagents',
        source: 'built-in',
        sourceUrl: null,
      },
    ],
    getSkill: () => null,
    setInstalled: () => true,
  }),
}));

vi.mock('@/skills/definitions', () => ({
  mapSkillsToTools: () => [],
}));

import { MessageService } from '@/server/channels/messages/service';

function buildRepository(options?: {
  personaId?: string | null;
  activeProject?: PersonaProjectRecord;
}): MessageRepository {
  let seq = 0;
  const personaId = options?.personaId ?? null;
  const projects = options?.activeProject ? [options.activeProject] : [];
  let activeProjectId = options?.activeProject?.id ?? null;
  const conversation: Conversation = {
    id: 'conv-1',
    channelType: ChannelType.WEBCHAT,
    externalChatId: 'default',
    userId: 'user-1',
    title: 'Chat',
    modelOverride: null,
    personaId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const messages: StoredMessage[] = [];

  const saveMessage = ({
    conversationId,
    role,
    content,
    platform,
    externalMsgId,
    senderName,
    metadata,
  }: {
    conversationId: string;
    role: 'user' | 'agent' | 'system';
    content: string;
    platform: ChannelType;
    externalMsgId?: string;
    senderName?: string;
    metadata?: Record<string, unknown>;
  }): StoredMessage => {
    const entry: StoredMessage = {
      id: `msg-${++seq}`,
      conversationId,
      seq,
      role,
      content,
      platform,
      externalMsgId: externalMsgId ?? null,
      senderName: senderName ?? null,
      metadata: metadata ? JSON.stringify(metadata) : null,
      createdAt: new Date().toISOString(),
    };
    messages.push(entry);
    return entry;
  };

  return {
    createConversation: () => conversation,
    getConversation: () => conversation,
    getConversationByExternalChat: () => conversation,
    getOrCreateConversation: () => conversation,
    listConversations: () => [conversation],
    updateConversationTitle: () => {},
    saveMessage,
    listMessages: () => [...messages],
    getDefaultWebChatConversation: () => conversation,
    getConversationContext: () => null,
    upsertConversationContext: () => ({
      conversationId: conversation.id,
      summaryText: '',
      summaryUptoSeq: 0,
      updatedAt: new Date().toISOString(),
      userId: conversation.userId,
    }),
    deleteConversation: () => true,
    updateModelOverride: () => {},
    updatePersonaId: () => {},
    findMessageByClientId: () => null,
    getProjectByIdOrSlug: (projectPersonaId, projectUserId, idOrSlug) => {
      const normalized = String(idOrSlug || '').trim();
      if (!normalized) return null;
      return (
        projects.find(
          (project) =>
            project.userId === projectUserId &&
            project.personaId === projectPersonaId &&
            (project.id === normalized || project.slug === normalized),
        ) || null
      );
    },
    getConversationProjectState: () => ({
      conversationId: conversation.id,
      activeProjectId,
      guardApprovedWithoutProject: false,
      updatedAt: new Date().toISOString(),
    }),
    setActiveProjectForConversation: (_conversationId, _userId, projectId) => {
      activeProjectId = projectId;
    },
  };
}

describe('MessageService subagents commands and tool calls', () => {
  afterEach(() => {
    const root = process.env.PERSONAS_ROOT_PATH;
    delete process.env.PERSONAS_ROOT_PATH;
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    resetSubagentRegistryForTests();
    dispatchWithFallbackMock.mockReset();
    process.env.PERSONAS_ROOT_PATH = path.resolve(
      getTestArtifactsRoot(),
      `personas.subagent.test.${Date.now()}.${Math.random().toString(36).slice(2)}`,
    );
  });

  it('spawns, lists and kills subagents via slash commands', async () => {
    dispatchWithFallbackMock.mockImplementation(
      async (
        _profile: unknown,
        _key: unknown,
        _request: unknown,
        options?: { signal?: AbortSignal },
      ) =>
        new Promise((resolve, reject) => {
          const onAbort = () => {
            const abortError = new Error('aborted');
            (abortError as Error & { name: string }).name = 'AbortError';
            reject(abortError);
          };
          if (options?.signal?.aborted) {
            onAbort();
            return;
          }
          options?.signal?.addEventListener('abort', onAbort, { once: true });
          // Keep pending until explicitly aborted in this test.
          void resolve;
        }),
    );

    const service = new MessageService(buildRepository({ personaId: 'persona-1' }));
    const spawn = await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      '/subagents spawn researcher pruefe den aktuellen status',
      undefined,
      undefined,
      'user-1',
    );
    expect(spawn.agentMsg.content).toContain('Spawned subagent researcher');

    const listed = await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      '/subagents list',
      undefined,
      undefined,
      'user-1',
    );
    expect(listed.agentMsg.content).toContain('active:');
    expect(listed.agentMsg.content).toContain('researcher');

    const killed = await service.handleInbound(
      ChannelType.WEBCHAT,
      'default',
      '/kill #1',
      undefined,
      undefined,
      'user-1',
    );
    expect(killed.agentMsg.content).toContain('Killed researcher');
  });

  it('supports tool-level spawn/list through subagents handler entrypoint', async () => {
    dispatchWithFallbackMock.mockResolvedValue({
      ok: true,
      text: 'subagent done',
      provider: 'test-provider',
      model: 'test-model',
    });

    const service = new MessageService(buildRepository({ personaId: 'persona-1' }));
    const spawned = await service.invokeSubagentToolCall({
      args: { action: 'spawn', agentId: 'planner', task: 'collect findings' },
      conversationId: 'conv-1',
      userId: 'user-1',
      platform: ChannelType.WEBCHAT,
      externalChatId: 'default',
    });
    expect(spawned.status).toBe('accepted');
    expect(String(spawned.text || '')).toContain('Spawned subagent planner');
    expect(spawned.workspacePath ?? null).toBeNull();

    const listed = await service.invokeSubagentToolCall({
      args: { action: 'list' },
      conversationId: 'conv-1',
      userId: 'user-1',
      platform: ChannelType.WEBCHAT,
      externalChatId: 'default',
    });
    expect(listed.status).toBe('ok');
    expect(String(listed.text || '')).toContain('Subagents');
  });

  it('attaches agent profile tools/skills metadata for qa agents', async () => {
    dispatchWithFallbackMock.mockResolvedValue({
      ok: true,
      text: 'qa done',
      provider: 'test-provider',
      model: 'test-model',
    });

    const service = new MessageService(buildRepository({ personaId: 'persona-1' }));
    const spawned = await service.invokeSubagentToolCall({
      args: { action: 'spawn', agentId: 'qa', task: 'run browser regression checks' },
      conversationId: 'conv-1',
      userId: 'user-1',
      platform: ChannelType.WEBCHAT,
      externalChatId: 'default',
    });

    expect(spawned.status).toBe('accepted');
    expect(spawned.profileId).toBe('qa');
    expect(Array.isArray(spawned.toolFunctionNames)).toBe(true);
    expect((spawned.toolFunctionNames as string[]).includes('playwright_cli')).toBe(true);
    expect(Array.isArray(spawned.skillIds)).toBe(true);
    expect((spawned.skillIds as string[]).includes('playwright-cli')).toBe(true);
  });

  it('inherits active project workspace when conversation project is set', async () => {
    const workspacePath = path.join(
      String(process.env.PERSONAS_ROOT_PATH || ''),
      'persona_1',
      'projects',
      'notes',
    );
    fs.mkdirSync(workspacePath, { recursive: true });
    const now = new Date().toISOString();
    const service = new MessageService(
      buildRepository({
        personaId: 'persona-1',
        activeProject: {
          id: 'project-notes',
          userId: 'user-1',
          personaId: 'persona-1',
          name: 'Notes',
          slug: 'notes',
          workspacePath,
          workspaceRelativePath: 'persona_1/projects/notes',
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    const spawned = await service.invokeSubagentToolCall({
      args: { action: 'spawn', agentId: 'planner', task: 'collect findings' },
      conversationId: 'conv-1',
      userId: 'user-1',
      platform: ChannelType.WEBCHAT,
      externalChatId: 'default',
    });

    expect(spawned.status).toBe('accepted');
    expect(spawned.projectId).toBe('project-notes');
    expect(spawned.workspacePath).toBe(workspacePath);
  });
});
