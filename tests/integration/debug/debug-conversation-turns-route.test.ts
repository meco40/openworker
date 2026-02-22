import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockUserContext = { userId: string; authenticated: boolean } | null;

function mockUserContext(context: MockUserContext): void {
  vi.doMock('../../../src/server/auth/userContext', () => ({
    resolveRequestUserContext: vi.fn().mockResolvedValue(context),
  }));
}

describe('/api/debug/conversations/[id]/turns route', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns paginated turns with cursor metadata', async () => {
    mockUserContext({ userId: 'debug-user', authenticated: true });

    const listDispatches = vi.fn().mockReturnValue([
      {
        id: 'd-18',
        turnSeq: 18,
        promptPreview: 'latest-user',
        modelName: 'grok-4',
        promptTokens: 11,
        completionTokens: 22,
        latencyMs: 333,
        toolCallsJson: '[]',
        memoryContextJson: null,
        riskLevel: 'low',
      },
      {
        id: 'd-17',
        turnSeq: 17,
        promptPreview: 'middle-user',
        modelName: 'grok-4',
        promptTokens: 12,
        completionTokens: 23,
        latencyMs: 334,
        toolCallsJson: '[]',
        memoryContextJson: null,
        riskLevel: 'low',
      },
      {
        id: 'd-16',
        turnSeq: 16,
        promptPreview: 'older-user',
        modelName: 'grok-4',
        promptTokens: 13,
        completionTokens: 24,
        latencyMs: 335,
        toolCallsJson: '[]',
        memoryContextJson: null,
        riskLevel: 'low',
      },
    ]);

    const listMessagesAfterSeq = vi.fn().mockReturnValue([
      { seq: 17, content: 'User seq 17' },
      { seq: 18, content: 'User seq 18' },
      { seq: 19, content: 'Agent seq 18' },
    ]);

    vi.doMock('../../../src/server/stats/promptDispatchRepository', () => ({
      getPromptDispatchRepository: () => ({
        listDispatches,
      }),
    }));

    vi.doMock('../../../src/server/channels/messages/runtime', () => ({
      getMessageRepository: () => ({
        listMessagesAfterSeq,
        listMessages: vi.fn().mockReturnValue([]),
      }),
    }));

    const route = await import('../../../app/api/debug/conversations/[id]/turns/route');
    const response = await route.GET(
      new Request('http://localhost/api/debug/conversations/conv-1/turns?limit=2'),
      { params: Promise.resolve({ id: 'conv-1' }) },
    );

    const payload = (await response.json()) as {
      ok: boolean;
      turns: Array<{ seq: number; userPreview: string; assistantPreview: string }>;
      pagination: {
        limit: number;
        returned: number;
        hasMore: boolean;
        nextBeforeSeq: number | null;
      };
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.turns.map((turn) => turn.seq)).toEqual([17, 18]);
    expect(payload.turns[0]).toMatchObject({
      userPreview: 'User seq 17',
      assistantPreview: 'User seq 18',
    });
    expect(payload.pagination).toEqual({
      limit: 2,
      returned: 2,
      hasMore: true,
      nextBeforeSeq: 17,
    });
    expect(listDispatches).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      limit: 3,
    });
    expect(listMessagesAfterSeq).toHaveBeenCalledWith('conv-1', 16, 50);
  });
});
