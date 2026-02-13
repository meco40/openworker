import { execFile as execFileCallback } from 'node:child_process';
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

    try {
      const first = await this.exec(this.binary, commonArgs, {
        cwd: this.workdir,
        timeout: this.timeoutMs,
        maxBuffer: 1024 * 1024,
      });
      return {
        stdout: first.stdout,
        stderr: first.stderr,
        exitCode: 0,
        command: this.binary,
        argv: commonArgs,
      };
    } catch (error) {
      if (!isMissingBinary(error) || this.binary === 'npx') {
        throw error;
      }
    }

    const fallbackArgs = ['-y', 'clawhub', ...commonArgs];
    const fallback = await this.exec('npx', fallbackArgs, {
      cwd: this.workdir,
      timeout: this.timeoutMs,
      maxBuffer: 1024 * 1024,
    });

    return {
      stdout: fallback.stdout,
      stderr: fallback.stderr,
      exitCode: 0,
      command: 'npx',
      argv: fallbackArgs,
    };
  }
}
