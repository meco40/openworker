import { describe, expect, it } from 'vitest';
import {
  mapOpenAiRunStateToWorkerStatus,
  parseOpenAiRunState,
  type OpenAiWorkerRunState,
} from '../../../src/server/worker/openai/statusMapper';

describe('openai status mapper', () => {
  it('maps openai run states to worker statuses', () => {
    const cases: Array<{ input: OpenAiWorkerRunState; expected: string }> = [
      { input: 'planning', expected: 'planning' },
      { input: 'running', expected: 'executing' },
      { input: 'awaiting_approval', expected: 'waiting_approval' },
      { input: 'testing', expected: 'testing' },
      { input: 'review', expected: 'review' },
      { input: 'completed', expected: 'completed' },
      { input: 'failed', expected: 'failed' },
    ];

    for (const entry of cases) {
      expect(mapOpenAiRunStateToWorkerStatus(entry.input)).toBe(entry.expected);
    }
  });

  it('rejects unsupported state values', () => {
    expect(() => parseOpenAiRunState('mystery')).toThrow('Unsupported OpenAI worker run state');
  });
});
