/**
 * Process Manager — manage long-running background processes across tool calls.
 *
 * Agents often need to start a server / watcher, do other work, then check the
 * output later. shell_execute blocks until completion, so cannot be used for
 * daemons. This skill fills that gap.
 *
 * NOTE: Uses spawn + stdio:pipe (no PTY). Interactive programs (vim, etc.) will
 * not work. Use shell_execute for interactive commands.
 *
 * Available actions:
 *   start   — spawn a process, return its id
 *   poll    — read buffered stdout/stderr (non-destructive, returns last N chars)
 *   write   — write to stdin
 *   kill    — terminate process
 *   list    — list managed processes
 *   log     — alias for poll
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { isCommandApproved } from '@/server/gateway/exec-approval-manager';
import {
  commandFingerprint,
  evaluateNodeCommandPolicy,
  normalizeCommand,
} from '@/server/gateway/node-command-policy';
import { resolveSkillExecutionCwd } from '@/server/skills/handlers/executionCwd';
import type { SkillDispatchContext } from '@/server/skills/types';

const MAX_BUFFER_BYTES = 200_000; // per-process stdout+stderr combined
const DEFAULT_POLL_BYTES = 4_000; // tail bytes returned by poll/log
const DEFAULT_START_TIMEOUT_MS = 2_000; // wait for early crash before returning

interface ManagedProcess {
  id: string;
  label: string;
  command: string;
  cwd: string;
  pid: number | undefined;
  status: 'running' | 'exited' | 'killed';
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  outputBuffer: string; // circular — trimmed from start when > MAX_BUFFER_BYTES
}

const processes = new Map<string, { entry: ManagedProcess; child: ChildProcess }>();
let _idCounter = 0;

function generateId(): string {
  _idCounter += 1;
  return `proc-${Date.now()}-${_idCounter}`;
}

function appendToBuffer(entry: ManagedProcess, data: string): void {
  entry.outputBuffer += data;
  if (entry.outputBuffer.length > MAX_BUFFER_BYTES) {
    entry.outputBuffer = entry.outputBuffer.slice(-MAX_BUFFER_BYTES);
  }
}

function trimmedTail(text: string, bytes: number): string {
  if (text.length <= bytes) return text;
  return `[...truncated, showing last ${bytes} chars]\n` + text.slice(-bytes);
}

function normalizePathForCompare(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isWithinRoot(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizePathForCompare(candidate);
  const normalizedRoot = normalizePathForCompare(root);
  if (normalizedCandidate === normalizedRoot) return true;
  return normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

function resolveProcessCwd(args: Record<string, unknown>, context?: SkillDispatchContext): string {
  const workspaceRoot = resolveSkillExecutionCwd(context);
  const requestedCwd = String(args['cwd'] || '').trim();
  if (!requestedCwd) {
    return workspaceRoot;
  }

  const resolvedRequestedCwd = path.resolve(workspaceRoot, requestedCwd);
  if (!isWithinRoot(resolvedRequestedCwd, workspaceRoot)) {
    throw new Error('cwd must stay within workspace root.');
  }
  fs.mkdirSync(resolvedRequestedCwd, { recursive: true });
  return resolvedRequestedCwd;
}

/** Kill all managed processes. Called on server shutdown. */
export function killAllManagedProcesses(): void {
  for (const { entry, child } of processes.values()) {
    if (entry.status === 'running') {
      try {
        child.kill('SIGTERM');
      } catch {
        // best effort
      }
      entry.status = 'killed';
      entry.endedAt = Date.now();
    }
  }
  processes.clear();
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function processManagerHandler(
  args: Record<string, unknown>,
  context?: SkillDispatchContext,
): Promise<{ ok: boolean; result?: string; error?: string }> {
  const action = String(args['action'] || '');

  // ── start ────────────────────────────────────────────────────
  if (action === 'start') {
    const command = String(args['command'] || '').trim();
    if (!command) return { ok: false, error: 'action=start requires a non-empty command.' };

    const policy = evaluateNodeCommandPolicy(command);
    if (!policy.allowed) {
      return {
        ok: false,
        error: policy.reason || 'Command blocked by security policy.',
      };
    }

    const requiresApproval =
      String(process.env.OPENCLAW_EXEC_APPROVALS_REQUIRED || 'false').toLowerCase() === 'true';
    if (
      requiresApproval &&
      !context?.bypassApproval &&
      !isCommandApproved(normalizeCommand(command))
    ) {
      return {
        ok: false,
        error: [
          'Command requires approval.',
          `Fingerprint: ${commandFingerprint(command)}`,
          'Approve via CLI: npm run cli -- node approve --command "<command>"',
        ].join(' '),
      };
    }

    const label = String(args['label'] || command).slice(0, 80);
    let cwd: string;
    try {
      cwd = resolveProcessCwd(args, context);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const timeoutMs = Number(args['start_timeout_ms'] ?? DEFAULT_START_TIMEOUT_MS);

    const id = generateId();
    const entry: ManagedProcess = {
      id,
      label,
      command,
      cwd,
      pid: undefined,
      status: 'running',
      exitCode: null,
      startedAt: Date.now(),
      endedAt: null,
      outputBuffer: '',
    };

    let shell: string | boolean;
    let shellArgs: string[];
    if (process.platform === 'win32') {
      shell = 'powershell';
      shellArgs = ['-NoProfile', '-Command', command];
    } else {
      shell = '/bin/sh';
      shellArgs = ['-c', command];
    }

    const child = spawn(shell, shellArgs, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });

    entry.pid = child.pid;
    processes.set(id, { entry, child });

    child.stdout?.on('data', (chunk: Buffer) => appendToBuffer(entry, chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) =>
      appendToBuffer(entry, `[stderr] ${chunk.toString()}`),
    );
    child.on('exit', (code) => {
      entry.status = entry.status === 'killed' ? 'killed' : 'exited';
      entry.exitCode = code;
      entry.endedAt = Date.now();
    });
    child.on('error', (err) => {
      appendToBuffer(entry, `[spawn error] ${err.message}\n`);
      entry.status = 'exited';
      entry.exitCode = -1;
      entry.endedAt = Date.now();
    });

    // Wait briefly to surface immediate crashes before returning the id
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      child.on('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });

    const statusLine =
      entry.status === 'running'
        ? `Process "${label}" started (id=${id}, pid=${entry.pid}).`
        : `Process "${label}" exited immediately (exit_code=${entry.exitCode}, id=${id}).`;
    const tail = entry.outputBuffer
      ? `\nInitial output:\n${trimmedTail(entry.outputBuffer, DEFAULT_POLL_BYTES)}`
      : '';
    return { ok: true, result: statusLine + tail };
  }

  // ── list ─────────────────────────────────────────────────────
  if (action === 'list') {
    if (processes.size === 0) return { ok: true, result: 'No managed processes.' };
    const lines = [...processes.values()].map(
      ({ entry }) =>
        `id=${entry.id}  status=${entry.status}  pid=${entry.pid ?? '?'}  label="${entry.label}"`,
    );
    return { ok: true, result: lines.join('\n') };
  }

  // ── poll / log ───────────────────────────────────────────────
  if (action === 'poll' || action === 'log') {
    const id = String(args['id'] || '');
    if (!id) return { ok: false, error: 'action=poll requires id.' };
    const record = processes.get(id);
    if (!record) return { ok: false, error: `No process with id=${id}.` };
    const bytes = Number(args['bytes'] ?? DEFAULT_POLL_BYTES);
    const { entry } = record;
    const output = trimmedTail(entry.outputBuffer, bytes);
    const statusLine = `[status=${entry.status}${entry.exitCode !== null ? `, exit_code=${entry.exitCode}` : ''}]`;
    return {
      ok: true,
      result: `${statusLine}\n${output || '(no output yet)'}`,
    };
  }

  // ── write ────────────────────────────────────────────────────
  if (action === 'write') {
    const id = String(args['id'] || '');
    const text = String(args['text'] ?? '');
    if (!id) return { ok: false, error: 'action=write requires id.' };
    const record = processes.get(id);
    if (!record) return { ok: false, error: `No process with id=${id}.` };
    if (record.entry.status !== 'running') {
      return { ok: false, error: `Process ${id} is not running (status=${record.entry.status}).` };
    }
    return new Promise((resolve) => {
      record.child.stdin?.write(text, (err) => {
        if (err) {
          resolve({ ok: false, error: `stdin write error: ${err.message}` });
        } else {
          resolve({ ok: true, result: `Wrote ${text.length} chars to stdin of ${id}.` });
        }
      });
    });
  }

  // ── kill ─────────────────────────────────────────────────────
  if (action === 'kill') {
    const id = String(args['id'] || '');
    if (!id) return { ok: false, error: 'action=kill requires id.' };
    const record = processes.get(id);
    if (!record) return { ok: false, error: `No process with id=${id}.` };
    const { entry, child } = record;
    if (entry.status !== 'running') {
      return { ok: true, result: `Process ${id} already ended (status=${entry.status}).` };
    }
    const signal = String(args['signal'] || 'SIGTERM');
    try {
      child.kill(signal as NodeJS.Signals);
    } catch (err) {
      return {
        ok: false,
        error: `kill failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    entry.status = 'killed';
    entry.endedAt = Date.now();
    processes.delete(id);
    return { ok: true, result: `Sent ${signal} to process ${id} ("${entry.label}").` };
  }

  return {
    ok: false,
    error: `Unknown action "${action}". Valid actions: start, poll, log, write, kill, list.`,
  };
}
