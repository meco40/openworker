import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evaluateGraphitiValue } from '@/server/world-model/graphiti/evaluator';
import {
  closeWorldModelDb,
  runWithWorldModelScope,
  runWorldModelMigrations,
} from '@/server/world-model/db';
import { insertShadowEdge } from '@/server/world-model/graphiti/shadow';
import { insertEvent } from '@/server/world-model/repositories/eventRepository';
import {
  addGraphitiMessages,
  clearGraphitiScope,
  graphitiGroupId,
  getGraphitiQueueStatus,
  searchGraphitiFacts,
  waitForGraphitiQueue,
} from '@/server/world-model/graphiti/client';
import { deleteWorldModelScope } from '@/server/world-model/dataLifecycle';

const testScope = {
  userId: 'test_eval_user',
  personaId: 'test_eval_persona',
  workspaceId: 'test_eval_workspace',
};
const enabled = process.env.GRAPHITI_SHADOW_E2E === 'true';

describe.skipIf(!enabled)('Graphiti Shadow Comparison & Evaluation Integration', () => {
  beforeAll(async () => {
    await runWorldModelMigrations();
  });

  afterAll(async () => {
    if (process.env.GRAPHITI_E2E === 'true') {
      await clearGraphitiScope(testScope.userId, testScope.personaId, testScope.workspaceId).catch(
        () => {},
      );
    }
    await deleteWorldModelScope(testScope).catch(() => {});
    await closeWorldModelDb();
  });

  it('evaluates shadow comparison against structured truth and defaults safely to fallback/shadow', async () => {
    await runWithWorldModelScope(testScope, async () => {
      // 1. Create a structured event
      await insertEvent({
        userId: testScope.userId,
        personaId: testScope.personaId,
        workspaceId: testScope.workspaceId,
        title: 'Project Kickoff Meeting',
        eventType: 'meeting',
        status: 'planned',
        scheduledFor: '2026-08-19T10:00:00Z',
      });

      // 2. Record graphiti shadow edge
      await insertShadowEdge({
        userId: testScope.userId,
        personaId: testScope.personaId,
        workspaceId: testScope.workspaceId,
        sourceOutboxEventId: crypto.randomUUID(),
        sourceAggregate: 'observation',
        sourceEntity: 'Project',
        targetEntity: 'Kickoff',
        relationType: 'IS_A',
      });

      // 3. Run evaluation
      const evalResult = await evaluateGraphitiValue(testScope);
      expect(evalResult).toBeDefined();
      expect(typeof evalResult.shadowEdgeCount).toBe('number');
      expect(typeof evalResult.structuredHitCount).toBe('number');
      expect(evalResult.structuredHitCount).toBeGreaterThan(0);
      expect(['enable', 'shadow', 'fallback']).toContain(evalResult.recommendation);
    });
  });

  it.runIf(process.env.GRAPHITI_E2E === 'true')(
    'verifies a real Graphiti message, search result, and scoped deletion',
    async () => {
      const scope = {
        userId: `graphiti-e2e-${Date.now()}`,
        personaId: 'verification',
        workspaceId: 'integration',
      };
      const groupId = graphitiGroupId(scope.userId, scope.personaId, scope.workspaceId);
      const queueBefore = await getGraphitiQueueStatus();
      await addGraphitiMessages(groupId, [
        {
          name: 'graphiti-e2e',
          content: 'Alice is responsible for the World Model integration verification project.',
          roleType: 'system',
          role: null,
          sourceDescription: 'World Model Graphiti integration test',
        },
      ]);
      const queueAfter = await waitForGraphitiQueue({
        timeoutMs: Number(process.env.GRAPHITI_E2E_QUEUE_TIMEOUT_MS) || 240_000,
        pollMs: 1_000,
        baselineFailedJobs: queueBefore.failedJobs,
      });
      expect(queueAfter.completedJobs).toBeGreaterThan(queueBefore.completedJobs);
      const facts = await searchGraphitiFacts(
        groupId,
        'Alice responsible World Model integration',
        10,
      );
      expect(facts.length).toBeGreaterThan(0);
      await clearGraphitiScope(scope.userId, scope.personaId, scope.workspaceId);
      expect(
        await searchGraphitiFacts(groupId, 'Alice responsible World Model integration', 10),
      ).toEqual([]);
    },
    300_000,
  );
});
