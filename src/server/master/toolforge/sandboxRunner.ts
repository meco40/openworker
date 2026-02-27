export function runToolForgeSandboxChecks(input: { name: string; spec: string }): {
  passed: boolean;
  summary: string;
  riskReport: string;
} {
  const hasDangerousSignals = /rm\s+-rf|format\s+[a-z]:/i.test(input.spec);
  if (hasDangerousSignals) {
    return {
      passed: false,
      summary: 'Sandbox checks failed',
      riskReport: 'high: dangerous command patterns detected',
    };
  }
  return {
    passed: true,
    summary: 'Sandbox checks passed',
    riskReport: 'low: no dangerous patterns detected',
  };
}
