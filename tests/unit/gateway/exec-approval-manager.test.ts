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
} from '@/server/gateway/exec-approval-manager';

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

describe('loadStore — error handling branches', () => {
  it('returns empty approvals when store file does not exist', () => {
    const storePath = makeStorePath();
    createdDirs.push(path.dirname(storePath));
    // File never written — loadStore should return empty
    expect(listApprovedCommands({ storePath })).toEqual([]);
  });

  it('returns empty approvals when store contains invalid JSON', () => {
    const storePath = makeStorePath();
    createdDirs.push(path.dirname(storePath));
    fs.writeFileSync(storePath, 'not valid json', 'utf-8');
    expect(listApprovedCommands({ storePath })).toEqual([]);
  });

  it('returns empty approvals when store has wrong version', () => {
    const storePath = makeStorePath();
    createdDirs.push(path.dirname(storePath));
    fs.writeFileSync(storePath, JSON.stringify({ version: 99, approvals: [] }), 'utf-8');
    expect(listApprovedCommands({ storePath })).toEqual([]);
  });

  it('returns empty approvals when approvals field is not an array', () => {
    const storePath = makeStorePath();
    createdDirs.push(path.dirname(storePath));
    fs.writeFileSync(storePath, JSON.stringify({ version: 1, approvals: null }), 'utf-8');
    expect(listApprovedCommands({ storePath })).toEqual([]);
  });

  it('filters out malformed records missing required fields', () => {
    const storePath = makeStorePath();
    createdDirs.push(path.dirname(storePath));
    const store = {
      version: 1,
      approvals: [
        { fingerprint: 'fp1', command: 'echo good', updatedAt: new Date().toISOString() },
        { fingerprint: 'fp2' /* missing command and updatedAt */ },
        { command: 'no-fp', updatedAt: new Date().toISOString() /* missing fingerprint */ },
      ],
    };
    fs.writeFileSync(storePath, JSON.stringify(store), 'utf-8');
    const results = listApprovedCommands({ storePath });
    expect(results).toHaveLength(1);
    expect(results[0].command).toBe('echo good');
  });
});

describe('approveCommand — update vs insert', () => {
  it('updates existing record when same command is approved again', () => {
    const storePath = makeStorePath();
    createdDirs.push(path.dirname(storePath));

    approveCommand('echo hello', { storePath });
    const first = listApprovedCommands({ storePath });
    expect(first).toHaveLength(1);
    const firstUpdatedAt = first[0].updatedAt;

    // Wait a tick to ensure different timestamp possible
    approveCommand('echo hello', { storePath });
    const second = listApprovedCommands({ storePath });
    // Should still be 1 entry (update, not duplicate insert)
    expect(second).toHaveLength(1);
    expect(second[0].updatedAt).toBeDefined();
    // The command fingerprint is the same
    expect(second[0].fingerprint).toBe(first[0].fingerprint);
  });

  it('inserts new record when a different command is approved', () => {
    const storePath = makeStorePath();
    createdDirs.push(path.dirname(storePath));

    approveCommand('echo hello', { storePath });
    approveCommand('echo world', { storePath });
    expect(listApprovedCommands({ storePath })).toHaveLength(2);
  });
});

describe('revokeCommand — not found branch', () => {
  it('returns false when fingerprint is not in the store', () => {
    const storePath = makeStorePath();
    createdDirs.push(path.dirname(storePath));

    approveCommand('echo hello', { storePath });
    const result = revokeCommand('echo unrelated', { storePath });
    expect(result).toBe(false);
    // Original approval still intact
    expect(listApprovedCommands({ storePath })).toHaveLength(1);
  });

  it('returns false on empty store', () => {
    const storePath = makeStorePath();
    createdDirs.push(path.dirname(storePath));
    expect(revokeCommand('echo nothing', { storePath })).toBe(false);
  });
});
