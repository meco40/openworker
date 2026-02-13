import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ClawHubCli } from '../../../src/server/clawhub/clawhubCli';

describe('ClawHubCli', () => {
  it('falls back to npx when clawhub binary is missing', async () => {
    const calls: Array<{ file: string; args: string[] }> = [];

    const cli = new ClawHubCli({
      workdir: 'D:/workspace',
      exec: async (file, args) => {
        calls.push({ file, args });
        if (file === 'clawhub') {
          const error = new Error('spawn clawhub ENOENT') as Error & { code?: string };
          error.code = 'ENOENT';
          throw error;
        }
        return { stdout: 'ok', stderr: '' };
      },
    });

    const result = await cli.run('list', []);

    expect(result.stdout).toBe('ok');
    expect(calls).toHaveLength(2);
    expect(calls[0].file).toBe('clawhub');
    expect(calls[1].file).toBe('npx');
    expect(calls[1].args.slice(0, 2)).toEqual(['-y', 'clawhub']);
  });

  it('falls back to npm exec when npx is missing', async () => {
    const calls: Array<{ file: string; args: string[] }> = [];

    const cli = new ClawHubCli({
      workdir: 'D:/workspace',
      exec: async (file, args) => {
        calls.push({ file, args });
        if (file === 'clawhub' || file === 'npx') {
          const error = new Error(`spawn ${file} ENOENT`) as Error & { code?: string };
          error.code = 'ENOENT';
          throw error;
        }
        if (file === 'npm') {
          return { stdout: 'ok-npm', stderr: '' };
        }
        throw new Error(`unexpected executable: ${file}`);
      },
    });

    const result = await cli.run('list', []);

    expect(result.stdout).toBe('ok-npm');
    expect(calls).toHaveLength(3);
    expect(calls[0].file).toBe('clawhub');
    expect(calls[1].file).toBe('npx');
    expect(calls[2].file).toBe('npm');
    expect(calls[2].args.slice(0, 4)).toEqual(['exec', '--yes', 'clawhub', '--']);
  });

  it('falls back to node install dir binaries when PATH launchers are missing', async () => {
    const calls: Array<{ file: string; args: string[] }> = [];

    const cli = new ClawHubCli({
      workdir: 'D:/workspace',
      exec: async (file, args) => {
        calls.push({ file, args });
        const base = path.basename(file).toLowerCase();
        const isAbsolute = file.includes('\\') || file.includes('/');
        if (isAbsolute && base.startsWith('npm')) {
          return { stdout: 'ok-absolute-npm', stderr: '' };
        }

        const error = new Error(`spawn ${file} ENOENT`) as Error & { code?: string };
        error.code = 'ENOENT';
        throw error;
      },
    });

    const result = await cli.run('search', ['--limit', '5', 'codex']);

    expect(result.stdout).toBe('ok-absolute-npm');
    expect(
      calls.some((call) => {
        const base = path.basename(call.file).toLowerCase();
        const isAbsolute = call.file.includes('\\') || call.file.includes('/');
        return isAbsolute && base.startsWith('npm');
      }),
    ).toBe(true);
  });

  it('uses cmd.exe wrapper when absolute npm.cmd launcher fails with EINVAL on Windows', async () => {
    if (process.platform !== 'win32') {
      return;
    }

    const calls: Array<{ file: string; args: string[] }> = [];
    const comspec = process.env.ComSpec || 'cmd.exe';
    const npmCmd = path.join(path.dirname(process.execPath), 'npm.cmd');

    const cli = new ClawHubCli({
      workdir: 'D:/workspace',
      exec: async (file, args) => {
        calls.push({ file, args });
        const base = path.basename(file).toLowerCase();
        const isAbsolute = file.includes('\\') || file.includes('/');

        if (!isAbsolute && (file === 'clawhub' || file === 'npx' || file === 'npm' || file === 'pnpm')) {
          const error = new Error(`spawn ${file} ENOENT`) as Error & { code?: string };
          error.code = 'ENOENT';
          throw error;
        }

        if (isAbsolute && (base === 'npx.cmd' || base === 'pnpm.cmd')) {
          const error = new Error(`spawn ${file} ENOENT`) as Error & { code?: string };
          error.code = 'ENOENT';
          throw error;
        }

        if (isAbsolute && base === 'npm.cmd') {
          const error = new Error(`spawn ${file} EINVAL`) as Error & { code?: string };
          error.code = 'EINVAL';
          throw error;
        }

        if (file.toLowerCase() === comspec.toLowerCase()) {
          return { stdout: 'ok-cmd-wrapper', stderr: '' };
        }

        throw new Error(`unexpected executable: ${file}`);
      },
    });

    const result = await cli.run('search', ['--limit', '5', 'codex']);

    expect(result.stdout).toBe('ok-cmd-wrapper');
    expect(result.command.toLowerCase()).toBe(comspec.toLowerCase());
    expect(result.argv[0]).toBe('/d');
    expect(result.argv[1]).toBe('/c');
    expect(result.argv[2]).toBe(npmCmd);
  });
});
