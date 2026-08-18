import { describe, expect, it } from 'vitest';

import {
  canTransitionTask,
  isTaskCompletionAllowed,
  resolveTaskTransition,
} from '@/server/world-model/services/canonicalTaskService';

describe('canonicalTaskService', () => {
  it('allows planned -> in_progress', () => {
    expect(canTransitionTask('planned', 'in_progress')).toBe(true);
  });

  it('forbids completed -> anything', () => {
    expect(canTransitionTask('completed', 'in_progress')).toBe(false);
  });

  it('allows waiting -> completed', () => {
    expect(canTransitionTask('waiting', 'completed')).toBe(true);
  });

  it('resolves a missing current as proposed -> ok', () => {
    expect(resolveTaskTransition(undefined, 'planned')).toEqual({
      allowed: true,
      from: 'proposed',
      to: 'planned',
      reason: 'ok',
    });
  });

  it('rejects invalid transitions', () => {
    expect(resolveTaskTransition('completed', 'failed')).toMatchObject({
      allowed: false,
      reason: 'invalid_transition',
    });
  });

  it('prevents double completion', () => {
    expect(isTaskCompletionAllowed('completed')).toBe(false);
    expect(isTaskCompletionAllowed('in_progress')).toBe(true);
  });
});
