import { describe, expect, it } from 'vitest';

import { classifyPrRisk } from '@/server/stats/prRiskClassifier';

describe('classifyPrRisk', () => {
  it('marks tiny change sets as low risk', () => {
    const result = classifyPrRisk({ linesChanged: 120 });
    expect(result.level).toBe('low');
    expect(result.requiresSplitReason).toBe(false);
  });

  it('marks medium change sets as medium risk', () => {
    const result = classifyPrRisk({ linesChanged: 320 });
    expect(result.level).toBe('medium');
    expect(result.requiresSplitReason).toBe(false);
  });

  it('requires a split reason for large change sets', () => {
    const result = classifyPrRisk({ linesChanged: 610 });
    expect(result.level).toBe('high');
    expect(result.requiresSplitReason).toBe(true);
  });
});
