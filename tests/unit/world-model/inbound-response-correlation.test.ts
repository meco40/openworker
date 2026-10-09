import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType, type Conversation } from '@/shared/domain/types';
import type { CorrelatableTarget } from '@/server/world-model/services/responseCorrelationService';

const mocks = vi.hoisted(() => ({
  client: { id: 'transaction-client' },
  getWorldModelConfig: vi.fn(),
  correlateUserResponse: vi.fn(),
  resolveOpenLoopAsAnsweredInTx: vi.fn(),
  confirmEventOutcomeInTx: vi.fn(),
  withWorldModelTransaction: vi.fn(),
  listAskedOpenLoops: vi.fn(),
  getLatestDeliveryReceiptByOpenLoopId: vi.fn(),
}));

vi.mock('@/server/world-model/config', () => ({
  getWorldModelConfig: mocks.getWorldModelConfig,
}));
vi.mock('@/server/world-model/services/responseCorrelationService', () => ({
  correlateUserResponse: mocks.correlateUserResponse,
}));
vi.mock('@/server/world-model/services/openLoopService', () => ({
  resolveOpenLoopAsAnsweredInTx: mocks.resolveOpenLoopAsAnsweredInTx,
}));
vi.mock('@/server/world-model/services/eventService', () => ({
  confirmEventOutcomeInTx: mocks.confirmEventOutcomeInTx,
}));
vi.mock('@/server/world-model/db', () => ({
  withWorldModelTransaction: mocks.withWorldModelTransaction,
}));
vi.mock('@/server/world-model/repositories/prospectiveRepository', () => ({
  listAskedOpenLoops: mocks.listAskedOpenLoops,
}));
vi.mock('@/server/world-model/repositories/deliveryReceiptRepository', () => ({
  getLatestDeliveryReceiptByOpenLoopId: mocks.getLatestDeliveryReceiptByOpenLoopId,
}));

import {
  correlateInboundResponse,
  looksLikeResponse,
} from '@/server/world-model/services/inboundResponseCorrelation';

const conversation: Conversation = {
  id: 'conversation-1',
  channelType: ChannelType.TELEGRAM,
  externalChatId: 'chat-1',
  userId: 'user-1',
  workspaceId: 'workspace-1',
  title: 'Chat',
  modelOverride: null,
  personaId: 'persona-1',
  createdAt: '2026-10-08T10:00:00.000Z',
  updatedAt: '2026-10-08T10:00:00.000Z',
};

const userMessage = {
  text: 'Ja, das passt.',
  receivedAt: '2026-10-08T10:05:00.000Z',
  observationId: 'observation-1',
  sourceId: 'message-1',
};

function openLoop(overrides: Record<string, unknown> = {}) {
  return {
    id: 'loop-1',
    type: 'follow_up',
    deduplicationKey: 'question:1',
    question: 'Is the appointment still on?',
    lastAskedAt: '2026-10-08T10:00:00.000Z',
    ...overrides,
  };
}

function setDecision(
  targetType?: CorrelatableTarget['targetType'],
  options: { ambiguous?: boolean; id?: string; reason?: string } = {},
) {
  mocks.correlateUserResponse.mockReturnValue({
    match: targetType ? { id: options.id ?? 'target-1', targetType } : null,
    ambiguous: options.ambiguous ?? false,
    reason: options.reason ?? 'conversation-and-channel',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getWorldModelConfig.mockReturnValue({ enabled: true, e2eEnabled: false });
  mocks.listAskedOpenLoops.mockResolvedValue([]);
  mocks.getLatestDeliveryReceiptByOpenLoopId.mockResolvedValue(null);
  mocks.withWorldModelTransaction.mockImplementation((callback) => callback(mocks.client));
  setDecision();
});

afterEach(() => vi.restoreAllMocks());

describe('correlateInboundResponse', () => {
  it('skips disabled World Model and conversations without a persona', async () => {
    mocks.getWorldModelConfig.mockReturnValue({ enabled: false, e2eEnabled: false });
    await expect(correlateInboundResponse({ conversation, userMessage })).resolves.toEqual({
      correlated: false,
    });

    mocks.getWorldModelConfig.mockReturnValue({ enabled: false, e2eEnabled: true });
    await expect(
      correlateInboundResponse({
        conversation: { ...conversation, personaId: null },
        userMessage,
      }),
    ).resolves.toEqual({ correlated: false });
    expect(mocks.listAskedOpenLoops).not.toHaveBeenCalled();
  });

  it('builds open-loop and event candidates with delivery metadata', async () => {
    mocks.listAskedOpenLoops.mockResolvedValue([
      openLoop({ id: 'loop-1' }),
      openLoop({
        id: 'event-loop',
        type: 'event_outcome',
        deduplicationKey: 'event-outcome:event-1',
      }),
      openLoop({ id: 'unkeyed-event-loop', type: 'event_outcome', deduplicationKey: 'other' }),
      openLoop({ id: 'empty-question', question: '' }),
    ]);
    mocks.getLatestDeliveryReceiptByOpenLoopId
      .mockResolvedValueOnce({ channel: 'telegram', target: 'external-chat-1' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ channel: 'slack', target: 'external-chat-2' });

    const result = await correlateInboundResponse({ conversation, userMessage });

    expect(result).toEqual({ correlated: false });
    expect(mocks.listAskedOpenLoops).toHaveBeenCalledWith(
      'user-1',
      'persona-1',
      'workspace-1',
      100,
    );
    expect(mocks.getLatestDeliveryReceiptByOpenLoopId).toHaveBeenCalledTimes(3);
    expect(mocks.correlateUserResponse).toHaveBeenCalledWith(
      {
        channel: ChannelType.TELEGRAM,
        conversationId: 'conversation-1',
        text: userMessage.text,
        receivedAt: userMessage.receivedAt,
        externalChatId: 'chat-1',
      },
      [
        {
          id: 'loop-1',
          targetType: 'open_loop',
          conversationId: 'conversation-1',
          askedAt: '2026-10-08T10:00:00.000Z',
          windowMs: 24 * 60 * 60 * 1000,
          channel: 'telegram',
          externalChatId: 'external-chat-1',
        },
        {
          id: 'event-1',
          targetType: 'event',
          conversationId: 'conversation-1',
          askedAt: '2026-10-08T10:00:00.000Z',
          windowMs: 24 * 60 * 60 * 1000,
        },
        {
          id: 'unkeyed-event-loop',
          targetType: 'open_loop',
          conversationId: 'conversation-1',
          askedAt: '2026-10-08T10:00:00.000Z',
          windowMs: 24 * 60 * 60 * 1000,
          channel: 'slack',
          externalChatId: 'external-chat-2',
        },
      ],
    );
  });

  it('fails soft when candidate reads fail or no asked loops exist', async () => {
    mocks.listAskedOpenLoops.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(correlateInboundResponse({ conversation, userMessage })).resolves.toEqual({
      correlated: false,
    });
    expect(mocks.correlateUserResponse).not.toHaveBeenCalled();

    mocks.listAskedOpenLoops.mockResolvedValueOnce([openLoop()]);
    mocks.getLatestDeliveryReceiptByOpenLoopId.mockRejectedValueOnce(
      new Error('receipt unavailable'),
    );
    await expect(correlateInboundResponse({ conversation, userMessage })).resolves.toEqual({
      correlated: false,
    });
    expect(mocks.correlateUserResponse).toHaveBeenCalledOnce();
  });

  it.each([
    ['no match', false],
    ['ambiguous match', true],
  ])('does not update state for a %s decision', async (_label, ambiguous) => {
    mocks.listAskedOpenLoops.mockResolvedValue([openLoop()]);
    setDecision(undefined, { ambiguous });

    const result = await correlateInboundResponse({ conversation, userMessage });

    expect(result).toEqual({ correlated: false, matchedType: undefined });
    expect(mocks.withWorldModelTransaction).not.toHaveBeenCalled();
  });

  it('answers a matched open loop atomically with the observation provenance', async () => {
    mocks.listAskedOpenLoops.mockResolvedValue([openLoop()]);
    setDecision('open_loop', { id: 'loop-1', reason: 'external-chat-id' });

    await expect(correlateInboundResponse({ conversation, userMessage })).resolves.toEqual({
      correlated: true,
      matchedType: 'open_loop',
      matchedId: 'loop-1',
      action: 'answered',
    });
    expect(mocks.resolveOpenLoopAsAnsweredInTx).toHaveBeenCalledWith(
      'loop-1',
      'observation-1',
      'User response correlated via external-chat-id match',
      mocks.client,
    );
  });

  it('fails soft when updating a matched open loop fails', async () => {
    const error = new Error('write failed');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.listAskedOpenLoops.mockResolvedValue([openLoop()]);
    setDecision('open_loop');
    mocks.withWorldModelTransaction.mockRejectedValueOnce(error);

    await expect(correlateInboundResponse({ conversation, userMessage })).resolves.toEqual({
      correlated: false,
    });
    expect(log).toHaveBeenCalledWith(
      '[world-model:correlation] failed to update correlated target:',
      error,
    );
  });

  it('requires observation and source identifiers before confirming an event', async () => {
    mocks.listAskedOpenLoops.mockResolvedValue([openLoop()]);
    setDecision('event', { id: 'event-1' });

    await expect(
      correlateInboundResponse({
        conversation,
        userMessage: { text: userMessage.text, receivedAt: userMessage.receivedAt },
      }),
    ).resolves.toEqual({ correlated: false });
    expect(mocks.withWorldModelTransaction).not.toHaveBeenCalled();
  });

  it('confirms a matched event with the inbound message as user-authoritative evidence', async () => {
    mocks.listAskedOpenLoops.mockResolvedValue([openLoop()]);
    setDecision('event', { id: 'event-1' });

    await expect(correlateInboundResponse({ conversation, userMessage })).resolves.toEqual({
      correlated: true,
      matchedType: 'event',
      matchedId: 'event-1',
      action: 'confirmed',
    });
    expect(mocks.confirmEventOutcomeInTx).toHaveBeenCalledWith(
      {
        eventId: 'event-1',
        observation: {
          userId: 'user-1',
          personaId: 'persona-1',
          workspaceId: 'workspace-1',
          sourceType: 'chat_message',
          sourceId: 'message-1',
          occurredAt: userMessage.receivedAt,
          payload: {
            conversationId: 'conversation-1',
            text: userMessage.text,
            channelType: ChannelType.TELEGRAM,
            externalChatId: 'chat-1',
          },
          sourceAuthority: 'user',
        },
        outcome: 'completed',
      },
      mocks.client,
    );
  });

  it('confirms legacy event conversations with an empty workspace scope', async () => {
    mocks.listAskedOpenLoops.mockResolvedValue([openLoop()]);
    setDecision('event', { id: 'event-1' });

    await correlateInboundResponse({
      conversation: { ...conversation, workspaceId: undefined },
      userMessage,
    });

    expect(mocks.confirmEventOutcomeInTx).toHaveBeenCalledWith(
      expect.objectContaining({
        observation: expect.objectContaining({ workspaceId: '' }),
      }),
      mocks.client,
    );
  });

  it('uses an empty workspace for legacy conversations and fails soft on event writes', async () => {
    const error = new Error('write failed');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.listAskedOpenLoops.mockResolvedValue([openLoop()]);
    setDecision('event');
    mocks.withWorldModelTransaction.mockRejectedValueOnce(error);

    await expect(
      correlateInboundResponse({
        conversation: { ...conversation, workspaceId: undefined },
        userMessage,
      }),
    ).resolves.toEqual({ correlated: false });
    expect(mocks.listAskedOpenLoops).toHaveBeenCalledWith('user-1', 'persona-1', '', 100);
    expect(log).toHaveBeenCalledWith(
      '[world-model:correlation] failed to update correlated target:',
      error,
    );
  });

  it('ignores future target types until they have a state transition', async () => {
    mocks.listAskedOpenLoops.mockResolvedValue([openLoop()]);
    setDecision('task');

    await expect(correlateInboundResponse({ conversation, userMessage })).resolves.toEqual({
      correlated: false,
    });
    expect(mocks.withWorldModelTransaction).not.toHaveBeenCalled();
  });
});

describe('looksLikeResponse', () => {
  it('recognizes trimmed short affirmations and rejects short, long, or unrelated text', () => {
    expect(looksLikeResponse(' JA ')).toBe(true);
    expect(looksLikeResponse('no, not today')).toBe(true);
    expect(looksLikeResponse('x')).toBe(false);
    expect(looksLikeResponse('hello there')).toBe(false);
    expect(looksLikeResponse('a'.repeat(201))).toBe(false);
  });
});
