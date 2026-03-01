import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTestArtifactsRoot } from '../../helpers/testArtifacts';

function mockUserContext(context: { userId: string; authenticated: boolean } | null): void {
  vi.doMock('../../../src/server/auth/userContext', () => ({
    resolveRequestUserContext: vi.fn().mockResolvedValue(context),
  }));
}

async function loadPersonasRoute() {
  return import('../../../app/api/personas/route');
}

async function loadPersonaByIdRoute() {
  return import('../../../app/api/personas/[id]/route');
}

async function loadMemoryRoute() {
  return import('../../../app/api/memory/route');
}

function makeMemoryPostRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/memory', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function memoryScopeKey(userId: string, personaId: string): string {
  return `${userId}::${personaId}`;
}

describe('persona memory cascade delete', () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.PERSONAS_DB_PATH;
    delete process.env.MESSAGES_DB_PATH;
    delete process.env.MEMORY_PROVIDER;
    delete process.env.MEM0_BASE_URL;
    delete process.env.MEM0_API_PATH;
    delete process.env.MEM0_API_KEY;
    (globalThis as { __memoryService?: unknown }).__memoryService = undefined;
    (globalThis as { __mem0Client?: unknown }).__mem0Client = undefined;
    (globalThis as { __modelHubService?: unknown }).__modelHubService = undefined;
    (globalThis as { __messageRepository?: unknown }).__messageRepository = undefined;
    (globalThis as { __messageService?: unknown }).__messageService = undefined;
    (globalThis as { __knowledgeRepository?: unknown }).__knowledgeRepository = undefined;
    (globalThis as { __knowledgeMessageRepository?: unknown }).__knowledgeMessageRepository =
      undefined;
    (globalThis as { __knowledgeRuntimeLoop?: unknown }).__knowledgeRuntimeLoop = undefined;
    (globalThis as { __knowledgeRetrievalService?: unknown }).__knowledgeRetrievalService =
      undefined;
    (globalThis as { __knowledgeIngestionService?: unknown }).__knowledgeIngestionService =
      undefined;
    (globalThis as { __knowledgeCursor?: unknown }).__knowledgeCursor = undefined;
    (globalThis as { __knowledgeExtractor?: unknown }).__knowledgeExtractor = undefined;
    vi.unstubAllGlobals();

    for (const filePath of cleanupPaths.splice(0, cleanupPaths.length)) {
      for (const candidate of [filePath, `${filePath}-wal`, `${filePath}-shm`]) {
        try {
          if (fs.existsSync(candidate)) {
            fs.unlinkSync(candidate);
          }
        } catch {
          // ignore file lock in tests
        }
      }
    }
  });

  it('deletes memory entries when persona is deleted', async () => {
    const personasDbPath = path.join(
      getTestArtifactsRoot(),
      `personas.memory-cascade.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
    );
    const messagesDbPath = path.join(
      getTestArtifactsRoot(),
      `messages.memory-cascade.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
    );
    cleanupPaths.push(personasDbPath, messagesDbPath);
    process.env.PERSONAS_DB_PATH = personasDbPath;
    process.env.MESSAGES_DB_PATH = messagesDbPath;
    process.env.MEMORY_PROVIDER = 'mem0';
    process.env.MEM0_BASE_URL = 'http://mem0.local';
    process.env.MEM0_API_PATH = '/v1';
    process.env.MEM0_API_KEY = 'mem0_test_key';

    const memoryStore = new Map<
      string,
      Array<{ id: string; content: string; metadata: Record<string, unknown> }>
    >();
    const defaultUser = 'user-a';

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input.toString();
        const parsed = new URL(url);
        const method = String(init?.method || 'GET').toUpperCase();
        const body = (() => {
          if (!init?.body || typeof init.body !== 'string') return {} as Record<string, unknown>;
          try {
            return JSON.parse(init.body) as Record<string, unknown>;
          } catch {
            return {} as Record<string, unknown>;
          }
        })();

        if (method === 'POST' && parsed.pathname.endsWith('/v1/memories')) {
          const userId = String(body.user_id || defaultUser);
          const personaId = String(body.agent_id || 'persona-default');
          const messages = Array.isArray(body.messages) ? body.messages : [];
          const content = String((messages[0] as { content?: string } | undefined)?.content || '');
          const id = `mem0-${Math.random().toString(36).slice(2, 10)}`;
          const key = memoryScopeKey(userId, personaId);
          const next = [
            ...(memoryStore.get(key) || []),
            { id, content, metadata: (body.metadata as Record<string, unknown>) || {} },
          ];
          memoryStore.set(key, next);
          return new Response(JSON.stringify([{ id, memory: content }]), { status: 200 });
        }

        if (method === 'POST' && parsed.pathname.endsWith('/v2/memories')) {
          const filters = (body.filters as Record<string, unknown>) || {};
          const userId = String(filters.user_id || defaultUser);
          const personaId = String(filters.agent_id || '');
          const key = memoryScopeKey(userId, personaId);
          const rows = personaId ? memoryStore.get(key) || [] : [];
          return new Response(
            JSON.stringify({
              memories: rows.map((row) => ({
                id: row.id,
                memory: row.content,
                metadata: row.metadata,
              })),
              total: rows.length,
              page: 1,
              page_size: 25,
            }),
            { status: 200 },
          );
        }

        if (method === 'DELETE' && parsed.pathname.endsWith('/v1/memories')) {
          const userId = String(body.user_id || defaultUser);
          const personaId = String(body.agent_id || '');
          const key = memoryScopeKey(userId, personaId);
          const deleted = (memoryStore.get(key) || []).length;
          memoryStore.delete(key);
          return new Response(JSON.stringify({ deleted }), { status: 200 });
        }

        return new Response(JSON.stringify({ error: `Unhandled ${method} ${parsed.pathname}` }), {
          status: 500,
        });
      }) as unknown as typeof fetch,
    );

    mockUserContext({ userId: 'user-a', authenticated: true });

    (globalThis as { __modelHubService?: unknown }).__modelHubService = {
      dispatchEmbedding: vi.fn(async () => ({ embedding: { values: [1, 0] } })),
    };

    const personasRoute = await loadPersonasRoute();
    const createResponse = await personasRoute.POST(
      new Request('http://localhost/api/personas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Memory Persona' }),
      }),
    );
    const createPayload = (await createResponse.json()) as {
      ok: boolean;
      persona: { id: string };
    };

    expect(createResponse.status).toBe(201);
    expect(createPayload.ok).toBe(true);
    const personaId = createPayload.persona.id;

    const memoryRoute = await loadMemoryRoute();
    const storeResponse = await memoryRoute.POST(
      makeMemoryPostRequest({
        fcName: 'core_memory_store',
        args: { personaId, type: 'fact', content: 'likes lasagna', importance: 5 },
      }),
    );
    expect(storeResponse.status).toBe(200);

    const beforeDeleteResponse = await memoryRoute.GET(
      new Request(`http://localhost/api/memory?personaId=${encodeURIComponent(personaId)}`),
    );
    const beforeDeletePayload = (await beforeDeleteResponse.json()) as {
      ok: boolean;
      nodes: Array<{ content: string }>;
    };
    expect(beforeDeleteResponse.status).toBe(200);
    expect(beforeDeletePayload.ok).toBe(true);
    expect(beforeDeletePayload.nodes).toHaveLength(1);

    const { ChannelType } = await import('@/shared/domain/types');
    const { getMessageRepository } = await import('@/server/channels/messages/runtime');
    const messageRepo = getMessageRepository();
    const conversation = messageRepo.createConversation({
      channelType: ChannelType.WEBCHAT,
      title: 'Persona Scope',
      userId: defaultUser,
      personaId,
    });
    messageRepo.saveMessage({
      conversationId: conversation.id,
      role: 'user',
      content: 'persona scoped chat',
      platform: ChannelType.WEBCHAT,
    });
    messageRepo.upsertConversationContext(conversation.id, 'persona summary', 1, defaultUser);

    const { getKnowledgeRepository } = await import('@/server/knowledge/runtime');
    const knowledgeRepo = getKnowledgeRepository();
    knowledgeRepo.upsertIngestionCheckpoint({
      conversationId: conversation.id,
      personaId,
      lastSeq: 1,
    });
    knowledgeRepo.upsertEpisode({
      userId: defaultUser,
      personaId,
      conversationId: conversation.id,
      topicKey: 'topic-delete',
      counterpart: null,
      teaser: 'teaser',
      episode: 'episode',
      facts: ['fact'],
      sourceSeqStart: 1,
      sourceSeqEnd: 1,
      sourceRefs: [],
      eventAt: null,
    });
    knowledgeRepo.upsertMeetingLedger({
      userId: defaultUser,
      personaId,
      conversationId: conversation.id,
      topicKey: 'topic-delete',
      counterpart: null,
      eventAt: null,
      participants: [],
      decisions: [],
      negotiatedTerms: [],
      openPoints: [],
      actionItems: [],
      sourceRefs: [],
      confidence: 0.8,
    });
    knowledgeRepo.insertRetrievalAudit({
      userId: defaultUser,
      personaId,
      conversationId: conversation.id,
      query: 'q',
      stageStats: {},
      tokenCount: 1,
      hadError: false,
    });
    knowledgeRepo.upsertConversationSummary({
      userId: defaultUser,
      personaId,
      conversationId: conversation.id,
      summaryText: 'summary',
      keyTopics: ['topic-delete'],
      entitiesMentioned: ['Max'],
      emotionalTone: null,
      messageCount: 2,
      timeRangeStart: '2026-02-15T09:00:00.000Z',
      timeRangeEnd: '2026-02-15T09:10:00.000Z',
    });
    knowledgeRepo.upsertEvent({
      id: 'evt-cascade-1',
      userId: defaultUser,
      personaId,
      conversationId: conversation.id,
      eventType: 'shared_sleep',
      speakerRole: 'assistant',
      speakerEntity: 'Nata',
      subjectEntity: 'Nata',
      counterpartEntity: 'Max',
      relationLabel: 'Bruder',
      startDate: '2026-02-15',
      endDate: '2026-02-16',
      dayCount: 2,
      sourceSeqJson: '[1]',
      sourceSummary: 'summary',
      isConfirmation: false,
      confidence: 0.9,
    });
    knowledgeRepo.upsertEntity({
      id: 'ent-cascade-1',
      userId: defaultUser,
      personaId,
      canonicalName: 'Max',
      category: 'person',
      owner: 'persona',
      properties: {},
    });

    expect(messageRepo.getConversation(conversation.id, defaultUser)).not.toBeNull();
    expect(messageRepo.getConversationContext(conversation.id, defaultUser)).not.toBeNull();
    expect(knowledgeRepo.listEpisodes({ userId: defaultUser, personaId })).toHaveLength(1);
    expect(knowledgeRepo.listMeetingLedger({ userId: defaultUser, personaId })).toHaveLength(1);
    expect(knowledgeRepo.listRetrievalAudit({ userId: defaultUser, personaId })).toHaveLength(1);
    expect(
      knowledgeRepo.listConversationSummaries({ userId: defaultUser, personaId }),
    ).toHaveLength(1);
    expect(knowledgeRepo.listEvents({ userId: defaultUser, personaId })).toHaveLength(1);
    expect(knowledgeRepo.listEntities({ userId: defaultUser, personaId })).toHaveLength(1);
    expect(knowledgeRepo.getIngestionCheckpoint(conversation.id, personaId)).not.toBeNull();

    const personaByIdRoute = await loadPersonaByIdRoute();
    const deleteResponse = await personaByIdRoute.DELETE(
      new Request(`http://localhost/api/personas/${personaId}`, { method: 'DELETE' }),
      { params: Promise.resolve({ id: personaId }) },
    );
    expect(deleteResponse.status).toBe(200);

    const afterDeleteResponse = await memoryRoute.GET(
      new Request(`http://localhost/api/memory?personaId=${encodeURIComponent(personaId)}`),
    );
    const afterDeletePayload = (await afterDeleteResponse.json()) as {
      ok: boolean;
      nodes: Array<{ content: string }>;
    };
    expect(afterDeleteResponse.status).toBe(200);
    expect(afterDeletePayload.ok).toBe(true);
    expect(afterDeletePayload.nodes).toHaveLength(0);
    expect(messageRepo.getConversation(conversation.id, defaultUser)).toBeNull();
    expect(messageRepo.listMessages(conversation.id, 50, undefined, defaultUser)).toHaveLength(0);
    expect(messageRepo.getConversationContext(conversation.id, defaultUser)).toBeNull();
    expect(knowledgeRepo.listEpisodes({ userId: defaultUser, personaId })).toHaveLength(0);
    expect(knowledgeRepo.listMeetingLedger({ userId: defaultUser, personaId })).toHaveLength(0);
    expect(knowledgeRepo.listRetrievalAudit({ userId: defaultUser, personaId })).toHaveLength(0);
    expect(
      knowledgeRepo.listConversationSummaries({ userId: defaultUser, personaId }),
    ).toHaveLength(0);
    expect(knowledgeRepo.listEvents({ userId: defaultUser, personaId })).toHaveLength(0);
    expect(knowledgeRepo.listEntities({ userId: defaultUser, personaId })).toHaveLength(0);
    expect(knowledgeRepo.getIngestionCheckpoint(conversation.id, personaId)).toBeNull();
  }, 15_000);

  it('unpairs persona telegram bot when persona is deleted', async () => {
    const personasDbPath = path.join(
      getTestArtifactsRoot(),
      `personas.telegram-unpair.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
    );
    cleanupPaths.push(personasDbPath);
    process.env.PERSONAS_DB_PATH = personasDbPath;
    process.env.MEMORY_PROVIDER = 'mem0';
    process.env.MEM0_BASE_URL = 'http://mem0.local';
    process.env.MEM0_API_PATH = '/v1';
    process.env.MEM0_API_KEY = 'mem0_test_key';

    const unpairPersonaTelegram = vi.fn(async () => {});
    vi.doMock('../../../src/server/telegram/personaTelegramPairing', () => ({
      unpairPersonaTelegram,
    }));

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input.toString();
        const parsed = new URL(url);
        const method = String(init?.method || 'GET').toUpperCase();

        if (method === 'DELETE' && parsed.pathname.endsWith('/v1/memories')) {
          return new Response(JSON.stringify({ deleted: 0 }), { status: 200 });
        }

        if (method === 'POST' && parsed.pathname.endsWith('/v2/memories')) {
          return new Response(
            JSON.stringify({
              memories: [],
              total: 0,
              page: 1,
              page_size: 25,
            }),
            { status: 200 },
          );
        }

        return new Response(JSON.stringify({ error: `Unhandled ${method} ${parsed.pathname}` }), {
          status: 500,
        });
      }) as unknown as typeof fetch,
    );

    mockUserContext({ userId: 'user-a', authenticated: true });

    (globalThis as { __modelHubService?: unknown }).__modelHubService = {
      dispatchEmbedding: vi.fn(async () => ({ embedding: { values: [1, 0] } })),
    };

    const personasRoute = await loadPersonasRoute();
    const createResponse = await personasRoute.POST(
      new Request('http://localhost/api/personas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Telegram Persona' }),
      }),
    );
    const createPayload = (await createResponse.json()) as {
      ok: boolean;
      persona: { id: string };
    };

    expect(createResponse.status).toBe(201);
    expect(createPayload.ok).toBe(true);

    const personaByIdRoute = await loadPersonaByIdRoute();
    const deleteResponse = await personaByIdRoute.DELETE(
      new Request(`http://localhost/api/personas/${createPayload.persona.id}`, {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ id: createPayload.persona.id }) },
    );

    expect(deleteResponse.status).toBe(200);
    expect(unpairPersonaTelegram).toHaveBeenCalledWith(createPayload.persona.id);
  });
});
