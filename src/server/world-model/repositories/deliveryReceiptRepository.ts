import { getWorldModelDb, type WorldModelQueryExecutor } from '@/server/world-model/db';

export interface DeliveryReceiptInput {
  outboxEventId: string;
  openLoopId?: string | null;
  userId: string;
  personaId: string;
  workspaceId?: string;
  channel: string;
  target: string;
  providerId?: string | null;
  providerMessageId?: string | null;
  deliveredAt?: string;
  payload?: Record<string, unknown>;
}

export interface DeliveryReceiptRecord extends DeliveryReceiptInput {
  id: string;
  deliveredAt: string;
}

export async function insertDeliveryReceipt(
  input: DeliveryReceiptInput,
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<DeliveryReceiptRecord> {
  const result = await db.query<{
    id: string;
    outbox_event_id: string;
    open_loop_id: string | null;
    user_id: string;
    persona_id: string;
    workspace_id: string;
    channel: string;
    target: string;
    provider_id: string | null;
    provider_message_id: string | null;
    delivered_at: string;
    payload: Record<string, unknown>;
  }>(
    `INSERT INTO world_model_delivery_receipts
      (outbox_event_id, open_loop_id, user_id, persona_id, workspace_id, channel, target,
       provider_id, provider_message_id, delivered_at, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10, now()),$11)
     ON CONFLICT (outbox_event_id) DO UPDATE SET
       provider_id = EXCLUDED.provider_id,
       provider_message_id = EXCLUDED.provider_message_id,
       delivered_at = EXCLUDED.delivered_at,
       payload = EXCLUDED.payload
     RETURNING id, outbox_event_id, open_loop_id, user_id, persona_id, workspace_id,
               channel, target, provider_id, provider_message_id, delivered_at, payload`,
    [
      input.outboxEventId,
      input.openLoopId ?? null,
      input.userId,
      input.personaId,
      input.workspaceId ?? '',
      input.channel,
      input.target,
      input.providerId ?? null,
      input.providerMessageId ?? null,
      input.deliveredAt ?? null,
      JSON.stringify(input.payload ?? {}),
    ],
  );
  const row = result.rows[0]!;
  return {
    id: row.id,
    outboxEventId: row.outbox_event_id,
    openLoopId: row.open_loop_id,
    userId: row.user_id,
    personaId: row.persona_id,
    workspaceId: row.workspace_id,
    channel: row.channel,
    target: row.target,
    providerId: row.provider_id,
    providerMessageId: row.provider_message_id,
    deliveredAt: row.delivered_at,
    payload: row.payload ?? {},
  };
}

export async function getDeliveryReceiptByOutboxEventId(
  outboxEventId: string,
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<DeliveryReceiptRecord | null> {
  const result = await db.query<{
    id: string;
    outbox_event_id: string;
    open_loop_id: string | null;
    user_id: string;
    persona_id: string;
    workspace_id: string;
    channel: string;
    target: string;
    provider_id: string | null;
    provider_message_id: string | null;
    delivered_at: string;
    payload: Record<string, unknown>;
  }>(
    `SELECT id, outbox_event_id, open_loop_id, user_id, persona_id, workspace_id,
            channel, target, provider_id, provider_message_id, delivered_at, payload
     FROM world_model_delivery_receipts WHERE outbox_event_id = $1`,
    [outboxEventId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    outboxEventId: row.outbox_event_id,
    openLoopId: row.open_loop_id,
    userId: row.user_id,
    personaId: row.persona_id,
    workspaceId: row.workspace_id,
    channel: row.channel,
    target: row.target,
    providerId: row.provider_id,
    providerMessageId: row.provider_message_id,
    deliveredAt: row.delivered_at,
    payload: row.payload ?? {},
  };
}

export async function getLatestDeliveryReceiptByOpenLoopId(
  openLoopId: string,
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<DeliveryReceiptRecord | null> {
  const result = await db.query<{
    id: string;
    outbox_event_id: string;
    open_loop_id: string | null;
    user_id: string;
    persona_id: string;
    workspace_id: string;
    channel: string;
    target: string;
    provider_id: string | null;
    provider_message_id: string | null;
    delivered_at: string;
    payload: Record<string, unknown>;
  }>(
    `SELECT id, outbox_event_id, open_loop_id, user_id, persona_id, workspace_id,
            channel, target, provider_id, provider_message_id, delivered_at, payload
     FROM world_model_delivery_receipts
     WHERE open_loop_id = $1 ORDER BY delivered_at DESC LIMIT 1`,
    [openLoopId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    outboxEventId: row.outbox_event_id,
    openLoopId: row.open_loop_id,
    userId: row.user_id,
    personaId: row.persona_id,
    workspaceId: row.workspace_id,
    channel: row.channel,
    target: row.target,
    providerId: row.provider_id,
    providerMessageId: row.provider_message_id,
    deliveredAt: row.delivered_at,
    payload: row.payload ?? {},
  };
}
