const EXEC_APPROVALS_ENV = 'BETACLAW_EXEC_APPROVALS_REQUIRED';

/**
 * Exec approvals fail closed: only an explicit `false` (case-insensitive, untrimmed)
 * switches them off. An unset, empty or unrecognised value keeps them on.
 * Rust mirror: `are_exec_approvals_required` in `skills/exec_approval.rs`.
 */
export function areExecApprovalsRequired(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return String(env[EXEC_APPROVALS_ENV] ?? '').toLowerCase() !== 'false';
}
