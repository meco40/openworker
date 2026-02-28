import { describe, expect, it } from 'vitest';
import { verifyExecutionResult } from '@/server/master/verification';
import type { MasterStep } from '@/server/master/types';

function step(phase: string, status: MasterStep['status']): MasterStep {
  return {
    id: `step-${phase}-${status}`,
    runId: 'run-1',
    userId: 'u1',
    workspaceId: 'w1',
    seq: 1,
    phase,
    status,
    input: 'in',
    output: 'out',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('master verification gate', () => {
  it('fails when outputs are empty', () => {
    const report = verifyExecutionResult({
      outputs: ['   '],
      steps: [step('aggregation:web_search', 'done')],
      expectedCapabilities: ['web_search'],
    });
    expect(report.status).toBe('failed');
  });

  it('returns needs_refinement for low-detail output', () => {
    const report = verifyExecutionResult({
      outputs: ['short'],
      steps: [step('aggregation:web_search', 'done')],
      expectedCapabilities: ['web_search'],
    });
    expect(report.status).toBe('needs_refinement');
  });

  it('passes for structured output with full capability coverage', () => {
    const report = verifyExecutionResult({
      outputs: ['This is a structured output with enough detail for verification.'],
      steps: [step('delegation:web_search', 'done'), step('aggregation:web_search', 'done')],
      expectedCapabilities: ['web_search'],
    });
    expect(report.status).toBe('passed');
  });
});
