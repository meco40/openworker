import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  approveCommand,
  clearApprovedCommands,
  isCommandApproved,
  listApprovedCommands,
  revokeCommand,
} from '../../../src/server/gateway/exec-approval-manager';

function makeStorePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-approvals-'));
  return path.join(dir, 'exec-approvals.json');
}

const createdDirs: string[] = [];

afterEach(() => {
  for (const dir of createdDirs.splice(0, createdDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('exec approval manager', () => {
  it('approves, lists and revokes commands', () => {
    const storePath = makeStorePath();
    createdDirs.push(path.dirname(storePath));

    approveCommand('echo hello', { storePath });
    expect(isCommandApproved('echo hello', { storePath })).toBe(true);
    expect(listApprovedCommands({ storePath })).toHaveLength(1);

    expect(revokeCommand('echo hello', { storePath })).toBe(true);
    expect(isCommandApproved('echo hello', { storePath })).toBe(false);
  });

  it('clears the approval store', () => {
    const storePath = makeStorePath();
    createdDirs.push(path.dirname(storePath));

    approveCommand('echo one', { storePath });
    approveCommand('echo two', { storePath });
    expect(listApprovedCommands({ storePath })).toHaveLength(2);

    clearApprovedCommands({ storePath });
    expect(listApprovedCommands({ storePath })).toHaveLength(0);
  });
});

