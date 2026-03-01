import fs from 'node:fs';
import path from 'node:path';
import { getTestArtifactsRoot } from '../../helpers/testArtifacts';

import { afterEach, describe, expect, it } from 'vitest';

import { ClawHubRepository } from '@/server/clawhub/clawhubRepository';
import { ClawHubService } from '@/server/clawhub/clawhubService';
import type { ClawHubCliLike } from '@/server/clawhub/types';

function uniqueDir(name: string): string {
  return path.join(
    getTestArtifactsRoot(),
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

  it('uninstalls skill by removing lock entry and local folder', async () => {
    const rootDir = uniqueDir('clawhub.service.uninstall');
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
    fs.writeFileSync(path.join(rootDir, 'skills', 'calendar', '_meta.json'), '{}', 'utf8');

    const cli: ClawHubCliLike = {
      run: async () => ({ stdout: '', stderr: '', exitCode: 0, command: 'noop', argv: [] }),
    };
    const repo = new ClawHubRepository(':memory:');
    const service = new ClawHubService({ cli, repository: repo, workspaceDir: rootDir });

    await service.syncInstalledFromLockfile();
    const uninstalled = await service.uninstall('calendar');

    expect(uninstalled.skills).toEqual([]);
    expect(uninstalled.warnings).toEqual([]);
    expect(fs.existsSync(path.join(rootDir, 'skills', 'calendar'))).toBe(false);
    const lock = JSON.parse(
      fs.readFileSync(path.join(rootDir, '.clawhub', 'lock.json'), 'utf8'),
    ) as {
      skills?: Record<string, unknown>;
    };
    expect(lock.skills ?? {}).not.toHaveProperty('calendar');
  });

  it('rejects install when slug is invalid', async () => {
    const rootDir = uniqueDir('clawhub.service.invalid-install');
    createdDirs.push(rootDir);

    const calls: Array<{ command: string; args: string[] }> = [];
    const cli: ClawHubCliLike = {
      run: async (command, args) => {
        calls.push({ command, args });
        return { stdout: '', stderr: '', exitCode: 0, command: 'noop', argv: [] };
      },
    };

    const repo = new ClawHubRepository(':memory:');
    const service = new ClawHubService({ cli, repository: repo, workspaceDir: rootDir });

    await expect(service.install({ slug: '../calendar' })).rejects.toThrow(
      'Invalid ClawHub skill slug',
    );
    expect(calls).toEqual([]);
  });

  it('rejects update when slug is invalid', async () => {
    const rootDir = uniqueDir('clawhub.service.invalid-update');
    createdDirs.push(rootDir);

    const calls: Array<{ command: string; args: string[] }> = [];
    const cli: ClawHubCliLike = {
      run: async (command, args) => {
        calls.push({ command, args });
        return { stdout: '', stderr: '', exitCode: 0, command: 'noop', argv: [] };
      },
    };

    const repo = new ClawHubRepository(':memory:');
    const service = new ClawHubService({ cli, repository: repo, workspaceDir: rootDir });

    await expect(service.update({ slug: 'calendar/../../bad' })).rejects.toThrow(
      'Invalid ClawHub skill slug',
    );
    expect(calls).toEqual([]);
  });

  it('does not delete repository state when lockfile is unreadable', async () => {
    const rootDir = uniqueDir('clawhub.service.unreadable-lock');
    createdDirs.push(rootDir);

    fs.mkdirSync(path.join(rootDir, '.clawhub'), { recursive: true });
    fs.writeFileSync(path.join(rootDir, '.clawhub', 'lock.json'), '{"skills":', 'utf8');

    const cli: ClawHubCliLike = {
      run: async () => ({ stdout: '', stderr: '', exitCode: 0, command: 'noop', argv: [] }),
    };
    const repo = new ClawHubRepository(':memory:');
    repo.upsertSkill({
      slug: 'calendar',
      version: '1.0.0',
      title: 'Calendar',
      status: 'installed',
      localPath: 'skills/calendar',
      enabled: true,
    });

    const service = new ClawHubService({ cli, repository: repo, workspaceDir: rootDir });
    const synced = await service.syncInstalledFromLockfile();

    expect(synced).toHaveLength(1);
    expect(synced[0].slug).toBe('calendar');
  });

  it('does not delete repository state when lockfile contains only invalid slugs', async () => {
    const rootDir = uniqueDir('clawhub.service.invalid-slugs-lock');
    createdDirs.push(rootDir);

    fs.mkdirSync(path.join(rootDir, '.clawhub'), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, '.clawhub', 'lock.json'),
      JSON.stringify(
        {
          version: 1,
          skills: {
            '../calendar': { version: '1.0.0' },
          },
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
    repo.upsertSkill({
      slug: 'calendar',
      version: '1.0.0',
      title: 'Calendar',
      status: 'installed',
      localPath: 'skills/calendar',
      enabled: true,
    });

    const service = new ClawHubService({ cli, repository: repo, workspaceDir: rootDir });
    const synced = await service.syncInstalledFromLockfile();

    expect(synced).toHaveLength(1);
    expect(synced[0].slug).toBe('calendar');
  });

  it('clears repository state when lockfile explicitly contains empty skills object', async () => {
    const rootDir = uniqueDir('clawhub.service.empty-lock');
    createdDirs.push(rootDir);

    fs.mkdirSync(path.join(rootDir, '.clawhub'), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, '.clawhub', 'lock.json'),
      JSON.stringify(
        {
          version: 1,
          skills: {},
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
    repo.upsertSkill({
      slug: 'calendar',
      version: '1.0.0',
      title: 'Calendar',
      status: 'installed',
      localPath: 'skills/calendar',
      enabled: true,
    });

    const service = new ClawHubService({ cli, repository: repo, workspaceDir: rootDir });
    const synced = await service.syncInstalledFromLockfile();

    expect(synced).toEqual([]);
  });
});
