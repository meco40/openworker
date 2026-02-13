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
});
