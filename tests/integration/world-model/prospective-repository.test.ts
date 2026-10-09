import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  closeWorldModelDb,
  runWorldModelMigrations,
  withWorldModelTransaction,
} from '@/server/world-model/db';
import { deleteWorldModelScope } from '@/server/world-model/dataLifecycle';
import { insertObservation } from '@/server/world-model/repositories/observationRepository';
import {
  claimDueOpenLoop,
  countAskedOpenLoopsToday,
  getOpenLoopByKey,
  insertOpenLoop,
  insertStandingIntent,
  listActiveProspectiveScopes,
  listArmedStandingIntents,
  listAskedOpenLoops,
  listDueOpenLoops,
  listOverdueOpenLoops,
  markOpenLoopAsked,
  registerStandingIntentFire,
  releaseOpenLoopLease,
  updateOpenLoopStatus,
} from '@/server/world-model/repositories/prospectiveRepository';
import type { WorldModelScope } from '@/server/world-model/scope';

const enabled = process.env.WORLD_MODEL_E2E === 'true';
const createdScopes: WorldModelScope[] = [];

function newScope(scenario: string, workspaceId = 'coverage'): WorldModelScope {
  const scope = {
    userId: `prospective-repository-${scenario}-${Date.now()}`,
    personaId: 'assistant',
    workspaceId,
  };
  createdScopes.push(scope);
  return scope;
}

describe.skipIf(!enabled)('World Model prospective PostgreSQL repository', () => {
  beforeAll(async () => {
    await runWorldModelMigrations();
  });

  afterAll(async () => {
    for (const scope of createdScopes) await deleteWorldModelScope(scope);
    await closeWorldModelDb();
  });

  it('inserts, deduplicates, reads, claims and releases open-loop leases by scope', async () => {
    const scope = newScope('leases');
    const now = new Date().toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    const loop = await insertOpenLoop({
      ...scope,
      type: 'clarification',
      question: 'Who owns this task?',
      missingInformation: 'owner',
      importance: 4,
      deduplicationKey: 'owner',
      maxAttempts: 3,
    });
    const duplicate = await insertOpenLoop({
      ...scope,
      type: 'confirmation',
      question: 'Confirm the owner?',
      deduplicationKey: 'owner',
    });
    const futureLoop = await insertOpenLoop({
      ...scope,
      type: 'dependency',
      question: 'Wait for the release?',
      triggerAt: future,
      doNotAskBefore: future,
      deduplicationKey: 'future-release',
    });

    expect(duplicate).toMatchObject({
      id: loop.id,
      type: 'confirmation',
      question: 'Who owns this task?',
    });
    expect(
      await getOpenLoopByKey(scope.userId, scope.personaId, 'owner', scope.workspaceId),
    ).toMatchObject({
      id: loop.id,
      attempts: 0,
      importance: 4,
      missingInformation: 'owner',
      maxAttempts: 3,
    });
    await expect(
      getOpenLoopByKey(scope.userId, scope.personaId, 'absent', scope.workspaceId),
    ).resolves.toBeNull();

    const due = await listDueOpenLoops(scope.userId, scope.personaId, now, scope.workspaceId);
    expect(due.map((entry) => entry.id)).toContain(loop.id);
    expect(due.map((entry) => entry.id)).not.toContain(futureLoop.id);
    const claimed = await claimDueOpenLoop(
      scope.userId,
      scope.personaId,
      now,
      scope.workspaceId,
      'worker-a',
      30_000,
    );
    expect(claimed?.id).toBe(loop.id);
    await expect(
      claimDueOpenLoop(scope.userId, scope.personaId, now, scope.workspaceId, 'worker-b'),
    ).resolves.toBeNull();
    await releaseOpenLoopLease(loop.id, null);
    expect(
      (await listDueOpenLoops(scope.userId, scope.personaId, now, scope.workspaceId)).map(
        (entry) => entry.id,
      ),
    ).toContain(loop.id);

    const scopes = await listActiveProspectiveScopes();
    expect(scopes).toContainEqual({
      userId: scope.userId,
      personaId: scope.personaId,
      workspaceId: scope.workspaceId,
    });
  });

  it('updates open-loop status fields and returns only asked loops in history queries', async () => {
    const scope = newScope('asked');
    const asked = await insertOpenLoop({
      ...scope,
      type: 'confirmation',
      question: 'Is the date correct?',
      deduplicationKey: 'asked',
      maxAttempts: 3,
    });
    const expired = await insertOpenLoop({
      ...scope,
      type: 'clarification',
      question: 'Who will join?',
      deduplicationKey: 'expired',
      maxAttempts: 1,
    });
    const deferred = await insertOpenLoop({
      ...scope,
      type: 'missing_context',
      question: 'What is the budget?',
      doNotAskBefore: new Date(Date.now() + 60_000).toISOString(),
      deduplicationKey: 'deferred',
    });
    const now = new Date().toISOString();
    const observation = await insertObservation({
      ...scope,
      sourceType: 'manual',
      sourceId: `asked-loop-${asked.id}`,
      occurredAt: now,
      payload: { text: 'The user confirmed the date.' },
    });

    await markOpenLoopAsked(asked.id, now);
    await markOpenLoopAsked(expired.id, now);
    await markOpenLoopAsked(deferred.id, now);
    expect(
      await getOpenLoopByKey(scope.userId, scope.personaId, 'asked', scope.workspaceId),
    ).toMatchObject({
      status: 'asked',
      attempts: 1,
      lastAskedAt: now,
    });
    expect(
      await getOpenLoopByKey(scope.userId, scope.personaId, 'expired', scope.workspaceId),
    ).toMatchObject({
      status: 'expired',
      attempts: 1,
    });
    expect(
      await getOpenLoopByKey(scope.userId, scope.personaId, 'deferred', scope.workspaceId),
    ).toMatchObject({
      status: 'open',
      attempts: 0,
    });
    await updateOpenLoopStatus(asked.id, 'answered', {
      lastCheckedAt: now,
      lastAskedAt: now,
      resolvedObservationId: observation.id,
      note: 'confirmed by the user',
    });
    await updateOpenLoopStatus(expired.id, 'open');
    await expect(
      listAskedOpenLoops(scope.userId, scope.personaId, scope.workspaceId),
    ).resolves.toEqual([]);
    await expect(
      countAskedOpenLoopsToday(scope.userId, scope.personaId, scope.workspaceId),
    ).resolves.toBe(2);
    await updateOpenLoopStatus(asked.id, 'asked');
    await expect(
      listAskedOpenLoops(scope.userId, scope.personaId, scope.workspaceId),
    ).resolves.toMatchObject([
      expect.objectContaining({
        id: asked.id,
        status: 'asked',
        note: 'confirmed by the user',
        resolvedObservationId: observation.id,
      }),
    ]);
  });

  it('returns overdue open loops using the requested age cutoff', async () => {
    const scope = newScope('overdue');
    const overdue = await insertOpenLoop({
      ...scope,
      type: 'promised_follow_up',
      question: 'Did the follow-up happen?',
      deduplicationKey: 'overdue',
    });
    await withWorldModelTransaction((db) =>
      db.query(
        "UPDATE world_model_open_loops SET updated_at = now() - interval '2 days' WHERE id = $1",
        [overdue.id],
      ),
    );

    await expect(
      listOverdueOpenLoops(24 * 60 * 60 * 1000, new Date().toISOString()),
    ).resolves.toContainEqual(expect.objectContaining({ id: overdue.id, status: 'open' }));
    const oldCutoff = await listOverdueOpenLoops(7 * 24 * 60 * 60 * 1000, new Date().toISOString());
    expect(oldCutoff.map((entry) => entry.id)).not.toContain(overdue.id);
  });

  it('uses the default workspace and maps unanswered loops as optional fields', async () => {
    const scope = newScope('default-workspace', '');
    const inputScope = { userId: scope.userId, personaId: scope.personaId };
    const loop = await insertOpenLoop({
      ...inputScope,
      type: 'clarification',
      deduplicationKey: 'unanswered',
    });
    const intent = await insertStandingIntent({
      ...inputScope,
      description: 'Notify me about updates',
      triggerTerms: [],
      deduplicationKey: 'default-workspace',
    });

    expect(loop).toMatchObject({ workspaceId: '', question: undefined });
    await expect(
      getOpenLoopByKey(scope.userId, scope.personaId, 'unanswered'),
    ).resolves.toMatchObject({ id: loop.id, question: undefined });
    await expect(listArmedStandingIntents(scope.userId, scope.personaId)).resolves.toContainEqual(
      expect.objectContaining({ id: intent.id, workspaceId: '' }),
    );
  });

  it('maps standing-intent defaults and updates records by their scoped deduplication key', async () => {
    const scope = newScope('intent-upsert');
    const created = await insertStandingIntent({
      ...scope,
      description: 'Notify me about the project release',
      triggerTerms: ['release', 'shipped'],
      eventType: 'project_update',
      subjectScope: 'project-1',
      channelScope: 'telegram',
      senderScope: 'owner',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      cooldownMs: 30_000,
      maxFires: 4,
      deduplicationKey: 'release',
    });
    const updated = await insertStandingIntent({
      ...scope,
      description: 'Notify me when the project ships',
      triggerTerms: ['shipped'],
      deduplicationKey: 'release',
    });
    const defaults = await insertStandingIntent({
      ...scope,
      description: 'Remind me about the weekly review',
      triggerTerms: [],
      deduplicationKey: 'weekly-review',
    });

    expect(updated).toMatchObject({
      id: created.id,
      description: 'Notify me when the project ships',
      triggerTerms: ['shipped'],
      eventType: undefined,
      subjectScope: 'project-1',
      channelScope: 'telegram',
      senderScope: 'owner',
    });
    expect(defaults).toMatchObject({
      status: 'armed',
      workspaceId: scope.workspaceId,
      cooldownMs: 0,
      maxFires: 0,
      triggerTerms: [],
    });
  });

  it('expires, rearms and limits standing intents as cooldown and fire caps require', async () => {
    const scope = newScope('intent-lifecycle');
    const now = new Date();
    const nowIso = now.toISOString();
    const laterIso = new Date(now.getTime() + 5_000).toISOString();
    const cooldown = await insertStandingIntent({
      ...scope,
      description: 'Fire after cooldown',
      triggerTerms: ['ready'],
      cooldownMs: 1_000,
      deduplicationKey: 'cooldown',
    });
    const capped = await insertStandingIntent({
      ...scope,
      description: 'Fire only once',
      triggerTerms: ['once'],
      maxFires: 1,
      deduplicationKey: 'capped',
    });
    const expires = await insertStandingIntent({
      ...scope,
      description: 'Already expired',
      triggerTerms: ['expired'],
      expiresAt: new Date(now.getTime() - 1_000).toISOString(),
      deduplicationKey: 'expired',
    });

    await registerStandingIntentFire(cooldown.id, nowIso);
    await registerStandingIntentFire(capped.id, nowIso);
    const afterCooldown = await listArmedStandingIntents(
      scope.userId,
      scope.personaId,
      laterIso,
      scope.workspaceId,
    );
    expect(afterCooldown.map((intent) => intent.id)).toContain(cooldown.id);
    expect(afterCooldown.map((intent) => intent.id)).not.toContain(capped.id);
    expect(afterCooldown.map((intent) => intent.id)).not.toContain(expires.id);
    expect(afterCooldown.find((intent) => intent.id === cooldown.id)).toMatchObject({
      status: 'armed',
      fireCount: 1,
      lastFiredAt: nowIso,
      cooldownMs: 1_000,
    });

    await registerStandingIntentFire(cooldown.id, laterIso);
    const whileCoolingDown = await listArmedStandingIntents(
      scope.userId,
      scope.personaId,
      laterIso,
      scope.workspaceId,
    );
    expect(whileCoolingDown.map((intent) => intent.id)).not.toContain(cooldown.id);
    const statuses = await withWorldModelTransaction((db) =>
      db.query<{ id: string; status: string }>(
        'SELECT id, status FROM world_model_standing_intents WHERE id = ANY($1::uuid[])',
        [[capped.id, expires.id]],
      ),
    );
    expect(statuses.rows).toEqual(
      expect.arrayContaining([
        { id: capped.id, status: 'done' },
        { id: expires.id, status: 'expired' },
      ]),
    );
  });
});
