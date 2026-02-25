import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType } from '@/shared/domain/types';
import { SqliteMessageRepository } from '@/server/channels/messages/sqliteMessageRepository';

type MockUserContext = { userId: string; authenticated: boolean } | null;

function mockUserContext(context: MockUserContext): void {
  vi.doMock('../../../src/server/auth/userContext', () => ({
    resolveRequestUserContext: vi.fn().mockResolvedValue(context),
  }));
}

describe('persona isolation routes', () => {
  let repo: SqliteMessageRepository;

  beforeEach(() => {
    vi.resetModules();
    repo = new SqliteMessageRepository(':memory:');
    (globalThis as { __messageRepository?: SqliteMessageRepository }).__messageRepository = repo;
    (globalThis as { __messageService?: unknown }).__messageService = undefined;
    mockUserContext({ userId: 'user-1', authenticated: true });
  });

  afterEach(() => {
    repo.close();
    (globalThis as { __messageRepository?: SqliteMessageRepository }).__messageRepository =
      undefined;
    (globalThis as { __messageService?: unknown }).__messageService = undefined;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('rejects POST /api/channels/messages when request persona mismatches bound conversation persona', async () => {
    const conversation = repo.createConversation({
      channelType: ChannelType.WEBCHAT,
      title: 'Persona A',
      userId: 'user-1',
      personaId: 'persona-a',
    });

    const route = await import('../../../app/api/channels/messages/route');
    const response = await route.POST(
      new Request('http://localhost/api/channels/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: conversation.id,
          personaId: 'persona-b',
          content: 'hi',
        }),
      }),
    );

    expect(response.status).toBe(409);
    const payload = (await response.json()) as { ok: boolean; error?: string };
    expect(payload.ok).toBe(false);
    expect(String(payload.error || '')).toMatch(/persona/i);
    expect(repo.listMessages(conversation.id, 20, undefined, 'user-1')).toHaveLength(0);
  });

  it('rejects PATCH /api/channels/conversations when trying to rebind persona on existing conversation', async () => {
    const conversation = repo.createConversation({
      channelType: ChannelType.WEBCHAT,
      title: 'Persona A',
      userId: 'user-1',
      personaId: 'persona-a',
    });

    const route = await import('../../../app/api/channels/conversations/route');
    const response = await route.PATCH(
      new Request('http://localhost/api/channels/conversations', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: conversation.id,
          personaId: 'persona-b',
        }),
      }),
    );

    expect(response.status).toBe(409);
    const payload = (await response.json()) as { ok: boolean; error?: string };
    expect(payload.ok).toBe(false);
    expect(String(payload.error || '')).toMatch(/persona/i);

    const unchanged = repo.getConversation(conversation.id, 'user-1');
    expect(unchanged?.personaId).toBe('persona-a');
  });
});

