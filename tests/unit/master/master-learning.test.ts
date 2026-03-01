import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteMasterRepository } from '@/server/master/sqliteMasterRepository';
import { buildCapabilityInventory } from '@/server/master/capabilities/inventory';
import {
  isLearningWindow,
  recommendLearningPolicy,
  runDailyLearningLoop,
} from '@/server/master/learning';
import { getTestArtifactsRoot } from '../../helpers/testArtifacts';

function uniqueDbPath(): string {
  return path.join(
    getTestArtifactsRoot(),
    `master.learning.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
  );
}

describe('master learning', () => {
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

  it('runs one cycle at 03:00 and returns policy recommendation', async () => {
    const dbPath = uniqueDbPath();
    cleanupFiles.push(dbPath);
    const repo = new SqliteMasterRepository(dbPath);
    const scope = { userId: 'user-1', workspaceId: 'ws-1' };
    buildCapabilityInventory(repo, scope);

    expect(isLearningWindow(new Date('2026-02-27T03:00:00.000Z'))).toBe(true);
    expect(isLearningWindow(new Date('2026-02-27T02:59:00.000Z'))).toBe(false);

    const cycle = await runDailyLearningLoop(repo, scope, new Date('2026-02-27T03:00:00.000Z'));
    expect(cycle.executed).toBe(true);
    expect(cycle.updated).toBeGreaterThan(0);

    expect(recommendLearningPolicy({ failureRate: 0.3, verifyPassRate: 0.7 })).toBe('safe');
    expect(recommendLearningPolicy({ failureRate: 0.05, verifyPassRate: 0.95 })).toBe('fast');
    expect(recommendLearningPolicy({ failureRate: 0.1, verifyPassRate: 0.8 })).toBe('balanced');

    repo.close();
  });
});
