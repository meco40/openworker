import { describe, expect, it } from 'vitest';
import { normalizePlan } from '../../../src/modules/worker/services/executeTaskPlan';

describe('normalizePlan', () => {
  it('falls back to default step when plan is empty', () => {
    expect(normalizePlan([])).toEqual(['Execute objective and produce concise output.']);
  });
});
