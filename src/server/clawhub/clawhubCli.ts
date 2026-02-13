import { execFile as execFileCallback } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import type { ClawHubCliResult } from './types';

const execFile = promisify(execFileCallback);

type ExecFn = (
  file: string,
  args: string[],
  options: { cwd: string; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

function isMissingBinary(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const typed = error as { code?: string; message?: string };
  return typed.code === 'ENOENT' || String(typed.message || '').includes('ENOENT');
}

function isWindowsCmdLauncher(command: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
}

function isInvalidSpawnForWindowsCmdLauncher(error: unknown, command: string): boolean {
  if (!isWindowsCmdLauncher(command) || !error || typeof error !== 'object') {
    return false;
  }
  const typed = error as { code?: string; message?: string };
  return typed.code === 'EINVAL' || String(typed.message || '').includes('spawn EINVAL');
}

export interface ClawHubCliOptions {
  workdir?: string;
  timeoutMs?: number;
  exec?: ExecFn;
  binary?: string;
}

export class ClawHubCli {
  private readonly workdir: string;
  private readonly timeoutMs: number;
  private readonly exec: ExecFn;
  private readonly binary: string;

  constructor(options: ClawHubCliOptions = {}) {
    this.workdir = options.workdir || process.cwd();
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.exec = options.exec ?? execFile;
    this.binary = options.binary || process.env.CLAWHUB_BIN || 'clawhub';
  }

  async run(command: string, args: string[]): Promise<ClawHubCliResult> {
    const commonArgs = ['--workdir', this.workdir, '--no-input', command, ...args];
    const candidates: Array<{ command: string; argv: string[] }> = [
      { command: this.binary, argv: commonArgs },
    ];

    if (this.binary !== 'npx') {
      candidates.push({
        command: 'npx',
        argv: ['-y', 'clawhub', ...commonArgs],
      });
    }

    if (this.binary !== 'npm') {
      candidates.push({
        command: 'npm',
        argv: ['exec', '--yes', 'clawhub', '--', ...commonArgs],
      });
    }

    if (this.binary !== 'pnpm') {
      candidates.push({
        command: 'pnpm',
        argv: ['dlx', 'clawhub', ...commonArgs],
      });
    }

    const exeDir = path.dirname(process.execPath);
    const extension = process.platform === 'win32' ? '.cmd' : '';
    const nodeDirLaunchers: Array<{ command: string; argv: string[] }> = [
      {
        command: path.join(exeDir, `npx${extension}`),
        argv: ['-y', 'clawhub', ...commonArgs],
      },
      {
        command: path.join(exeDir, `npm${extension}`),
        argv: ['exec', '--yes', 'clawhub', '--', ...commonArgs],
      },
      {
        command: path.join(exeDir, `pnpm${extension}`),
        argv: ['dlx', 'clawhub', ...commonArgs],
      },
    ];

    for (const launcher of nodeDirLaunchers) {
      if (!candidates.some((candidate) => candidate.command === launcher.command)) {
        candidates.push(launcher);
      }
    }

    let lastError: unknown = null;

    for (const candidate of candidates) {
      try {
        const result = await this.exec(candidate.command, candidate.argv, {
          cwd: this.workdir,
          timeout: this.timeoutMs,
          maxBuffer: 1024 * 1024,
        });
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: 0,
          command: candidate.command,
          argv: candidate.argv,
        };
      } catch (error) {
        lastError = error;

        if (isInvalidSpawnForWindowsCmdLauncher(error, candidate.command)) {
          try {
            const command = process.env.ComSpec || 'cmd.exe';
            const result = await this.exec(
              command,
              ['/d', '/c', candidate.command, ...candidate.argv],
              {
                cwd: this.workdir,
                timeout: this.timeoutMs,
                maxBuffer: 1024 * 1024,
              },
            );
            return {
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: 0,
              command,
              argv: ['/d', '/c', candidate.command, ...candidate.argv],
            };
          } catch (wrapperError) {
            lastError = wrapperError;
            if (!isMissingBinary(wrapperError)) {
              throw wrapperError;
            }
            continue;
          }
        }

        if (!isMissingBinary(error)) {
          throw error;
        }
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('No supported ClawHub launcher found.');
  }
}
