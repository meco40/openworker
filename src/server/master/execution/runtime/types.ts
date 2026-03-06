import type { VerificationReport } from '@/server/master/verification';
import type { MasterRun } from '@/server/master/types';

export type Capability = 'web_search' | 'code_generation' | 'notes' | 'reminders' | 'system_ops';
export type RuntimeMode = 'model' | 'fallback';
export type MasterRuntimeTool =
  | 'notes'
  | 'reminders'
  | 'shell_execute'
  | 'web_search'
  | 'write'
  | 'read';

export interface ExecutionPlan {
  capabilities: Capability[];
  rationale: string;
  verificationChecks: string[];
  riskProfile: 'low' | 'medium' | 'high';
  requiresApproval: boolean;
  source: RuntimeMode;
}

export interface CapabilityControl {
  requiresApproval: boolean;
  actionType: string;
  fingerprint: string;
  filePath?: string;
  command?: string;
}

export interface CapabilityTaskResult {
  output: string;
  confidence: number;
  mode: RuntimeMode;
  degradedMode: boolean;
}

export interface ToolRunRequest {
  toolName: MasterRuntimeTool;
  actionType: string;
  fingerprint: string;
  requiresApproval: boolean;
  command?: string;
  path?: string;
  content?: string;
  query?: string;
  noteTitle?: string;
  noteContent?: string;
  noteTags?: string[];
  remindAt?: string;
  cronExpression?: string | null;
}

export type ToolRunResult =
  | { status: 'completed'; output: string; details?: unknown }
  | { status: 'approval_required'; summary: string }
  | { status: 'blocked'; reason: string };

export interface MasterRunExportBundle {
  runId: string;
  status: string;
  run: MasterRun;
  steps: Array<Record<string, unknown>>;
  delegations: {
    jobs: Array<Record<string, unknown>>;
    events: Array<Record<string, unknown>>;
  };
  verificationReport: VerificationReport | null;
  executionMode: RuntimeMode | null;
  exportedAt: string;
}
