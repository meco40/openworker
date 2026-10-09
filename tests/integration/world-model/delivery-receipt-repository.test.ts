import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeWorldModelDb, runWorldModelMigrations } from '@/server/world-model/db';
import { deleteWorldModelScope } from '@/server/world-model/dataLifecycle';
import { enqueueOutboxEvent } from '@/server/world-model/repositories/outboxRepository';
import {
  getDeliveryReceiptByOutboxEventId,
  getLatestDeliveryReceiptByOpenLoopId,
  insertDeliveryReceipt,
} from '@/server/world-model/repositories/deliveryReceiptRepository';
import { insertOpenLoop } from '@/server/world-model/repositories/prospectiveRepository';
import type { WorldModelScope } from '@/server/world-model/scope';

const enabled = process.env.WORLD_MODEL_E2E === 'true';
const createdScopes: WorldModelScope[] = [];

function newScope(scenario: string): WorldModelScope {
  const scope = {
    userId: `delivery-receipts-${scenario}-${Date.now()}`,
    personaId: 'assistant',
    workspaceId: 'coverage',
  };
  createdScopes.push(scope);
  return scope;
}

function deliveredAt(hour: number): string {
  return `2026-10-08T${String(hour).padStart(2, '0')}:00:00.000Z`;
}

describe.skipIf(!enabled)('World Model delivery receipt PostgreSQL repository', () => {
  beforeAll(async () => {
    await runWorldModelMigrations();
  });

  afterAll(async () => {
    for (const scope of createdScopes) await deleteWorldModelScope(scope);
    await closeWorldModelDb();
  });

  it('inserts default receipt values and returns null for missing records', async () => {
    const scope = newScope('defaults');
    const outbox = await enqueueOutboxEvent({
      eventType: 'proactive.question.requested',
      aggregateType: 'open_loop',
      aggregateId: 'loop-1',
      payload: {},
      idempotencyKey: `${scope.userId}:outbox`,
      ...scope,
    });

    const receipt = await insertDeliveryReceipt({
      outboxEventId: outbox.id,
      userId: scope.userId,
      personaId: scope.personaId,
      channel: 'telegram',
      target: 'chat-1',
    });

    expect(receipt).toMatchObject({
      outboxEventId: outbox.id,
      openLoopId: null,
      userId: scope.userId,
      personaId: scope.personaId,
      workspaceId: '',
      channel: 'telegram',
      target: 'chat-1',
      providerId: null,
      providerMessageId: null,
      payload: {},
    });
    await expect(
      getDeliveryReceiptByOutboxEventId('00000000-0000-0000-0000-000000000000'),
    ).resolves.toBeNull();
    await expect(
      getLatestDeliveryReceiptByOpenLoopId('00000000-0000-0000-0000-000000000000'),
    ).resolves.toBeNull();
  });

  it('upserts by outbox event and returns the latest receipt for an open loop', async () => {
    const scope = newScope('upsert');
    const loop = await insertOpenLoop({
      ...scope,
      type: 'confirmation',
      question: 'Is the date correct?',
      deduplicationKey: 'delivery-receipt-loop',
    });
    const enqueue = (key: string) =>
      enqueueOutboxEvent({
        eventType: 'proactive.question.requested',
        aggregateType: 'open_loop',
        aggregateId: loop.id,
        payload: {},
        idempotencyKey: `${scope.userId}:${key}`,
        ...scope,
      });
    const firstEvent = await enqueue('first');
    const secondEvent = await enqueue('second');

    const first = await insertDeliveryReceipt({
      outboxEventId: firstEvent.id,
      openLoopId: loop.id,
      ...scope,
      channel: 'telegram',
      target: 'chat-1',
      deliveredAt: deliveredAt(9),
    });
    const updated = await insertDeliveryReceipt({
      outboxEventId: firstEvent.id,
      openLoopId: loop.id,
      ...scope,
      channel: 'telegram',
      target: 'chat-1',
      providerId: 'provider-1',
      providerMessageId: 'message-1',
      deliveredAt: deliveredAt(10),
      payload: { question: 'Confirm?' },
    });
    const latest = await insertDeliveryReceipt({
      outboxEventId: secondEvent.id,
      openLoopId: loop.id,
      ...scope,
      channel: 'whatsapp',
      target: 'chat-2',
      deliveredAt: deliveredAt(11),
    });

    expect(updated).toMatchObject({
      id: first.id,
      providerId: 'provider-1',
      providerMessageId: 'message-1',
      deliveredAt: deliveredAt(10),
      payload: { question: 'Confirm?' },
    });
    await expect(getDeliveryReceiptByOutboxEventId(firstEvent.id)).resolves.toMatchObject({
      id: first.id,
      providerMessageId: 'message-1',
    });
    await expect(getLatestDeliveryReceiptByOpenLoopId(loop.id)).resolves.toMatchObject({
      id: latest.id,
      channel: 'whatsapp',
      deliveredAt: deliveredAt(11),
    });
  });
});
