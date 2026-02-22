import { describe, expect, it, vi } from 'vitest';
import { ChannelType, type Conversation } from '@/shared/domain/types';
import type { GatewayClient } from '@/server/gateway/client-registry';
import type { MessageRepository, StoredMessage } from '@/server/channels/messages/repository';
import type { RequestFrame } from '@/server/gateway/protocol';

function makeClient(userId = 'user-1'): GatewayClient {
  return {
    socket: {
      readyState: 1,
      OPEN: 1,
      bufferedAmount: 0,
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as GatewayClient['socket'],
    connId: 'conn-e2e-1',
    userId,
    connectedAt: Date.now(),
    subscriptions: new Set(),
    requestCount: 0,
    requestWindowStart: Date.now(),
    seq: 0,
  };
}

function makeRequest(
  method: string,
  params?: Record<string, unknown>,
  id: string | number = 'req-e2e-1',
): RequestFrame {
  return { type: 'req', id, method, params };
}

function buildRepository(personaId: string | null): MessageRepository {
  let seq = 0;
  const conversation: Conversation = {
    id: 'conv-1',
    channelType: ChannelType.WEBCHAT,
    externalChatId: 'default',
    userId: 'user-1',
    title: 'WebChat',
    modelOverride: null,
    personaId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const messages: StoredMessage[] = [];

  const saveMessage = (payload: {
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
      conversationId: payload.conversationId,
      seq,
      role: payload.role,
      content: payload.content,
      platform: payload.platform,
      externalMsgId: payload.externalMsgId ?? null,
      senderName: payload.senderName ?? null,
      metadata: payload.metadata ? JSON.stringify(payload.metadata) : null,
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
    updatePersonaId: (_id, nextPersonaId) => {
      conversation.personaId = nextPersonaId;
      conversation.updatedAt = new Date().toISOString();
    },
    findMessageByClientId: () => null,
  };
}

describe('webui chat.stream persona nexus tool e2e', () => {
  it('runs shell_execute end-to-end through gateway stream path', async () => {
    vi.resetModules();

    const dispatchWithFallbackMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: '',
        provider: 'test-provider',
        model: 'test-model',
        functionCalls: [{ name: 'shell_execute', args: { command: 'echo nexus-e2e' } }],
      })
      .mockResolvedValueOnce({
        ok: true,
        text: '[model-hub-gateway profile=p9 model=test-model] shell flow done',
        provider: 'test-provider',
        model: 'test-model',
      });

    const dispatchSkillMock = vi.fn(async () => ({ stdout: 'nexus-e2e', stderr: '', exitCode: 0 }));

    vi.doMock('../../../src/server/model-hub/runtime', () => ({
      getModelHubService: () => ({ dispatchWithFallback: dispatchWithFallbackMock }),
      getModelHubEncryptionKey: () => 'test-key',
    }));
    vi.doMock('../../../src/server/channels/outbound/router', () => ({
      deliverOutbound: vi.fn(async () => {}),
    }));
    vi.doMock('../../../src/server/gateway/broadcast', () => ({
      broadcastToUser: vi.fn(),
    }));
    vi.doMock('../../../src/server/memory/runtime', () => ({
      getMemoryService: () => ({
        recallDetailed: vi.fn(async () => ({ context: '', matches: [] })),
        store: vi.fn(async () => ({ id: 'mem-1' })),
        updateFeedback: vi.fn(async () => {}),
      }),
    }));
    vi.doMock('../../../src/server/personas/personaRepository', async () => {
      const actual = await vi.importActual('../../../src/server/personas/personaRepository');
      return {
        ...actual,
        getPersonaRepository: () => ({
          getPersonaSystemInstruction: () => 'You are Nexus.',
          getPersona: (id: string) =>
            id === 'persona-nexus'
              ? {
                  id: 'persona-nexus',
                  userId: 'user-1',
                  name: 'Nexus',
                  slug: 'nexus',
                  preferredModelId: 'gpt-4o-mini',
                  modelHubProfileId: 'p9',
                }
              : null,
        }),
      };
    });
    vi.doMock('../../../src/server/skills/skillRepository', () => ({
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
        ],
        getSkill: () => null,
        setInstalled: () => true,
      }),
    }));
    vi.doMock('@/skills/definitions', () => ({
      mapSkillsToTools: () => [
        {
          type: 'function',
          function: {
            name: 'shell_execute',
            description: 'Execute shell',
            parameters: {
              type: 'object',
              properties: {
                command: { type: 'string' },
              },
              required: ['command'],
            },
          },
        },
      ],
    }));
    vi.doMock('../../../src/server/skills/executeSkill', async () => {
      const actual = await vi.importActual('../../../src/server/skills/executeSkill');
      return {
        ...actual,
        dispatchSkill: dispatchSkillMock,
      };
    });

    const { MessageService } = await import('@/server/channels/messages/service');
    const repo = buildRepository(null);
    const service = new MessageService(repo);

    vi.doMock('../../../src/server/channels/messages/runtime', () => ({
      getMessageService: () => service,
      getMessageRepository: () => repo,
    }));

    const { dispatchMethod } = await import('@/server/gateway/method-router');
    await import('@/server/gateway/methods/chat');

    const sent: unknown[] = [];
    await dispatchMethod(
      makeRequest('chat.stream', {
        conversationId: 'conv-1',
        content: 'Bitte teste shell tool',
        personaId: 'persona-nexus',
      }),
      makeClient('user-1'),
      (frame) => sent.push(frame),
    );

    expect(dispatchSkillMock).toHaveBeenCalledWith(
      'shell_execute',
      { command: 'echo nexus-e2e' },
      expect.any(Object),
    );
    expect(dispatchWithFallbackMock).toHaveBeenCalledTimes(2);
    expect(sent).toContainEqual({ type: 'stream', id: 'req-e2e-1', delta: '', done: true });

    const updatedConversation = service.getConversation('conv-1', 'user-1');
    expect(updatedConversation?.personaId).toBe('persona-nexus');
    const messages = service.listMessages('conv-1', 'user-1', 20);
    expect(messages.some((msg) => msg.role === 'agent' && msg.content.includes('shell flow done'))).toBe(
      true,
    );
  });

  it('runs subagents tool call end-to-end through gateway stream path', async () => {
    vi.resetModules();

    const dispatchWithFallbackMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: '',
        provider: 'test-provider',
        model: 'test-model',
        functionCalls: [{ name: 'subagents', args: { action: 'list' } }],
      })
      .mockResolvedValueOnce({
        ok: true,
        text: '[model-hub-gateway profile=p9 model=test-model] subagent flow done',
        provider: 'test-provider',
        model: 'test-model',
      });

    vi.doMock('../../../src/server/model-hub/runtime', () => ({
      getModelHubService: () => ({ dispatchWithFallback: dispatchWithFallbackMock }),
      getModelHubEncryptionKey: () => 'test-key',
    }));
    vi.doMock('../../../src/server/channels/outbound/router', () => ({
      deliverOutbound: vi.fn(async () => {}),
    }));
    vi.doMock('../../../src/server/gateway/broadcast', () => ({
      broadcastToUser: vi.fn(),
    }));
    vi.doMock('../../../src/server/memory/runtime', () => ({
      getMemoryService: () => ({
        recallDetailed: vi.fn(async () => ({ context: '', matches: [] })),
        store: vi.fn(async () => ({ id: 'mem-1' })),
        updateFeedback: vi.fn(async () => {}),
      }),
    }));
    vi.doMock('../../../src/server/personas/personaRepository', async () => {
      const actual = await vi.importActual('../../../src/server/personas/personaRepository');
      return {
        ...actual,
        getPersonaRepository: () => ({
          getPersonaSystemInstruction: () => 'You are Nexus.',
          getPersona: () => ({
            id: 'persona-nexus',
            userId: 'user-1',
            name: 'Nexus',
            slug: 'nexus',
            preferredModelId: 'gpt-4o-mini',
            modelHubProfileId: 'p9',
          }),
        }),
      };
    });
    vi.doMock('../../../src/server/skills/skillRepository', () => ({
      getSkillRepository: async () => ({
        listSkills: () => [
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
    vi.doMock('@/skills/definitions', () => ({
      mapSkillsToTools: () => [
        {
          type: 'function',
          function: {
            name: 'subagents',
            description: 'Manage subagents',
            parameters: { type: 'object', properties: {} },
          },
        },
      ],
    }));

    const { MessageService } = await import('@/server/channels/messages/service');
    const repo = buildRepository('persona-nexus');
    const service = new MessageService(repo);

    vi.doMock('../../../src/server/channels/messages/runtime', () => ({
      getMessageService: () => service,
      getMessageRepository: () => repo,
    }));

    const { dispatchMethod } = await import('@/server/gateway/method-router');
    await import('@/server/gateway/methods/chat');

    const sent: unknown[] = [];
    await dispatchMethod(
      makeRequest(
        'chat.stream',
        {
          conversationId: 'conv-1',
          content: 'Teste Subagents',
          personaId: 'persona-nexus',
        },
        'req-e2e-2',
      ),
      makeClient('user-1'),
      (frame) => sent.push(frame),
    );

    expect(dispatchWithFallbackMock).toHaveBeenCalledTimes(2);
    expect(sent).toContainEqual({ type: 'stream', id: 'req-e2e-2', delta: '', done: true });
    const messages = service.listMessages('conv-1', 'user-1', 20);
    expect(
      messages.some(
        (msg) =>
          msg.role === 'agent' &&
          (msg.content.includes('Subagents') || msg.content.includes('subagent flow done')),
      ),
    ).toBe(true);
  });
});
