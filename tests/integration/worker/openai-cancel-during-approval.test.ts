import { describe, expect, it } from 'vitest';
import { canTransition } from '../../../src/server/worker/workerStateMachine';

describe('openai cancel during approval', () => {
  it('allows manual cancel while waiting approval', () => {
    expect(canTransition('waiting_approval', 'cancelled', 'manual')).toBe(true);
  });
});
