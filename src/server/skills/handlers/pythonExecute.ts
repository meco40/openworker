import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { isCommandApproved } from '@/server/gateway/exec-approval-manager';
import { areExecApprovalsRequired } from '@/server/skills/execApprovalPolicy';
import {
  commandFingerprint,
  evaluateNodeCommandPolicy,
} from '@/server/gateway/node-command-policy';
import type { SkillDispatchContext } from '@/server/skills/types';
import { resolveSkillExecutionCwd } from '@/server/skills/handlers/executionCwd';

const execFile = promisify(execFileCallback);

export function buildPythonCommand(code: string): string {
  if (!code) throw new Error('python_execute requires code.');
  // Keep approval identity exact even when command normalization collapses Python indentation.
  const hash = createHash('sha256').update(code).digest('hex');
  return `python -c ${JSON.stringify(code)} # code-sha256=${hash}`;
}

export async function pythonExecuteHandler(
  args: Record<string, unknown>,
  context?: SkillDispatchContext,
) {
  const code = String(args.code || '').trim();
  const command = buildPythonCommand(code);
  const policy = evaluateNodeCommandPolicy(command);
  if (!policy.allowed) throw new Error(policy.reason || 'Command blocked by security policy.');
  if (
    areExecApprovalsRequired() &&
    !context?.bypassApproval &&
    !isCommandApproved(policy.normalizedCommand)
  ) {
    throw new Error(`Command requires approval. Fingerprint: ${commandFingerprint(command)}`);
  }

  try {
    const cwd = resolveSkillExecutionCwd(context);
    const { stdout, stderr } = await execFile(
      process.platform === 'win32' ? 'python' : 'python3',
      ['-c', code],
      {
        cwd,
        timeout: 20_000,
        maxBuffer: 1_000_000,
      },
    );
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const typed = error as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    const numericExitCode =
      typeof typed.code === 'number'
        ? typed.code
        : Number.isFinite(Number(typed.code))
          ? Number(typed.code)
          : 1;
    return {
      stdout: typed.stdout || '',
      stderr:
        typed.stderr ||
        (typed.code === 'ENOENT'
          ? 'Python is not installed. Install Python 3 or use the supported Docker image.'
          : 'Python execution failed.'),
      exitCode: numericExitCode,
    };
  }
}
