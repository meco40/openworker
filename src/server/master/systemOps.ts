import type { ApprovalDecision } from '@/server/master/types';
import { evaluateSystemActionSafety } from '@/server/master/safety';

export interface SystemOpResult {
  status: 'blocked' | 'awaiting_approval' | 'executed';
  output: string;
  requiresApproval?: boolean;
  risk?: 'low' | 'medium' | 'high';
}

export function executeSystemOperation(input: {
  command: string;
  decision?: ApprovalDecision;
}): SystemOpResult {
  const safety = evaluateSystemActionSafety(input.command);
  if (!safety.allowed) {
    return {
      status: 'blocked',
      output: `Blocked: ${safety.reason}`,
      requiresApproval: safety.requiresApproval,
      risk: safety.risk,
    };
  }
  if (safety.requiresApproval) {
    if (!input.decision) {
      return {
        status: 'awaiting_approval',
        output: 'Approval required before execution.',
        requiresApproval: true,
        risk: safety.risk,
      };
    }
    if (input.decision === 'deny') {
      return {
        status: 'blocked',
        output: 'Action denied by operator.',
        requiresApproval: true,
        risk: safety.risk,
      };
    }
  }
  return {
    status: 'executed',
    output: `Dry-run simulated for command: ${input.command}`,
    requiresApproval: safety.requiresApproval,
    risk: safety.risk,
  };
}

export async function executeSystemOperationWithRuntime(input: {
  command: string;
  approved: boolean;
  execute: () => Promise<{ stdout?: string; stderr?: string; exitCode?: number }>;
}): Promise<SystemOpResult> {
  const safety = evaluateSystemActionSafety(input.command);
  if (!safety.allowed) {
    return {
      status: 'blocked',
      output: `Blocked: ${safety.reason}`,
      requiresApproval: safety.requiresApproval,
      risk: safety.risk,
    };
  }
  if (safety.requiresApproval && !input.approved) {
    return {
      status: 'awaiting_approval',
      output: 'Approval required before execution.',
      requiresApproval: true,
      risk: safety.risk,
    };
  }

  const result = await input.execute();
  const output =
    typeof result.stdout === 'string' && result.stdout.trim().length > 0
      ? result.stdout.trim()
      : typeof result.stderr === 'string' && result.stderr.trim().length > 0
        ? result.stderr.trim()
        : `System command executed with exit code ${result.exitCode ?? 0}.`;
  return {
    status: 'executed',
    output,
    requiresApproval: safety.requiresApproval,
    risk: safety.risk,
  };
}
