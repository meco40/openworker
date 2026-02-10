const DEFAULT_PLAN_STEP = 'Execute objective and produce concise output.';

export function normalizePlan(plan: string[]): string[] {
  return plan.length > 0 ? plan : [DEFAULT_PLAN_STEP];
}

export function buildExecutionStepPrompt(
  taskPrompt: string,
  stepDesc: string,
  step: number,
  totalSteps: number,
): string {
  return `Task objective: "${taskPrompt}"\nCurrent step (${step}/${totalSteps}): ${stepDesc}\nProvide concise execution notes and outcome.`;
}

export function buildFinalizePrompt(taskPrompt: string, stepOutputs: string[]): string {
  return `Finalize result for "${taskPrompt}" using these step outputs:\n${stepOutputs.join('\n')}\nReturn strict JSON object with shape: {"result": string, "artifacts": [{"id": string, "name": string, "type": "code"|"pdf"|"doc", "content": string}]}`;
}
