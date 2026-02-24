import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { isCommandApproved } from '@/server/gateway/exec-approval-manager';
import {
  commandFingerprint,
  evaluateNodeCommandPolicy,
  normalizeCommand,
} from '@/server/gateway/node-command-policy';
import type { SkillDispatchContext } from '@/server/skills/types';
import { resolveSkillExecutionCwd } from '@/server/skills/handlers/executionCwd';

const execFile = promisify(execFileCallback);

const DEFAULT_SHELL_TIMEOUT_MS = 10 * 60 * 1000;
const MIN_SHELL_TIMEOUT_MS = 5_000;
const MAX_SHELL_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const DEFAULT_SHELL_MAX_BUFFER_BYTES = 10_000_000;
const MIN_SHELL_MAX_BUFFER_BYTES = 1_000_000;
const MAX_SHELL_MAX_BUFFER_BYTES = 100_000_000;

function resolveShell(command: string): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: 'powershell', args: ['-NoProfile', '-Command', command] };
  }

  // Use /bin/sh for broad Linux/container compatibility (e.g. alpine).
  return { file: '/bin/sh', args: ['-lc', command] };
}

export function resolveShellExecutionOptionsFromEnv(): {
  timeoutMs: number;
  maxBufferBytes: number;
} {
  const timeoutRaw = Number.parseInt(String(process.env.OPENCLAW_SHELL_TIMEOUT_MS || ''), 10);
  const timeoutMs = Number.isFinite(timeoutRaw)
    ? Math.max(MIN_SHELL_TIMEOUT_MS, Math.min(MAX_SHELL_TIMEOUT_MS, timeoutRaw))
    : DEFAULT_SHELL_TIMEOUT_MS;

  const maxBufferRaw = Number.parseInt(
    String(process.env.OPENCLAW_SHELL_MAX_BUFFER_BYTES || ''),
    10,
  );
  const maxBufferBytes = Number.isFinite(maxBufferRaw)
    ? Math.max(MIN_SHELL_MAX_BUFFER_BYTES, Math.min(MAX_SHELL_MAX_BUFFER_BYTES, maxBufferRaw))
    : DEFAULT_SHELL_MAX_BUFFER_BYTES;

  return { timeoutMs, maxBufferBytes };
}

/**
 * Advisory-only: detect $SHELL_VARS used inside Python/JS scripts (common LLM mistake).
 * Returns a warning string or null. Never throws.
 */
async function warnIfShellBleed(command: string, cwd: string): Promise<string | null> {
  const scriptMatch = command.match(
    /(?:python3?|node(?:js)?)\s+"?([\w./\\-]+\.(?:py|mjs?|cjs?))"?/,
  );
  if (!scriptMatch?.[1]) return null;

  const scriptPath = path.isAbsolute(scriptMatch[1])
    ? scriptMatch[1]
    : path.join(cwd, scriptMatch[1]);

  let content: string;
  try {
    content = await readFile(scriptPath, 'utf-8');
  } catch {
    return null; // Not readable — let the execution decide
  }

  const envVarRegex = /\$[A-Z_][A-Z0-9_]{2,}/g;
  const matches = content.match(envVarRegex);
  if (!matches?.length) return null;

  const unique = [...new Set(matches)].slice(0, 3).join(', ');
  return (
    `[shell-bleed-warning] Possible shell variable syntax (${unique}) detected in ${scriptMatch[1]}. ` +
    `In Python use os.environ.get('VAR'), in Node use process.env.VAR.`
  );
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
    const cwd = resolveSkillExecutionCwd(context);
    const { timeoutMs, maxBufferBytes } = resolveShellExecutionOptionsFromEnv();
    const { stdout, stderr } = await execFile(shell.file, shell.args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: maxBufferBytes,
    });
    const bleedWarning = await warnIfShellBleed(command, cwd);
    return {
      stdout,
      stderr: bleedWarning ? `${bleedWarning}\n${stderr || ''}`.trim() : stderr || '',
      exitCode: 0,
    };
  } catch (error) {
    const typed = error as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      signal?: string | null;
      killed?: boolean;
    };
    const timedOut =
      typed.code === 'ETIMEDOUT' ||
      typed.signal === 'SIGTERM' ||
      /\btimeout\b/i.test(String(typed.stderr || error));
    return {
      stdout: typed.stdout || '',
      stderr:
        typed.stderr || (timedOut ? 'Command timed out during shell execution.' : String(error)),
      exitCode: typeof typed.code === 'number' ? typed.code : timedOut ? 124 : 1,
    };
  }
}
