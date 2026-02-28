import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteMasterRepository } from '@/server/master/sqliteMasterRepository';
import { buildCapabilityInventory } from '@/server/master/capabilities/inventory';
import { runCapabilityUnderstandingCycle } from '@/server/master/capabilities/understandingLoop';

function uniqueDbPath(): string {
  return path.join(
    process.cwd(),
    '.local',
    `master.capability.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
  );
}

describe('master capability inventory', () => {
  const cleanupFiles: string[] = [];

  afterEach(() => {
    for (const filePath of cleanupFiles.splice(0, cleanupFiles.length)) {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch {
        // ignore sqlite lock on windows
      }
    }
  });

  it('builds inventory and updates confidence during 03:00 cycle', async () => {
    const dbPath = uniqueDbPath();
    cleanupFiles.push(dbPath);
    const repo = new SqliteMasterRepository(dbPath);
    const scope = { userId: 'user-1', workspaceId: 'ws-1' };

    const inventory = buildCapabilityInventory(repo, scope);
    expect(inventory.length).toBeGreaterThan(3);

    const before = repo.listCapabilityScores(scope).map((entry) => entry.confidence);
    const cycle = await runCapabilityUnderstandingCycle(
      repo,
      scope,
      new Date('2026-02-27T03:00:00.000Z'),
    );
    expect(cycle.executed).toBe(true);
    expect(cycle.updated).toBeGreaterThan(0);

    const after = repo.listCapabilityScores(scope).map((entry) => entry.confidence);
    expect(after.some((value, index) => value >= before[index])).toBe(true);

    repo.close();
  });
});
