import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { isCommandApproved } from '@/server/gateway/exec-approval-manager';
import {
  commandFingerprint,
  evaluateNodeCommandPolicy,
  normalizeCommand,
} from '@/server/gateway/node-command-policy';
import type { SkillDispatchContext } from '@/server/skills/types';

const execFile = promisify(execFileCallback);

function resolveShell(command: string): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: 'powershell', args: ['-NoProfile', '-Command', command] };
  }

  // Use a POSIX shell in CI/Linux environments.
  return { file: '/bin/bash', args: ['-lc', command] };
}

export async function shellExecuteHandler(
  args: Record<string, unknown>,
  context?: SkillDispatchContext,
) {
  const command = String(args.command || '').trim();
  if (!command) throw new Error('shell_execute requires command.');

  const policy = evaluateNodeCommandPolicy(command);
  if (!policy.allowed) {
    throw new Error(policy.reason || 'Command blocked by security policy.');
  }

  const requiresApproval =
    String(process.env.OPENCLAW_EXEC_APPROVALS_REQUIRED || 'false').toLowerCase() === 'true';
  if (
    requiresApproval &&
    !context?.bypassApproval &&
    !isCommandApproved(normalizeCommand(command))
  ) {
    throw new Error(
      [
        'Command requires approval.',
        `Fingerprint: ${commandFingerprint(command)}`,
        'Approve via CLI: npm run cli -- node approve --command "<command>"',
      ].join(' '),
    );
  }

  try {
    const shell = resolveShell(command);
    const { stdout, stderr } = await execFile(shell.file, shell.args, {
      cwd: process.cwd(),
      timeout: 15_000,
      maxBuffer: 1_000_000,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const typed = error as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    return {
      stdout: typed.stdout || '',
      stderr: typed.stderr || String(error),
      exitCode: typeof typed.code === 'number' ? typed.code : 1,
    };
  }
}
