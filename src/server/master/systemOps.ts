import type { ApprovalDecision } from '@/server/master/types';
import { evaluateSystemActionSafety } from '@/server/master/safety';

export interface SystemOpResult {
  status: 'blocked' | 'awaiting_approval' | 'executed';
  output: string;
}

export function executeSystemOperation(input: {
  command: string;
  decision?: ApprovalDecision;
}): SystemOpResult {
  const safety = evaluateSystemActionSafety(input.command);
  if (!safety.allowed) {
    return { status: 'blocked', output: `Blocked: ${safety.reason}` };
  }
  if (safety.requiresApproval) {
    if (!input.decision) {
      return { status: 'awaiting_approval', output: 'Approval required before execution.' };
    }
    if (input.decision === 'deny') {
      return { status: 'blocked', output: 'Action denied by operator.' };
    }
  }
  return { status: 'executed', output: `Dry-run simulated for command: ${input.command}` };
}
