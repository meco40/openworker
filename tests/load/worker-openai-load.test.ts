import { describe, expect, it } from 'vitest';
import {
  checkRateLimit,
  resetOpenAiRuntimeStateForTests,
} from '../../src/server/worker/openai/openaiWorkerRuntime';

describe('worker openai load guardrails', () => {
  it('keeps deterministic rate-limiter behavior under burst simulation', () => {
    process.env.OPENAI_WORKER_MAX_REQ_PER_MIN_PER_USER = '50';
    resetOpenAiRuntimeStateForTests();

    let accepted = 0;
    let rejected = 0;
    const now = 1_000_000;
    for (let i = 0; i < 80; i += 1) {
      const result = checkRateLimit('load-user', now);
      if (result.ok) accepted += 1;
      else rejected += 1;
    }

    expect(accepted).toBe(50);
    expect(rejected).toBe(30);
  });
});
