import { describe, expect, it } from 'vitest';
import { OpenAiWorkerEventGuard } from '../../../src/server/worker/openai/eventGuard';
import {
  OPENAI_WORKER_EVENT_SCHEMA_VERSION,
  isCompatibleSchemaVersion,
} from '../../../src/server/worker/openai/eventSchemaVersion';
import type { OpenAiWorkerEventEnvelope } from '../../../src/server/worker/openai/types';

function makeEvent(schemaVersion: number): OpenAiWorkerEventEnvelope {
  return {
    schemaVersion,
    eventId: `evt-${schemaVersion}`,
    runId: 'run-schema',
    taskId: 'task-schema',
    type: 'task.progress',
    seq: 1,
    emittedAt: new Date().toISOString(),
    attempt: 1,
    signature: 'sig',
    keyId: 'k1',
  };
}

describe('openai schema version compatibility', () => {
  it('accepts N and N-1, rejects unknown major values', () => {
    expect(isCompatibleSchemaVersion(OPENAI_WORKER_EVENT_SCHEMA_VERSION)).toBe(true);
    expect(isCompatibleSchemaVersion(OPENAI_WORKER_EVENT_SCHEMA_VERSION - 1)).toBe(true);
    expect(isCompatibleSchemaVersion(OPENAI_WORKER_EVENT_SCHEMA_VERSION + 1)).toBe(false);
    expect(isCompatibleSchemaVersion(-1)).toBe(false);
  });

  it('guard rejects incompatible schema versions', () => {
    const guard = new OpenAiWorkerEventGuard();
    expect(guard.apply(makeEvent(OPENAI_WORKER_EVENT_SCHEMA_VERSION + 1))).toBe(
      'rejected_out_of_order',
    );
  });
});
