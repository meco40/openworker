import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { isCommandApproved } from '@/server/gateway/exec-approval-manager';
import {
  commandFingerprint,
  evaluateNodeCommandPolicy,
  normalizeCommand,
} from '@/server/gateway/node-command-policy';
import { resolveShellExecutionOptionsFromEnv } from '@/server/skills/handlers/shellExecute';
import { resolveSkillExecutionCwd } from '@/server/skills/handlers/executionCwd';
import {
  assertPlaywrightSubcommandAllowed,
  buildPlaywrightCliCommand,
  resolvePlaywrightCliTokens,
} from '@/server/skills/handlers/playwrightCliCommand';
import type { SkillDispatchContext } from '@/server/skills/types';

const execFile = promisify(execFileCallback);

function resolveShell(command: string): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: 'powershell', args: ['-NoProfile', '-Command', command] };
  }
  return { file: '/bin/sh', args: ['-lc', command] };
}

function quoteToken(token: string): string {
  if (token.length === 0) return "''";
  if (process.platform === 'win32') {
    return `'${token.replaceAll("'", "''")}'`;
  }
  return `'${token.replaceAll("'", "'\"'\"'")}'`;
}

function buildShellCommand(tokens: string[]): string {
  const quoted = tokens.map((token) => quoteToken(token));
  return ['npx', 'playwright', ...quoted].join(' ');
}

export async function playwrightCliHandler(
  args: Record<string, unknown>,
  context?: SkillDispatchContext,
) {
  const tokens = resolvePlaywrightCliTokens(args);
  assertPlaywrightSubcommandAllowed(tokens);
  const command = buildPlaywrightCliCommand(tokens);

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

  const cwd = resolveSkillExecutionCwd(context);
  const { timeoutMs, maxBufferBytes } = resolveShellExecutionOptionsFromEnv();
  const shell = resolveShell(buildShellCommand(tokens));
  try {
    const { stdout, stderr } = await execFile(shell.file, shell.args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: maxBufferBytes,
    });
    return {
      command,
      cwd,
      stdout,
      stderr: stderr || '',
      exitCode: 0,
    };
  } catch (error) {
    const typed = error as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      signal?: string | null;
    };
    return {
      command,
      cwd,
      stdout: typed.stdout || '',
      stderr: typed.stderr || String(error),
      exitCode: typeof typed.code === 'number' ? typed.code : 1,
      signal: typed.signal || null,
    };
  }
}
