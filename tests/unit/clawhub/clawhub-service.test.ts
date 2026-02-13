import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ClawHubRepository } from '../../../src/server/clawhub/clawhubRepository';
import { ClawHubService } from '../../../src/server/clawhub/clawhubService';
import type { ClawHubCliLike } from '../../../src/server/clawhub/types';

function uniqueDir(name: string): string {
  return path.join(
    process.cwd(),
    '.local',
    `${name}.${Date.now()}.${Math.random().toString(36).slice(2)}`,
  );
}

describe('ClawHubService', () => {
  const createdDirs: string[] = [];

  afterEach(() => {
    for (const dir of createdDirs.splice(0, createdDirs.length)) {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('syncs installed skills from lockfile into repository', async () => {
    const rootDir = uniqueDir('clawhub.service.sync');
    createdDirs.push(rootDir);

    fs.mkdirSync(path.join(rootDir, '.clawhub'), { recursive: true });
    fs.mkdirSync(path.join(rootDir, 'skills', 'calendar'), { recursive: true });

    fs.writeFileSync(
      path.join(rootDir, '.clawhub', 'lock.json'),
      JSON.stringify(
        {
          version: 1,
          skills: {
            calendar: {
              version: '1.0.0',
              installedAt: 1770985579241,
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    fs.writeFileSync(
      path.join(rootDir, 'skills', 'calendar', '_meta.json'),
      JSON.stringify(
        {
          slug: 'calendar',
          version: '1.0.0',
          title: 'Calendar',
        },
        null,
        2,
      ),
      'utf8',
    );

    const cli: ClawHubCliLike = {
      run: async () => ({ stdout: '', stderr: '', exitCode: 0, command: 'noop', argv: [] }),
    };
    const repo = new ClawHubRepository(':memory:');
    const service = new ClawHubService({ cli, repository: repo, workspaceDir: rootDir });

    const synced = await service.syncInstalledFromLockfile();

    expect(synced).toHaveLength(1);
    expect(synced[0]).toMatchObject({
      slug: 'calendar',
      version: '1.0.0',
      title: 'Calendar',
      status: 'installed',
    });
  });
});
