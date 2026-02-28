import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteMasterRepository } from '@/server/master/sqliteMasterRepository';
import { buildCapabilityInventory } from '@/server/master/capabilities/inventory';
import { runMasterMaintenanceTick } from '@/server/master/runtime';

function uniqueDbPath(): string {
  return path.join(
    process.cwd(),
    '.local',
    `master.maintenance.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
  );
}

describe('master maintenance loop', () => {
  const cleanupFiles: string[] = [];

  afterEach(() => {
    for (const filePath of cleanupFiles.splice(0, cleanupFiles.length)) {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch {
        // ignore sqlite locks
      }
    }
  });

  it('runs learning at 03:00 only once per day per scope', async () => {
    const dbPath = uniqueDbPath();
    cleanupFiles.push(dbPath);
    const repo = new SqliteMasterRepository(dbPath);
    const scope = { userId: 'user-maint', workspaceId: 'ws-maint' };
    buildCapabilityInventory(repo, scope);

    const firstTick = await runMasterMaintenanceTick(repo, new Date('2026-02-27T03:00:00.000Z'));
    expect(firstTick.executedScopes).toBeGreaterThan(0);

    const secondTickSameMinute = await runMasterMaintenanceTick(
      repo,
      new Date('2026-02-27T03:00:30.000Z'),
    );
    expect(secondTickSameMinute.executedScopes).toBe(0);

    const nextDayTick = await runMasterMaintenanceTick(repo, new Date('2026-02-28T03:00:00.000Z'));
    expect(nextDayTick.executedScopes).toBeGreaterThan(0);

    repo.close();
  });
});
