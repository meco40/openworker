import crypto from 'node:crypto';

export function buildIdempotencyKey(input: {
  runId: string;
  stepId: string;
  actionType: string;
  actionPayload: string;
}): string {
  const hash = crypto.createHash('sha256').update(input.actionPayload).digest('hex').slice(0, 16);
  return `${input.runId}:${input.stepId}:${input.actionType}:${hash}`;
}

export function isCommittedState(state: string): boolean {
  return state === 'committed';
}
