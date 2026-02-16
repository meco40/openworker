import { describe, expect, it } from 'vitest';
import { OpenAiWorkerEventGuard } from '../../../src/server/worker/openai/eventGuard';
import { OPENAI_WORKER_EVENT_SCHEMA_VERSION } from '../../../src/server/worker/openai/eventSchemaVersion';
import type { OpenAiWorkerEventEnvelope } from '../../../src/server/worker/openai/types';

function makeEvent(eventId: string): OpenAiWorkerEventEnvelope {
  return {
    schemaVersion: OPENAI_WORKER_EVENT_SCHEMA_VERSION,
    eventId,
    runId: 'run-dup',
    taskId: 'task-dup',
    type: 'task.progress',
    seq: 1,
    emittedAt: new Date().toISOString(),
    attempt: 1,
    signature: 'sig',
    keyId: 'k1',
  };
}

describe('openai duplicate events', () => {
  it('marks duplicate event ids as duplicate', () => {
    const guard = new OpenAiWorkerEventGuard();
    const event = makeEvent('evt-same');

    expect(guard.apply(event)).toBe('applied');
    expect(guard.apply(event)).toBe('duplicate');
  });
});

