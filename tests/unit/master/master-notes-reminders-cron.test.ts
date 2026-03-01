import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteMasterRepository } from '@/server/master/sqliteMasterRepository';
import { MasterNotesService } from '@/server/master/notes';
import { MasterRemindersService } from '@/server/master/reminders';
import { MasterCronBridge } from '@/server/master/cronBridge';
import { getTestArtifactsRoot } from '../../helpers/testArtifacts';

function uniqueDbPath(): string {
  return path.join(
    getTestArtifactsRoot(),
    `master.notes.reminders.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
  );
}

describe('master notes/reminders/cron', () => {
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

  it('supports note CRUD baseline, reminder scheduling, and cron projection', () => {
    const dbPath = uniqueDbPath();
    cleanupFiles.push(dbPath);
    const repo = new SqliteMasterRepository(dbPath);
    const notes = new MasterNotesService(repo);
    const reminders = new MasterRemindersService(repo);
    const cronBridge = new MasterCronBridge(repo);
    const scope = { userId: 'user-1', workspaceId: 'ws-1' };

    notes.create(scope, { title: 'n1', content: 'content', tags: ['tag'] });
    expect(notes.list(scope)).toHaveLength(1);

    reminders.create(scope, {
      title: 'r1',
      message: 'remember',
      remindAt: new Date().toISOString(),
      cronExpression: '0 3 * * *',
    });
    const allReminders = reminders.list(scope);
    expect(allReminders).toHaveLength(1);
    expect(cronBridge.list(scope)).toHaveLength(1);

    repo.close();
  });
});
