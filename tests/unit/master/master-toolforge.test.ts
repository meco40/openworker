import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteMasterRepository } from '@/server/master/sqliteMasterRepository';
import { executeToolForgePipeline } from '@/server/master/toolforge/pipeline';

function uniqueDbPath(): string {
  return path.join(
    process.cwd(),
    '.local',
    `master.toolforge.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
  );
}

describe('master toolforge', () => {
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

  it('enforces pipeline and publishes globally only after approval', () => {
    const dbPath = uniqueDbPath();
    cleanupFiles.push(dbPath);
    const repo = new SqliteMasterRepository(dbPath);
    const scope = { userId: 'user-1', workspaceId: 'ws-1' };

    const artifact = executeToolForgePipeline(repo, scope, {
      name: 'web_summary',
      spec: '{"input":"url"}',
      approved: false,
      publishGlobally: true,
    });
    expect(artifact.status).toBe('awaiting_approval');
    expect(artifact.publishedGlobally).toBe(false);

    const published = executeToolForgePipeline(repo, scope, {
      name: 'web_summary_v2',
      spec: '{"input":"url","output":"summary"}',
      approved: true,
      publishGlobally: true,
    });
    expect(published.status).toBe('published');
    expect(published.publishedGlobally).toBe(true);

    expect(() =>
      executeToolForgePipeline(repo, scope, {
        name: 'bad',
        spec: 'not-json',
      }),
    ).toThrow(/Invalid tool spec/i);

    repo.close();
  });
});
