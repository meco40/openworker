import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType } from '@/shared/domain/types';
import { SqliteMessageRepository } from '@/server/channels/messages/sqliteMessageRepository';
import { getTestArtifactsRoot } from '../../helpers/testArtifacts';

type MockUserContext = { userId: string; authenticated: boolean } | null;

function mockUserContext(context: MockUserContext): void {
  vi.doMock('../../../src/server/auth/userContext', () => ({
    resolveRequestUserContext: vi.fn().mockResolvedValue(context),
  }));
}

describe('project delete + conversation delete flow', () => {
  let repo: SqliteMessageRepository;
  let personasRootPath = '';

  beforeEach(() => {
    vi.resetModules();

    personasRootPath = path.resolve(
      getTestArtifactsRoot(),
      `personas.integration.${Date.now()}.${Math.random().toString(36).slice(2)}`,
    );
    process.env.PERSONAS_ROOT_PATH = personasRootPath;

    repo = new SqliteMessageRepository(':memory:');
    (globalThis as { __messageRepository?: SqliteMessageRepository }).__messageRepository = repo;
    (globalThis as { __messageService?: unknown }).__messageService = undefined;

    mockUserContext({ userId: 'user-1', authenticated: true });

    vi.doMock('../../../src/server/personas/personaRepository', () => ({
      getPersonaRepository: () => ({
        getPersona: (personaId: string) =>
          personaId === 'persona-1'
            ? {
                id: 'persona-1',
                name: 'Next.js Dev',
                slug: 'next_js_dev',
              }
            : null,
        listPersonas: () => [],
        getPersonaSystemInstruction: () => null,
      }),
    }));

    vi.doMock('../../../src/server/gateway/broadcast', () => ({
      broadcastToUser: vi.fn(),
    }));
  });

  afterEach(() => {
    repo.close();
    (globalThis as { __messageRepository?: SqliteMessageRepository }).__messageRepository =
      undefined;
    (globalThis as { __messageService?: unknown }).__messageService = undefined;
    delete process.env.PERSONAS_ROOT_PATH;
    if (personasRootPath) {
      fs.rmSync(personasRootPath, { recursive: true, force: true });
      personasRootPath = '';
    }
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('creates project, deletes it by index, then deletes conversation successfully', async () => {
    const conversationsRoute = await import('../../../app/api/channels/conversations/route');
    const messagesRoute = await import('../../../app/api/channels/messages/route');

    const createConversationResponse = await conversationsRoute.POST(
      new Request('http://localhost/api/channels/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelType: ChannelType.WEBCHAT,
          title: 'Notes Session',
          personaId: 'persona-1',
        }),
      }),
    );
    expect(createConversationResponse.status).toBe(200);
    const createConversationPayload = (await createConversationResponse.json()) as {
      ok: boolean;
      conversation: { id: string };
    };
    expect(createConversationPayload.ok).toBe(true);
    const conversationId = createConversationPayload.conversation.id;

    const projectCreateResponse = await messagesRoute.POST(
      new Request('http://localhost/api/channels/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          content: '/project new Notes',
        }),
      }),
    );
    expect(projectCreateResponse.status).toBe(200);
    const projectCreatePayload = (await projectCreateResponse.json()) as {
      ok: boolean;
      agentMessage: { content: string };
    };
    expect(projectCreatePayload.ok).toBe(true);
    expect(projectCreatePayload.agentMessage.content.toLowerCase()).toContain('projekt erstellt');

    const projectsAfterCreate = repo.listProjectsByPersona('persona-1', 'user-1');
    expect(projectsAfterCreate).toHaveLength(1);
    expect(fs.existsSync(projectsAfterCreate[0].workspacePath)).toBe(true);

    const projectDeleteResponse = await messagesRoute.POST(
      new Request('http://localhost/api/channels/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          content: '/project delete 1',
        }),
      }),
    );
    expect(projectDeleteResponse.status).toBe(200);
    const projectDeletePayload = (await projectDeleteResponse.json()) as {
      ok: boolean;
      agentMessage: { content: string };
    };
    expect(projectDeletePayload.ok).toBe(true);
    expect(projectDeletePayload.agentMessage.content.toLowerCase()).toContain('projekt gelöscht');
    expect(repo.listProjectsByPersona('persona-1', 'user-1')).toHaveLength(0);
    expect(fs.existsSync(projectsAfterCreate[0].workspacePath)).toBe(false);

    const deleteRequest = {
      nextUrl: new URL(
        `http://localhost/api/channels/conversations?id=${encodeURIComponent(conversationId)}`,
      ),
    } as unknown as import('next/server').NextRequest;
    const deleteConversationResponse = await conversationsRoute.DELETE(deleteRequest);
    expect(deleteConversationResponse.status).toBe(200);
    const deleteConversationPayload = (await deleteConversationResponse.json()) as { ok: boolean };
    expect(deleteConversationPayload.ok).toBe(true);
    expect(repo.getConversation(conversationId, 'user-1')).toBeNull();
  });
});
