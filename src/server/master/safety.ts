export interface SafetyEvaluation {
  allowed: boolean;
  requiresApproval: boolean;
  reason?: string;
  risk: 'low' | 'medium' | 'high';
}

const FORBIDDEN_PATTERNS = [/rm\s+-rf\s+\//i, /del\s+\/s\s+\/q/i, /format\s+[a-z]:/i];
const HIGH_RISK_PATTERNS = [/shutdown/i, /restart/i, /kill\s+\d+/i, /sc\s+stop/i];
const MEDIUM_RISK_PATTERNS = [/npm\s+install/i, /git\s+push/i, /mkdir/i, /copy/i];

export function evaluateSystemActionSafety(command: string): SafetyEvaluation {
  const normalized = String(command || '').trim();
  if (!normalized) {
    return { allowed: false, requiresApproval: false, reason: 'empty_command', risk: 'high' };
  }
  if (FORBIDDEN_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { allowed: false, requiresApproval: false, reason: 'forbidden_action', risk: 'high' };
  }
  if (HIGH_RISK_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { allowed: true, requiresApproval: true, reason: 'high_risk', risk: 'high' };
  }
  if (MEDIUM_RISK_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { allowed: true, requiresApproval: true, reason: 'medium_risk', risk: 'medium' };
  }
  return { allowed: true, requiresApproval: false, risk: 'low' };
}
