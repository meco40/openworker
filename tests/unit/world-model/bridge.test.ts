import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

let mockConfig: {
  enabled: boolean;
  e2eEnabled: boolean;
  ingestionBridgeEnabled: boolean;
  graphitiShadowEnabled: boolean;
  mode: 'off' | 'shadow' | 'required' | 'canonical';
};
const insertObservationWithResult = vi.fn();
const matchIntent = vi.fn();

let bridgeChatMessages: typeof import('@/server/world-model/bridge').bridgeChatMessages;

function msg() {
  return {
    userId: 'u',
    personaId: 'p',
    conversationId: 'c',
    seq: 1,
    role: 'user',
    content: 'Ich gehe ins Kino.',
  };
}

describe('bridgeChatMessages', () => {
  afterAll(() => {
    vi.doUnmock('@/server/world-model/config');
    vi.doUnmock('@/server/world-model/db');
    vi.doUnmock('@/server/world-model/repositories/observationRepository');
    vi.doUnmock('@/server/world-model/services/prospectiveEngine');
    vi.doUnmock('@/server/world-model/repositories/outboxRepository');
    vi.resetModules();
  });

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock('@/server/world-model/config');
    vi.doUnmock('@/server/world-model/db');
    vi.doUnmock('@/server/world-model/repositories/observationRepository');
    vi.doUnmock('@/server/world-model/services/prospectiveEngine');
    vi.doUnmock('@/server/world-model/repositories/outboxRepository');

    vi.doMock('@/server/world-model/config', () => ({
      getWorldModelConfig: () => mockConfig,
    }));
    vi.doMock('@/server/world-model/db', () => ({
      getWorldModelDb: () => ({ query: vi.fn() }),
      withWorldModelTransaction: async (callback: (db: unknown) => Promise<unknown>) =>
        callback({ query: vi.fn() }),
    }));
    vi.doMock('@/server/world-model/repositories/observationRepository', () => ({
      insertObservationWithResult: (...args: unknown[]) => insertObservationWithResult(...args),
    }));
    vi.doMock('@/server/world-model/services/prospectiveEngine', () => ({
      matchStandingIntents: (...args: unknown[]) => matchIntent(...args),
    }));
    vi.doMock('@/server/world-model/repositories/outboxRepository', () => ({
      enqueueOutboxEvent: vi.fn(async () => ({ id: 'outbox-1' })),
    }));

    bridgeChatMessages = (await import('@/server/world-model/bridge')).bridgeChatMessages;

    mockConfig = {
      enabled: true,
      e2eEnabled: false,
      ingestionBridgeEnabled: true,
      graphitiShadowEnabled: false,
      mode: 'shadow',
    };
    insertObservationWithResult.mockReset();
    matchIntent.mockReset();
    matchIntent.mockResolvedValue({ matched: false });
    insertObservationWithResult.mockResolvedValue({
      created: true,
      observation: {
        id: 'o',
        userId: 'u',
        personaId: 'p',
        sourceType: 'chat_message',
        sourceId: 'c:1',
        occurredAt: '2026-08-18T16:00:00.000Z',
        receivedAt: '2026-08-18T16:00:00.000Z',
        payload: {},
      },
    });
  });

  it('is fail-closed when the world model is disabled', async () => {
    mockConfig = {
      enabled: false,
      e2eEnabled: false,
      ingestionBridgeEnabled: true,
      graphitiShadowEnabled: false,
      mode: 'off',
    };
    const result = await bridgeChatMessages({
      conversationId: 'c',
      userId: 'u',
      personaId: 'p',
      messages: [msg()],
    });
    expect(result).toEqual({ written: 0, skipped: 1 });
    expect(insertObservationWithResult).not.toHaveBeenCalled();
  });

  it('skips everything when the ingestion bridge is off', async () => {
    mockConfig = {
      enabled: true,
      e2eEnabled: false,
      ingestionBridgeEnabled: false,
      graphitiShadowEnabled: false,
      mode: 'shadow',
    };
    const result = await bridgeChatMessages({
      conversationId: 'c',
      userId: 'u',
      personaId: 'p',
      messages: [msg()],
    });
    expect(result).toEqual({ written: 0, skipped: 1 });
  });

  it('writes observations and evaluates standing intents', async () => {
    const result = await bridgeChatMessages({
      conversationId: 'c',
      userId: 'u',
      personaId: 'p',
      messages: [msg()],
    });
    expect(result).toEqual({ written: 1, skipped: 0 });
    expect(insertObservationWithResult).toHaveBeenCalledTimes(1);
    expect(matchIntent).toHaveBeenCalledTimes(1);
  });

  it('is fail-soft when the observation write throws', async () => {
    insertObservationWithResult.mockRejectedValue(new Error('db down'));
    const result = await bridgeChatMessages({
      conversationId: 'c',
      userId: 'u',
      personaId: 'p',
      messages: [msg()],
    });
    expect(result).toEqual({ written: 0, skipped: 1 });
  });

  it('blocks ingestion when a required write fails', async () => {
    mockConfig.mode = 'required';
    insertObservationWithResult.mockRejectedValue(new Error('db down'));
    await expect(
      bridgeChatMessages({
        conversationId: 'c',
        userId: 'u',
        personaId: 'p',
        messages: [msg()],
      }),
    ).rejects.toThrow('db down');
  });
});
