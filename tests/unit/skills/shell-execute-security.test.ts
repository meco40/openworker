import { describe, expect, it } from 'vitest';
import { shellExecuteHandler } from '../../../src/server/skills/handlers/shellExecute';

describe('shellExecuteHandler security', () => {
  it('blocks encoded powershell payloads', async () => {
    await expect(shellExecuteHandler({ command: 'powershell -enc SQBFAFgA' })).rejects.toThrow(
      'Command blocked by security policy.',
    );
  });

  it('blocks registry delete commands', async () => {
    await expect(
      shellExecuteHandler({ command: 'reg delete HKCU\\Software\\Test /f' }),
    ).rejects.toThrow('Command blocked by security policy.');
  });

  it('blocks service stop commands', async () => {
    await expect(shellExecuteHandler({ command: 'sc stop WinDefend' })).rejects.toThrow(
      'Command blocked by security policy.',
    );
  });
});
