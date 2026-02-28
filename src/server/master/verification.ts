import type { MasterStep } from '@/server/master/types';

export type VerificationStatus = 'passed' | 'failed' | 'needs_refinement';

export interface VerificationCheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

export interface VerificationReport {
  status: VerificationStatus;
  score: number;
  summary: string;
  checks: VerificationCheckResult[];
}

function hasSufficientContent(output: string): boolean {
  return output.trim().length >= 24;
}

export function verifyExecutionResult(input: {
  outputs: string[];
  steps: MasterStep[];
  expectedCapabilities: string[];
}): VerificationReport {
  const checks: VerificationCheckResult[] = [];
  const blockedOrErrorSteps = input.steps.filter((step) => step.status === 'error');
  checks.push({
    name: 'no_error_steps',
    passed: blockedOrErrorSteps.length === 0,
    detail:
      blockedOrErrorSteps.length === 0
        ? 'No error steps found.'
        : `${blockedOrErrorSteps.length} step(s) ended with error.`,
  });

  const outputCount = input.outputs.filter((entry) => entry.trim().length > 0).length;
  checks.push({
    name: 'non_empty_outputs',
    passed: outputCount > 0,
    detail: outputCount > 0 ? `${outputCount} non-empty output(s).` : 'No non-empty output.',
  });

  const structuredCount = input.outputs.filter(hasSufficientContent).length;
  checks.push({
    name: 'structured_outputs',
    passed: structuredCount >= Math.max(1, Math.min(2, input.expectedCapabilities.length)),
    detail: `${structuredCount} sufficiently detailed output(s).`,
  });

  const phaseCoverage = input.expectedCapabilities.every((capability) =>
    input.steps.some((step) => step.phase.includes(capability)),
  );
  checks.push({
    name: 'capability_phase_coverage',
    passed: phaseCoverage,
    detail: phaseCoverage
      ? 'All planned capabilities produced phases.'
      : 'At least one planned capability is missing execution phases.',
  });

  const passedChecks = checks.filter((check) => check.passed).length;
  const score = Math.round((passedChecks / checks.length) * 100);

  if (!checks.find((entry) => entry.name === 'non_empty_outputs')?.passed) {
    return {
      status: 'failed',
      score,
      summary: 'Verification failed: no meaningful execution output produced.',
      checks,
    };
  }

  if (!checks.every((entry) => entry.passed)) {
    return {
      status: 'needs_refinement',
      score,
      summary: 'Verification requires refinement before completion.',
      checks,
    };
  }

  return {
    status: 'passed',
    score,
    summary: 'Verification passed.',
    checks,
  };
}
