import { describe, expect, it } from 'vitest';

import {
  toWorldModelTaskStatus,
  validateTaskTransition,
} from '@/server/world-model/services/missionControlBridge';

describe('Mission Control task status bridge', () => {
  it('maps external lifecycle states to canonical World Model states', () => {
    expect(toWorldModelTaskStatus('inbox')).toBe('proposed');
    expect(toWorldModelTaskStatus('planning')).toBe('planned');
    expect(toWorldModelTaskStatus('assigned')).toBe('in_progress');
    expect(toWorldModelTaskStatus('review')).toBe('waiting');
    expect(toWorldModelTaskStatus('done')).toBe('completed');
  });

  it('validates transitions after mapping instead of casting unrelated enums', () => {
    expect(validateTaskTransition('review', 'done').allowed).toBe(true);
    expect(validateTaskTransition('done', 'review').allowed).toBe(false);
  });
});
