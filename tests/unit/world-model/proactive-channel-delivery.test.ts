import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  markOpenLoopAsked: vi.fn(),
  insertDeliveryReceipt: vi.fn(),
  getDeliveryReceiptByOutboxEventId: vi.fn(),
  withWorldModelTransaction: vi.fn(),
  deliverOutboundWithReceipt: vi.fn(),
  listChannelBindings: vi.fn(),
  listChannelBindingsAvailable: true,
  executeStandingIntentFollowUp: vi.fn(),
}));

vi.mock('@/server/world-model/config', () => ({ getWorldModelConfig: mocks.config }));
vi.mock('@/server/world-model/repositories/prospectiveRepository', () => ({
  markOpenLoopAsked: mocks.markOpenLoopAsked,
}));
vi.mock('@/server/world-model/repositories/deliveryReceiptRepository', () => ({
  insertDeliveryReceipt: mocks.insertDeliveryReceipt,
  getDeliveryReceiptByOutboxEventId: mocks.getDeliveryReceiptByOutboxEventId,
}));
vi.mock('@/server/world-model/db', () => ({
  withWorldModelTransaction: mocks.withWorldModelTransaction,
}));
vi.mock('@/server/channels/outbound/router', () => ({
  deliverOutboundWithReceipt: mocks.deliverOutboundWithReceipt,
}));
vi.mock('@/server/channels/messages/runtime', () => ({
  getMessageRepository: () =>
    mocks.listChannelBindingsAvailable ? { listChannelBindings: mocks.listChannelBindings } : {},
}));
vi.mock('@/server/world-model/services/standingIntentDispatcher', () => ({
  executeStandingIntentFollowUp: mocks.executeStandingIntentFollowUp,
}));

import {
  createProactiveIntentFiredHandler,
  createProactiveQuestionHandler,
  deliverIntentFiredNotification,
  deliverProactiveQuestion,
  resolveDeliveryChannel,
} from '@/server/world-model/services/proactiveChannelDelivery';
import type { ChannelBinding } from '@/server/channels/messages/channelBindings';
import type { OutboxEvent } from '@/server/world-model/types';
import type { WorldModelQueryExecutor } from '@/server/world-model/db';
import { ChannelType } from '@/shared/domain/types';

function binding(overrides: Partial<ChannelBinding> = {}): ChannelBinding {
  return {
    userId: 'user-1',
    channel: 'telegram',
    status: 'connected',
    externalPeerId: 'peer-1',
    peerName: null,
    transport: null,
    metadata: null,
    personaId: null,
    lastSeenAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function event(
  eventType: OutboxEvent['eventType'],
  payload: Record<string, unknown> = {},
  overrides: Partial<OutboxEvent> = {},
): OutboxEvent {
  return {
    id: 'outbox-1',
    eventType,
    aggregateType: 'proactive',
    aggregateId: 'aggregate-1',
    payload: {
      userId: 'user-1',
      personaId: 'assistant',
      workspaceId: 'workspace-1',
      question: 'Can you confirm the date?',
      description: 'Follow up on the date',
      ...payload,
    },
    status: 'pending',
    attempts: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('proactive channel delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listChannelBindingsAvailable = true;
    mocks.config.mockReturnValue({ enabled: true, e2eEnabled: false });
    mocks.listChannelBindings.mockReturnValue([]);
    mocks.getDeliveryReceiptByOutboxEventId.mockResolvedValue(null);
    mocks.deliverOutboundWithReceipt.mockResolvedValue({
      providerId: 'telegram-provider',
      providerMessageId: 'provider-message-1',
    });
    mocks.withWorldModelTransaction.mockImplementation(
      async (callback: (db: WorldModelQueryExecutor) => Promise<unknown>) =>
        callback({ query: vi.fn() }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('selects the connected, persona-compatible binding with the best configured priority', async () => {
    vi.stubEnv('WORLD_MODEL_PROACTIVE_CHANNELS', 'telegram, whatsapp, discord');
    mocks.listChannelBindings.mockReturnValue([
      binding({ status: 'disconnected' }),
      binding({ channel: 'slack', personaId: 'other-persona' }),
      binding({ channel: 'discord', externalPeerId: null }),
      binding({ channel: 'telegram', metadata: '{invalid' }),
      binding({ channel: 'whatsapp', metadata: '{"proactivePriority": -2}' }),
      binding({ channel: 'slack', metadata: '{"proactivePriority":"1"}' }),
      binding({ channel: 'slack', metadata: '{"proactivePriority": 4}' }),
    ]);

    await expect(resolveDeliveryChannel('user-1', 'assistant')).resolves.toEqual({
      channel: ChannelType.WHATSAPP,
      externalChatId: 'peer-1',
    });
  });

  it('ignores invalid priority metadata and returns null without a valid channel', async () => {
    vi.stubEnv('WORLD_MODEL_PROACTIVE_CHANNELS', ' , unknown ');
    mocks.listChannelBindings.mockReturnValue([
      binding({
        channel: 'unknown' as ChannelBinding['channel'],
        metadata: '{"proactivePriority":"1"}',
      }),
      binding({ channel: 'unknown' as ChannelBinding['channel'], metadata: '[]' }),
      binding({ channel: 'unknown' as ChannelBinding['channel'], metadata: 'null' }),
    ]);
    await expect(resolveDeliveryChannel('user-1', 'assistant')).resolves.toBeNull();

    mocks.listChannelBindingsAvailable = false;
    await expect(resolveDeliveryChannel('user-1', 'assistant')).resolves.toBeNull();
  });

  it('validates question payloads and reports no channel or missing adapter', async () => {
    await expect(
      deliverProactiveQuestion(event('proactive.question.requested', { question: '' })),
    ).resolves.toEqual({
      delivered: false,
      error: 'missing required payload fields',
    });
    await expect(
      deliverProactiveQuestion(event('proactive.question.requested', { question: undefined })),
    ).resolves.toEqual({ delivered: false, error: 'missing required payload fields' });
    await expect(
      deliverProactiveQuestion(event('proactive.question.requested', {}, { payload: undefined })),
    ).resolves.toEqual({ delivered: false, error: 'missing required payload fields' });

    await expect(deliverProactiveQuestion(event('proactive.question.requested'))).resolves.toEqual({
      delivered: false,
      error: 'no delivery channel available',
    });
    await expect(
      deliverProactiveQuestion(
        event('proactive.question.requested', { userId: undefined, personaId: undefined }),
      ),
    ).resolves.toEqual({ delivered: false, error: 'missing required payload fields' });
    expect(mocks.deliverOutboundWithReceipt).not.toHaveBeenCalled();

    mocks.listChannelBindings.mockReturnValue([binding()]);
    mocks.deliverOutboundWithReceipt.mockResolvedValueOnce(null);
    await expect(deliverProactiveQuestion(event('proactive.question.requested'))).resolves.toEqual({
      delivered: false,
      channel: ChannelType.TELEGRAM,
      target: 'peer-1',
      error: 'no outbound adapter',
    });
  });

  it('returns provider receipts and normalizes thrown delivery errors', async () => {
    mocks.listChannelBindings.mockReturnValue([binding()]);
    await expect(deliverProactiveQuestion(event('proactive.question.requested'))).resolves.toEqual({
      delivered: true,
      channel: ChannelType.TELEGRAM,
      target: 'peer-1',
      providerId: 'telegram-provider',
      providerMessageId: 'provider-message-1',
    });
    expect(mocks.deliverOutboundWithReceipt).toHaveBeenCalledWith(
      ChannelType.TELEGRAM,
      'peer-1',
      'Can you confirm the date?',
      { personaId: 'assistant' },
    );

    mocks.deliverOutboundWithReceipt.mockRejectedValueOnce(new Error('provider offline'));
    await expect(
      deliverProactiveQuestion(event('proactive.question.requested')),
    ).resolves.toMatchObject({
      delivered: false,
      channel: ChannelType.TELEGRAM,
      error: 'provider offline',
    });
    mocks.deliverOutboundWithReceipt.mockRejectedValueOnce('provider rejected');
    await expect(
      deliverProactiveQuestion(event('proactive.question.requested')),
    ).resolves.toMatchObject({
      delivered: false,
      error: 'provider rejected',
    });
  });

  it('validates and delivers standing-intent notifications with the reminder text', async () => {
    await expect(
      deliverIntentFiredNotification(event('proactive.intent.fired', { description: '' })),
    ).resolves.toMatchObject({ delivered: false, error: 'missing required payload fields' });
    await expect(
      deliverIntentFiredNotification(event('proactive.intent.fired', { description: undefined })),
    ).resolves.toMatchObject({ delivered: false, error: 'missing required payload fields' });
    await expect(
      deliverIntentFiredNotification(event('proactive.intent.fired', {}, { payload: undefined })),
    ).resolves.toMatchObject({ delivered: false, error: 'missing required payload fields' });
    await expect(
      deliverIntentFiredNotification(
        event('proactive.intent.fired', { userId: undefined, personaId: undefined }),
      ),
    ).resolves.toMatchObject({ delivered: false, error: 'missing required payload fields' });
    mocks.listChannelBindings.mockReturnValue([binding({ channel: 'webchat' })]);
    mocks.deliverOutboundWithReceipt.mockResolvedValueOnce(null);
    await expect(
      deliverIntentFiredNotification(event('proactive.intent.fired')),
    ).resolves.toMatchObject({ delivered: false, error: 'no outbound adapter' });
    await expect(
      deliverIntentFiredNotification(event('proactive.intent.fired')),
    ).resolves.toMatchObject({
      delivered: true,
      channel: ChannelType.WEBCHAT,
      target: 'peer-1',
    });
    expect(mocks.deliverOutboundWithReceipt).toHaveBeenCalledWith(
      ChannelType.WEBCHAT,
      'peer-1',
      '🔔 Erinnerung: Follow up on the date',
      { personaId: 'assistant' },
    );
    mocks.deliverOutboundWithReceipt.mockRejectedValueOnce(new Error('provider offline'));
    await expect(
      deliverIntentFiredNotification(event('proactive.intent.fired')),
    ).resolves.toMatchObject({ delivered: false, error: 'provider offline' });
    mocks.deliverOutboundWithReceipt.mockRejectedValueOnce('unavailable');
    await expect(
      deliverIntentFiredNotification(event('proactive.intent.fired')),
    ).resolves.toMatchObject({ delivered: false, error: 'unavailable' });
  });

  it('skips disabled or receipted question events and throws on delivery failure', async () => {
    const handler = createProactiveQuestionHandler();
    mocks.config.mockReturnValue({ enabled: false, e2eEnabled: false });
    await expect(handler(event('proactive.question.requested'))).resolves.toBeUndefined();
    expect(mocks.getDeliveryReceiptByOutboxEventId).not.toHaveBeenCalled();

    mocks.config.mockReturnValue({ enabled: true, e2eEnabled: false });
    mocks.getDeliveryReceiptByOutboxEventId.mockResolvedValueOnce({ id: 'existing-receipt' });
    await expect(handler(event('proactive.question.requested'))).resolves.toBeUndefined();
    expect(mocks.deliverOutboundWithReceipt).not.toHaveBeenCalled();

    mocks.config.mockReturnValue({ enabled: false, e2eEnabled: true });
    await expect(handler(event('proactive.question.requested'))).rejects.toThrow(
      'question delivery failed: no delivery channel available',
    );
    expect(mocks.getDeliveryReceiptByOutboxEventId).toHaveBeenCalledTimes(2);

    mocks.config.mockReturnValue({ enabled: true, e2eEnabled: false });
    await expect(handler(event('proactive.question.requested'))).rejects.toThrow(
      'question delivery failed: no delivery channel available',
    );
  });

  it('writes question receipts and tolerates receipt-marking failures after delivery', async () => {
    const handler = createProactiveQuestionHandler();
    mocks.listChannelBindings.mockReturnValue([binding()]);
    const request = event(
      'proactive.question.requested',
      { userId: 'user-1', personaId: 'assistant', workspaceId: undefined, question: 'Confirm?' },
      { workspaceId: 'workspace-from-event' },
    );

    await expect(handler(request)).resolves.toBeUndefined();
    expect(mocks.withWorldModelTransaction).toHaveBeenCalledOnce();
    expect(mocks.insertDeliveryReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        outboxEventId: request.id,
        openLoopId: request.aggregateId,
        userId: 'user-1',
        personaId: 'assistant',
        workspaceId: 'workspace-from-event',
        channel: ChannelType.TELEGRAM,
        target: 'peer-1',
        providerId: 'telegram-provider',
        providerMessageId: 'provider-message-1',
        payload: { question: 'Confirm?' },
      }),
      expect.any(Object),
    );
    expect(mocks.markOpenLoopAsked).toHaveBeenCalledWith(
      request.aggregateId,
      expect.any(String),
      expect.any(Object),
    );

    mocks.insertDeliveryReceipt.mockRejectedValueOnce(new Error('receipt storage unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(handler(request)).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledOnce();

    const noLoop = event('proactive.question.requested', { openLoopId: '' }, { aggregateId: '' });
    await expect(handler(noLoop)).resolves.toBeUndefined();
    expect(mocks.withWorldModelTransaction).toHaveBeenCalledTimes(2);
  });

  it('runs and receipts standing-intent follow-ups, while respecting idempotency and errors', async () => {
    const handler = createProactiveIntentFiredHandler();
    mocks.config.mockReturnValue({ enabled: false, e2eEnabled: false });
    await expect(handler(event('proactive.intent.fired'))).resolves.toBeUndefined();
    expect(mocks.getDeliveryReceiptByOutboxEventId).not.toHaveBeenCalled();

    mocks.config.mockReturnValue({ enabled: false, e2eEnabled: true });
    mocks.getDeliveryReceiptByOutboxEventId.mockResolvedValueOnce({ id: 'existing-receipt' });
    await expect(handler(event('proactive.intent.fired'))).resolves.toBeUndefined();
    expect(mocks.executeStandingIntentFollowUp).not.toHaveBeenCalled();

    mocks.config.mockReturnValue({ enabled: true, e2eEnabled: false });
    mocks.listChannelBindings.mockReturnValue([binding()]);
    const request = event(
      'proactive.intent.fired',
      {
        userId: 'user-1',
        personaId: 'assistant',
        workspaceId: undefined,
        description: 'Follow up on the date',
      },
      { workspaceId: 'workspace-from-event' },
    );
    await expect(handler(request)).resolves.toBeUndefined();
    expect(mocks.executeStandingIntentFollowUp).toHaveBeenCalledWith({
      intentId: request.aggregateId,
      userId: 'user-1',
      personaId: 'assistant',
      workspaceId: 'workspace-from-event',
      description: 'Follow up on the date',
      firingObservationId: '',
    });
    expect(mocks.insertDeliveryReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        outboxEventId: request.id,
        userId: 'user-1',
        personaId: 'assistant',
        workspaceId: 'workspace-from-event',
        channel: ChannelType.TELEGRAM,
        payload: { description: 'Follow up on the date' },
      }),
    );

    const eventFallbacks = event(
      'proactive.intent.fired',
      {
        userId: undefined,
        personaId: undefined,
        workspaceId: undefined,
        description: 'Follow up on the date',
      },
      {
        userId: 'event-user',
        personaId: 'event-persona',
        workspaceId: 'event-workspace',
      },
    );
    await expect(handler(eventFallbacks)).rejects.toThrow(
      'intent notification delivery failed: missing required payload fields',
    );
    expect(mocks.executeStandingIntentFollowUp).toHaveBeenLastCalledWith({
      intentId: eventFallbacks.aggregateId,
      userId: 'event-user',
      personaId: 'event-persona',
      workspaceId: 'event-workspace',
      description: 'Follow up on the date',
      firingObservationId: '',
    });

    mocks.listChannelBindings.mockReturnValue([]);
    await expect(handler(event('proactive.intent.fired'))).rejects.toThrow(
      'intent notification delivery failed: no delivery channel available',
    );
  });
});
