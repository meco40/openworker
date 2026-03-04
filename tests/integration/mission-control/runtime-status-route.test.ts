import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Mission Control runtime status route', () => {
  let tempDir = '';
  let previousDatabasePath: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    previousDatabasePath = process.env.DATABASE_PATH;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-runtime-status-'));
    process.env.DATABASE_PATH = path.join(tempDir, 'mission-control.db');
  });

  afterEach(async () => {
    const { closeDb } = await import('@/lib/db');
    closeDb();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Windows sqlite handle contention in test teardown.
      }
      tempDir = '';
    }
  });

  it('exposes integrated runtime status for Mission Control UI', async () => {
    const { GET } = await import('../../../app/api/mission-control/status/route');
    const response = await GET();
    const payload = (await response.json()) as {
      connected?: boolean;
      runtime_url?: string;
      mode?: string;
      error?: string;
    };

    expect(response.status).toBe(200);
    expect(payload.connected).toBe(true);
    expect(payload.runtime_url).toContain('/ws?protocol=v2');
    expect(payload.mode).toBe('integrated');
    expect(payload.error).toBeUndefined();
  });
});
