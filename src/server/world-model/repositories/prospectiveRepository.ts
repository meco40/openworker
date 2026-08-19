import { getWorldModelDb, type WorldModelQueryExecutor } from '@/server/world-model/db';
import type {
  OpenLoopInput,
  OpenLoopRecord,
  OpenLoopStatus,
  StandingIntentInput,
  StandingIntentRecord,
  StandingIntentStatus,
} from '@/server/world-model/types';

interface OpenLoopRow {
  id: string;
  user_id: string;
  persona_id: string;
  workspace_id: string;
  type: OpenLoopRecord['type'];
  status: OpenLoopStatus;
  subject_id: string | null;
  question: string | null;
  missing_information: string | null;
  importance: number;
  trigger_at: string | null;
  do_not_ask_before: string | null;
  last_checked_at: string | null;
  deduplication_key: string;
  max_attempts: number;
  attempts: number;
  last_asked_at: string | null;
  resolved_observation_id: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

interface IntentRow {
  id: string;
  user_id: string;
  persona_id: string;
  workspace_id: string;
  description: string;
  trigger_terms: unknown;
  event_type: string | null;
  subject_scope: string | null;
  channel_scope: string | null;
  sender_scope: string | null;
  status: StandingIntentStatus;
  expires_at: string | null;
  cooldown_until: string | null;
  cooldown_ms: number;
  fire_count: number;
  max_fires: number;
  last_fired_at: string | null;
  deduplication_key: string;
  note: string | null;
  created_at: string;
  updated_at: string;
}

function toOpenLoop(row: OpenLoopRow): OpenLoopRecord {
  return {
    id: row.id,
    userId: row.user_id,
    personaId: row.persona_id,
    workspaceId: row.workspace_id,
    type: row.type,
    status: row.status,
    attempts: row.attempts,
    subjectId: row.subject_id ?? undefined,
    question: row.question ?? undefined,
    missingInformation: row.missing_information ?? undefined,
    importance: row.importance,
    triggerAt: row.trigger_at ?? undefined,
    doNotAskBefore: row.do_not_ask_before ?? undefined,
    lastCheckedAt: row.last_checked_at ?? undefined,
    deduplicationKey: row.deduplication_key,
    maxAttempts: row.max_attempts,
    lastAskedAt: row.last_asked_at ?? undefined,
    resolvedObservationId: row.resolved_observation_id ?? undefined,
    note: row.note ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toIntent(row: IntentRow): StandingIntentRecord {
  return {
    id: row.id,
    userId: row.user_id,
    personaId: row.persona_id,
    workspaceId: row.workspace_id,
    description: row.description,
    triggerTerms: (row.trigger_terms ?? []) as string[],
    eventType: row.event_type ?? undefined,
    subjectScope: row.subject_scope ?? undefined,
    channelScope: row.channel_scope ?? undefined,
    senderScope: row.sender_scope ?? undefined,
    status: row.status,
    expiresAt: row.expires_at ?? undefined,
    cooldownUntil: row.cooldown_until ?? undefined,
    cooldownMs: row.cooldown_ms,
    fireCount: row.fire_count,
    maxFires: row.max_fires,
    lastFiredAt: row.last_fired_at ?? undefined,
    deduplicationKey: row.deduplication_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function insertOpenLoop(
  input: OpenLoopInput,
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<OpenLoopRecord> {
  const result = await db.query<OpenLoopRow>(
    `INSERT INTO world_model_open_loops
      (user_id, persona_id, workspace_id, type, subject_id, question, missing_information,
       importance, trigger_at, do_not_ask_before, deduplication_key, max_attempts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (user_id, persona_id, workspace_id, deduplication_key) DO UPDATE SET
       type = EXCLUDED.type, note = COALESCE(world_model_open_loops.note, EXCLUDED.note), updated_at = now()
     RETURNING id, user_id, persona_id, workspace_id, type, status, subject_id, question,
               missing_information, importance, trigger_at, do_not_ask_before, last_checked_at,
               deduplication_key, max_attempts, attempts, last_asked_at, resolved_observation_id,
               note, created_at, updated_at`,
    [
      input.userId,
      input.personaId,
      input.workspaceId ?? '',
      input.type,
      input.subjectId ?? null,
      input.question ?? null,
      input.missingInformation ?? null,
      input.importance ?? 1,
      input.triggerAt ?? null,
      input.doNotAskBefore ?? null,
      input.deduplicationKey,
      input.maxAttempts ?? 3,
    ],
  );
  return toOpenLoop(result.rows[0]);
}

export async function getOpenLoopByKey(
  userId: string,
  personaId: string,
  deduplicationKey: string,
  workspaceId = '',
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<OpenLoopRecord | null> {
  const result = await db.query<OpenLoopRow>(
    `SELECT id, user_id, persona_id, workspace_id, type, status, subject_id, question,
            missing_information, importance, trigger_at, do_not_ask_before, last_checked_at,
            deduplication_key, max_attempts, attempts, last_asked_at, resolved_observation_id,
            note, created_at, updated_at
     FROM world_model_open_loops
     WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3 AND deduplication_key = $4`,
    [userId, personaId, workspaceId, deduplicationKey],
  );
  return result.rows[0] ? toOpenLoop(result.rows[0]) : null;
}

export async function updateOpenLoopStatus(
  id: string,
  status: OpenLoopStatus,
  fields?: {
    lastCheckedAt?: string;
    lastAskedAt?: string;
    resolvedObservationId?: string;
    note?: string;
  },
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<void> {
  await db.query(
    `UPDATE world_model_open_loops
     SET status = $2, last_checked_at = COALESCE($3, last_checked_at),
         last_asked_at = COALESCE($4, last_asked_at),
         resolved_observation_id = COALESCE($5, resolved_observation_id),
         note = COALESCE($6, note), updated_at = now()
     WHERE id = $1`,
    [
      id,
      status,
      fields?.lastCheckedAt ?? null,
      fields?.lastAskedAt ?? null,
      fields?.resolvedObservationId ?? null,
      fields?.note ?? null,
    ],
  );
}

export async function listDueOpenLoops(
  userId: string,
  personaId: string,
  at: string,
  workspaceId = '',
  limit = 50,
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<OpenLoopRecord[]> {
  const result = await db.query<OpenLoopRow>(
    `SELECT id, user_id, persona_id, workspace_id, type, status, subject_id, question,
            missing_information, importance, trigger_at, do_not_ask_before, last_checked_at,
            deduplication_key, max_attempts, attempts, last_asked_at, resolved_observation_id,
            note, created_at, updated_at
     FROM world_model_open_loops
     WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
       AND status IN ('open','scheduled')
       AND (trigger_at IS NULL OR trigger_at <= $4)
       AND (do_not_ask_before IS NULL OR do_not_ask_before <= $4)
       AND (next_attempt_at IS NULL OR next_attempt_at <= $4)
       AND (locked_until IS NULL OR locked_until <= $4)
     ORDER BY COALESCE(trigger_at, created_at) ASC LIMIT $5`,
    [userId, personaId, workspaceId, at, limit],
  );
  return result.rows.map(toOpenLoop);
}

/**
 * Claims the next due open loop with `FOR UPDATE SKIP LOCKED`. Sets a short
 * lease so concurrent workers do not claim the same loop. Returns null if no
 * due loop is available.
 */
export async function claimDueOpenLoop(
  userId: string,
  personaId: string,
  at: string,
  workspaceId = '',
  leaseBy: string,
  leaseDurationMs = 60_000,
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<OpenLoopRecord | null> {
  const leaseUntil = new Date(new Date(at).getTime() + leaseDurationMs).toISOString();
  const result = await db.query<OpenLoopRow>(
    `UPDATE world_model_open_loops
     SET locked_by = $6,
         locked_until = $7,
         updated_at = now()
     WHERE id = (
       SELECT id FROM world_model_open_loops
       WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
         AND status IN ('open','scheduled')
         AND (trigger_at IS NULL OR trigger_at <= $4)
         AND (do_not_ask_before IS NULL OR do_not_ask_before <= $4)
         AND (next_attempt_at IS NULL OR next_attempt_at <= $4)
         AND (locked_until IS NULL OR locked_until <= $4)
       ORDER BY COALESCE(trigger_at, created_at) ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING id, user_id, persona_id, workspace_id, type, status, subject_id, question,
               missing_information, importance, trigger_at, do_not_ask_before, last_checked_at,
               deduplication_key, max_attempts, attempts, last_asked_at, resolved_observation_id,
               note, created_at, updated_at`,
    [userId, personaId, workspaceId, at, leaseUntil, leaseBy, leaseUntil],
  );
  return result.rows[0] ? toOpenLoop(result.rows[0]) : null;
}

export async function releaseOpenLoopLease(
  loopId: string,
  nextAttemptAt: string | null,
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<void> {
  await db.query(
    `UPDATE world_model_open_loops
     SET locked_by = NULL,
         locked_until = NULL,
         next_attempt_at = COALESCE($2, next_attempt_at),
         updated_at = now()
     WHERE id = $1`,
    [loopId, nextAttemptAt],
  );
}

/** Returns loops waiting for a response after successful delivery. */
export async function listAskedOpenLoops(
  userId: string,
  personaId: string,
  workspaceId = '',
  limit = 100,
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<OpenLoopRecord[]> {
  const result = await db.query<OpenLoopRow>(
    `SELECT id, user_id, persona_id, workspace_id, type, status, subject_id, question,
            missing_information, importance, trigger_at, do_not_ask_before, last_checked_at,
            deduplication_key, max_attempts, attempts, last_asked_at, resolved_observation_id,
            note, created_at, updated_at
     FROM world_model_open_loops
     WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
       AND status = 'asked' AND last_asked_at IS NOT NULL
     ORDER BY last_asked_at DESC
     LIMIT $4`,
    [userId, personaId, workspaceId, limit],
  );
  return result.rows.map(toOpenLoop);
}

export async function listActiveProspectiveScopes(
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<Array<{ userId: string; personaId: string; workspaceId: string }>> {
  const result = await db.query<{ user_id: string; persona_id: string; workspace_id: string }>(
    `SELECT DISTINCT user_id, persona_id, workspace_id
     FROM world_model_open_loops
     WHERE status IN ('open','scheduled')`,
  );
  return result.rows.map((row) => ({
    userId: row.user_id,
    personaId: row.persona_id,
    workspaceId: row.workspace_id,
  }));
}

export async function listOverdueOpenLoops(
  maxAgeMs: number,
  now: string,
  limit = 100,
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<OpenLoopRecord[]> {
  const cutoff = new Date(new Date(now).getTime() - maxAgeMs).toISOString();
  const result = await db.query<OpenLoopRow>(
    `SELECT id, user_id, persona_id, workspace_id, type, status, subject_id, question,
            missing_information, importance, trigger_at, do_not_ask_before, last_checked_at,
            deduplication_key, max_attempts, attempts, last_asked_at, resolved_observation_id,
            note, created_at, updated_at
     FROM world_model_open_loops WHERE status = 'open' AND updated_at <= $1
     ORDER BY updated_at ASC LIMIT $2`,
    [cutoff, limit],
  );
  return result.rows.map(toOpenLoop);
}

export async function insertStandingIntent(
  input: StandingIntentInput,
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<StandingIntentRecord> {
  const result = await db.query<IntentRow>(
    `INSERT INTO world_model_standing_intents
      (user_id, persona_id, workspace_id, description, trigger_terms, event_type, subject_scope,
       channel_scope, sender_scope, expires_at, cooldown_ms, max_fires, deduplication_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (user_id, persona_id, workspace_id, deduplication_key) DO UPDATE SET
       description = EXCLUDED.description, trigger_terms = EXCLUDED.trigger_terms,
       event_type = EXCLUDED.event_type, updated_at = now()
     RETURNING id, user_id, persona_id, workspace_id, description, trigger_terms, event_type,
               subject_scope, channel_scope, sender_scope, status, expires_at, cooldown_until,
               cooldown_ms, fire_count, max_fires, last_fired_at, deduplication_key, note,
               created_at, updated_at`,
    [
      input.userId,
      input.personaId,
      input.workspaceId ?? '',
      input.description,
      JSON.stringify(input.triggerTerms ?? []),
      input.eventType ?? null,
      input.subjectScope ?? null,
      input.channelScope ?? null,
      input.senderScope ?? null,
      input.expiresAt ?? null,
      input.cooldownMs ?? 0,
      input.maxFires ?? 0,
      input.deduplicationKey,
    ],
  );
  return toIntent(result.rows[0]);
}

export async function listArmedStandingIntents(
  userId: string,
  personaId: string,
  now = new Date().toISOString(),
  workspaceId = '',
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<StandingIntentRecord[]> {
  await db.query(
    `UPDATE world_model_standing_intents
     SET status = 'expired', updated_at = now()
     WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $4
       AND expires_at IS NOT NULL AND expires_at <= $3
       AND status IN ('armed','cooldown')`,
    [userId, personaId, now, workspaceId],
  );
  await db.query(
    `UPDATE world_model_standing_intents
     SET status = 'armed', cooldown_until = NULL, updated_at = now()
     WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $4 AND status = 'cooldown'
       AND cooldown_until IS NOT NULL AND cooldown_until <= $3
       AND (expires_at IS NULL OR expires_at > $3)
       AND (max_fires = 0 OR fire_count < max_fires)`,
    [userId, personaId, now, workspaceId],
  );
  const result = await db.query<IntentRow>(
    `SELECT id, user_id, persona_id, workspace_id, description, trigger_terms, event_type,
            subject_scope, channel_scope, sender_scope, status, expires_at, cooldown_until,
            cooldown_ms, fire_count, max_fires, last_fired_at, deduplication_key, note,
            created_at, updated_at
     FROM world_model_standing_intents
     WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $4 AND status = 'armed'
       AND (expires_at IS NULL OR expires_at > $3)
       AND (max_fires = 0 OR fire_count < max_fires)`,
    [userId, personaId, now, workspaceId],
  );
  return result.rows.map(toIntent);
}

export async function registerStandingIntentFire(
  id: string,
  now: string,
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<void> {
  await db.query(
    `UPDATE world_model_standing_intents
     SET fire_count = fire_count + 1, last_fired_at = $2,
         cooldown_until = CASE WHEN cooldown_ms > 0
           THEN ($2::timestamptz + make_interval(secs => cooldown_ms / 1000.0)) ELSE cooldown_until END,
         status = CASE
           WHEN max_fires > 0 AND fire_count + 1 >= max_fires THEN 'done'
           WHEN cooldown_ms > 0 THEN 'cooldown'
           ELSE 'armed' END,
         updated_at = now()
     WHERE id = $1`,
    [id, now],
  );
}

export async function markOpenLoopAsked(
  loopId: string,
  now: string,
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<void> {
  await db.query(
    `UPDATE world_model_open_loops
     SET attempts = attempts + 1,
         last_asked_at = $2,
         status = CASE WHEN attempts + 1 >= max_attempts THEN 'expired' ELSE 'asked' END,
         updated_at = now()
     WHERE id = $1 AND status IN ('open','scheduled')
       AND (do_not_ask_before IS NULL OR do_not_ask_before <= $2)`,
    [loopId, now],
  );
}

export async function countAskedOpenLoopsToday(
  userId: string,
  personaId: string,
  workspaceId = '',
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const result = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM world_model_open_loops
     WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
       AND last_asked_at >= $4`,
    [userId, personaId, workspaceId, startOfDay.toISOString()],
  );
  return Number(result.rows[0]?.count ?? 0);
}
