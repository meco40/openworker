import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { shellExecuteHandler } from '@/server/skills/handlers/shellExecute';

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

  it('requires approval when exec approvals are enabled', async () => {
    const previous = process.env.OPENCLAW_EXEC_APPROVALS_REQUIRED;
    process.env.OPENCLAW_EXEC_APPROVALS_REQUIRED = 'true';
    const marker = `approval-test-${Date.now()}`;
    try {
      await expect(shellExecuteHandler({ command: `echo ${marker}` })).rejects.toThrow(
        'Command requires approval.',
      );
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_EXEC_APPROVALS_REQUIRED;
      } else {
        process.env.OPENCLAW_EXEC_APPROVALS_REQUIRED = previous;
      }
    }
  });

  it('accepts bypassApproval for already granted interactive approvals', async () => {
    const previous = process.env.OPENCLAW_EXEC_APPROVALS_REQUIRED;
    process.env.OPENCLAW_EXEC_APPROVALS_REQUIRED = 'true';
    const marker = `approval-bypass-${Date.now()}`;
    try {
      const result = (await shellExecuteHandler(
        { command: `echo ${marker}` },
        { bypassApproval: true },
      )) as { stdout?: string; exitCode?: number };
      expect(result.exitCode).toBe(0);
      expect(String(result.stdout || '')).toContain(marker);
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_EXEC_APPROVALS_REQUIRED;
      } else {
        process.env.OPENCLAW_EXEC_APPROVALS_REQUIRED = previous;
      }
    }
  });

  it('runs in provided workspace cwd when present in dispatch context', async () => {
    const personasRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'personas-root-'));
    process.env.PERSONAS_ROOT_PATH = personasRoot;
    const workspaceDir = path.join(personasRoot, 'tester', 'projects', 'sample-task');
    fs.mkdirSync(workspaceDir, { recursive: true });
    const command = process.platform === 'win32' ? '(Get-Location).Path' : 'pwd';

    try {
      const result = (await shellExecuteHandler({ command }, { workspaceCwd: workspaceDir })) as {
        stdout?: string;
        exitCode?: number;
      };

      expect(result.exitCode).toBe(0);
      expect(String(result.stdout || '').toLowerCase()).toContain(workspaceDir.toLowerCase());
    } finally {
      delete process.env.PERSONAS_ROOT_PATH;
      fs.rmSync(personasRoot, { recursive: true, force: true });
    }
  });
});
