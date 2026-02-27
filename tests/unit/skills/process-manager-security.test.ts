import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  killAllManagedProcesses,
  processManagerHandler,
} from '@/server/skills/handlers/processManager';

describe('processManagerHandler security', () => {
  afterEach(() => {
    killAllManagedProcesses();
  });

  it('blocks encoded powershell payloads for action=start', async () => {
    const result = (await processManagerHandler({
      action: 'start',
      command: 'powershell -enc SQBFAFgA',
    })) as { ok: boolean; error?: string };

    expect(result.ok).toBe(false);
    expect(String(result.error || '')).toContain('Command blocked by security policy.');
  });

  it('requires approval when exec approvals are enabled', async () => {
    const previous = process.env.OPENCLAW_EXEC_APPROVALS_REQUIRED;
    process.env.OPENCLAW_EXEC_APPROVALS_REQUIRED = 'true';
    const marker = `process-approval-${Date.now()}`;
    try {
      const result = (await processManagerHandler({
        action: 'start',
        command: `echo ${marker}`,
      })) as { ok: boolean; error?: string };

      expect(result.ok).toBe(false);
      expect(String(result.error || '')).toContain('Command requires approval.');
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_EXEC_APPROVALS_REQUIRED;
      } else {
        process.env.OPENCLAW_EXEC_APPROVALS_REQUIRED = previous;
      }
    }
  });

  it('runs in provided workspace cwd and blocks cwd escape attempts', async () => {
    const personasRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'personas-root-'));
    process.env.PERSONAS_ROOT_PATH = personasRoot;
    const workspaceDir = path.join(personasRoot, 'tester', 'projects', 'sample-task');
    fs.mkdirSync(workspaceDir, { recursive: true });
    const command = process.platform === 'win32' ? '(Get-Location).Path' : 'pwd';

    try {
      const startResult = (await processManagerHandler(
        { action: 'start', command },
        { workspaceCwd: workspaceDir },
      )) as { ok: boolean; result?: string };

      expect(startResult.ok).toBe(true);
      expect(String(startResult.result || '').toLowerCase()).toContain(workspaceDir.toLowerCase());

      const escapeResult = (await processManagerHandler(
        { action: 'start', command: 'echo hi', cwd: '..' },
        { workspaceCwd: workspaceDir },
      )) as { ok: boolean; error?: string };
      expect(escapeResult.ok).toBe(false);
      expect(String(escapeResult.error || '')).toContain('cwd must stay within workspace root.');
    } finally {
      delete process.env.PERSONAS_ROOT_PATH;
      fs.rmSync(personasRoot, { recursive: true, force: true });
    }
  });
});
