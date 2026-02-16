import { describe, expect, it } from 'vitest';
import { OpenAiWorkerEventGuard } from '../../../src/server/worker/openai/eventGuard';
import { OPENAI_WORKER_EVENT_SCHEMA_VERSION } from '../../../src/server/worker/openai/eventSchemaVersion';
import type { OpenAiWorkerEventEnvelope } from '../../../src/server/worker/openai/types';

function makeEvent(seq: number, eventId: string): OpenAiWorkerEventEnvelope {
  return {
    schemaVersion: OPENAI_WORKER_EVENT_SCHEMA_VERSION,
    eventId,
    runId: 'run-1',
    taskId: 'task-1',
    type: 'task.progress',
    seq,
    emittedAt: new Date().toISOString(),
    attempt: 1,
    signature: 'sig',
    keyId: 'k1',
  };
}

describe('openai event ordering', () => {
  it('rejects out-of-order events for the same run', () => {
    const guard = new OpenAiWorkerEventGuard();

    expect(guard.apply(makeEvent(1, 'evt-1'))).toBe('applied');
    expect(guard.apply(makeEvent(2, 'evt-2'))).toBe('applied');
    expect(guard.apply(makeEvent(2, 'evt-3'))).toBe('rejected_out_of_order');
    expect(guard.apply(makeEvent(1, 'evt-4'))).toBe('rejected_out_of_order');
  });
});

