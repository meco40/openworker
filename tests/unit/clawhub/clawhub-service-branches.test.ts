import fs from 'node:fs';
import path from 'node:path';
import { getTestArtifactsRoot } from '../../helpers/testArtifacts';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClawHubRepository } from '@/server/clawhub/clawhubRepository';
import { ClawHubService, getClawHubService } from '@/server/clawhub/clawhubService';
import { ClawHubInputError, ClawHubNotFoundError } from '@/server/clawhub/errors';
import type { ClawHubCliLike } from '@/server/clawhub/types';

function uniqueDir(name: string): string {
  return path.join(
    getTestArtifactsRoot(),
    `${name}.${Date.now()}.${Math.random().toString(36).slice(2)}`,
  );
}

function makeCli(overrides: Partial<ClawHubCliLike> = {}): ClawHubCliLike {
  return {
    run: async () => ({ stdout: '', stderr: '', exitCode: 0, command: 'noop', argv: [] }),
    ...overrides,
  };
}

describe('ClawHubService branch coverage', () => {
  const createdDirs: string[] = [];

  afterEach(() => {
    for (const dir of createdDirs.splice(0, createdDirs.length)) {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    vi.restoreAllMocks();
  });

  describe('search', () => {
    it('clamps limit to [1,200] and trims query', async () => {
      const calls: Array<{ command: string; args: string[] }> = [];
      const cli = makeCli({
        run: async (command, args) => {
          calls.push({ command, args });
          return { stdout: '{"items":[]}', stderr: '', exitCode: 0, command: 'noop', argv: [] };
        },
      });
      const service = new ClawHubService({ cli, repository: new ClawHubRepository(':memory:') });

      await service.search('  hello  ', 999);

      expect(calls[0].command).toBe('search');
      expect(calls[0].args).toEqual(['--limit', '200', 'hello']);
    });

    it('uses default limit 25 for non-numeric', async () => {
      const calls: Array<{ command: string; args: string[] }> = [];
      const cli = makeCli({
        run: async (command, args) => {
          calls.push({ command, args });
          return { stdout: '', stderr: '', exitCode: 0, command: 'noop', argv: [] };
        },
      });
      const service = new ClawHubService({ cli, repository: new ClawHubRepository(':memory:') });

      await service.search('hello', Number.NaN);

      expect(calls[0].args).toEqual(['--limit', '25', 'hello']);
    });
  });

  describe('explore', () => {
    it('parses valid JSON output', async () => {
      const cli = makeCli({
        run: async () => ({
          stdout: JSON.stringify([{ slug: 'calendar', title: 'Calendar' }]),
          stderr: '',
          exitCode: 0,
          command: 'noop',
          argv: [],
        }),
      });
      const service = new ClawHubService({ cli, repository: new ClawHubRepository(':memory:') });

      const result = await service.explore(10, 'oldest');

      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({ slug: 'calendar' });
    });

    it('returns empty items for invalid JSON', async () => {
      const cli = makeCli({
        run: async () => ({
          stdout: 'not-json',
          stderr: '',
          exitCode: 0,
          command: 'noop',
          argv: [],
        }),
      });
      const service = new ClawHubService({ cli, repository: new ClawHubRepository(':memory:') });

      const result = await service.explore();

      expect(result.items).toEqual([]);
    });

    it('clamps limit and defaults sort', async () => {
      const calls: Array<{ command: string; args: string[] }> = [];
      const cli = makeCli({
        run: async (command, args) => {
          calls.push({ command, args });
          return { stdout: '', stderr: '', exitCode: 0, command: 'noop', argv: [] };
        },
      });
      const service = new ClawHubService({ cli, repository: new ClawHubRepository(':memory:') });

      await service.explore(0, '  ');

      expect(calls[0].args).toEqual(['--json', '--limit', '1', '--sort', 'newest']);
    });
  });

  describe('install', () => {
    it('installs with force and version', async () => {
      const rootDir = uniqueDir('clawhub.service.install');
      createdDirs.push(rootDir);
      fs.mkdirSync(path.join(rootDir, '.clawhub'), { recursive: true });
      fs.writeFileSync(
        path.join(rootDir, '.clawhub', 'lock.json'),
        JSON.stringify({ version: 1, skills: { calendar: { version: '1.0.0' } } }),
        'utf8',
      );
      fs.mkdirSync(path.join(rootDir, 'skills', 'calendar'), { recursive: true });
      fs.writeFileSync(
        path.join(rootDir, 'skills', 'calendar', '_meta.json'),
        JSON.stringify({ title: 'Calendar' }),
        'utf8',
      );

      const calls: Array<{ command: string; args: string[] }> = [];
      const cli = makeCli({
        run: async (command, args) => {
          calls.push({ command, args });
          return { stdout: '', stderr: '', exitCode: 0, command: 'noop', argv: [] };
        },
      });
      const repo = new ClawHubRepository(':memory:');
      const service = new ClawHubService({ cli, repository: repo, workspaceDir: rootDir });

      const result = await service.install({ slug: 'calendar', version: '2.0.0', force: true });

      expect(calls[0].command).toBe('install');
      expect(calls[0].args).toEqual(['--force', '--version', '2.0.0', 'calendar']);
      expect(result.skills).toHaveLength(1);
    });

    it('installs without force flag', async () => {
      const rootDir = uniqueDir('clawhub.service.install-noforce');
      createdDirs.push(rootDir);
      fs.mkdirSync(path.join(rootDir, '.clawhub'), { recursive: true });
      fs.writeFileSync(
        path.join(rootDir, '.clawhub', 'lock.json'),
        JSON.stringify({ version: 1, skills: {} }),
        'utf8',
      );

      const calls: Array<{ command: string; args: string[] }> = [];
      const cli = makeCli({
        run: async (command, args) => {
          calls.push({ command, args });
          return { stdout: '', stderr: '', exitCode: 0, command: 'noop', argv: [] };
        },
      });
      const service = new ClawHubService({
        cli,
        repository: new ClawHubRepository(':memory:'),
        workspaceDir: rootDir,
      });

      await service.install({ slug: 'calendar' });

      expect(calls[0].args).toEqual(['calendar']);
    });

    it('throws on empty slug', async () => {
      const service = new ClawHubService({
        cli: makeCli(),
        repository: new ClawHubRepository(':memory:'),
      });
      await expect(service.install({ slug: '  ' })).rejects.toThrow(ClawHubInputError);
    });
  });

  describe('update', () => {
    it('updates all with version and force', async () => {
      const rootDir = uniqueDir('clawhub.service.update');
      createdDirs.push(rootDir);
      fs.mkdirSync(path.join(rootDir, '.clawhub'), { recursive: true });
      fs.writeFileSync(
        path.join(rootDir, '.clawhub', 'lock.json'),
        JSON.stringify({ version: 1, skills: {} }),
        'utf8',
      );

      const calls: Array<{ command: string; args: string[] }> = [];
      const cli = makeCli({
        run: async (command, args) => {
          calls.push({ command, args });
          return { stdout: '', stderr: '', exitCode: 0, command: 'noop', argv: [] };
        },
      });
      const service = new ClawHubService({
        cli,
        repository: new ClawHubRepository(':memory:'),
        workspaceDir: rootDir,
      });

      await service.update({ all: true, version: '3.0.0', force: true });

      expect(calls[0].command).toBe('update');
      expect(calls[0].args).toEqual(['--all', '--version', '3.0.0', '--force']);
    });

    it('updates single slug', async () => {
      const rootDir = uniqueDir('clawhub.service.update-single');
      createdDirs.push(rootDir);
      fs.mkdirSync(path.join(rootDir, '.clawhub'), { recursive: true });
      fs.writeFileSync(
        path.join(rootDir, '.clawhub', 'lock.json'),
        JSON.stringify({ version: 1, skills: {} }),
        'utf8',
      );

      const calls: Array<{ command: string; args: string[] }> = [];
      const cli = makeCli({
        run: async (command, args) => {
          calls.push({ command, args });
          return { stdout: '', stderr: '', exitCode: 0, command: 'noop', argv: [] };
        },
      });
      const service = new ClawHubService({
        cli,
        repository: new ClawHubRepository(':memory:'),
        workspaceDir: rootDir,
      });

      await service.update({ slug: 'calendar' });

      expect(calls[0].args).toEqual(['calendar']);
    });
  });

  describe('uninstall', () => {
    it('throws ClawHubNotFoundError when skill not found anywhere', async () => {
      const rootDir = uniqueDir('clawhub.service.uninstall-notfound');
      createdDirs.push(rootDir);
      const service = new ClawHubService({
        cli: makeCli(),
        repository: new ClawHubRepository(':memory:'),
        workspaceDir: rootDir,
      });

      await expect(service.uninstall('calendar')).rejects.toThrow(ClawHubNotFoundError);
    });

    it('removes only repository row when no lock or directory', async () => {
      const rootDir = uniqueDir('clawhub.service.uninstall-repo-only');
      createdDirs.push(rootDir);
      const repo = new ClawHubRepository(':memory:');
      repo.upsertSkill({
        slug: 'calendar',
        version: '1.0.0',
        title: 'Calendar',
        status: 'installed',
        localPath: 'skills/calendar',
        enabled: true,
      });
      const service = new ClawHubService({
        cli: makeCli(),
        repository: repo,
        workspaceDir: rootDir,
      });

      const result = await service.uninstall('calendar');

      expect(result.skills).toEqual([]);
      expect(repo.getSkill('calendar')).toBeNull();
    });

    it('removes only skill directory when no lock or repo row', async () => {
      const rootDir = uniqueDir('clawhub.service.uninstall-dir-only');
      createdDirs.push(rootDir);
      fs.mkdirSync(path.join(rootDir, 'skills', 'calendar'), { recursive: true });
      const service = new ClawHubService({
        cli: makeCli(),
        repository: new ClawHubRepository(':memory:'),
        workspaceDir: rootDir,
      });

      const result = await service.uninstall('calendar');

      expect(result.skills).toEqual([]);
      expect(fs.existsSync(path.join(rootDir, 'skills', 'calendar'))).toBe(false);
    });
  });

  describe('syncInstalledFromLockfile', () => {
    it('returns repository list when lockfile does not exist', async () => {
      const rootDir = uniqueDir('clawhub.service.sync-nolock');
      createdDirs.push(rootDir);
      const repo = new ClawHubRepository(':memory:');
      repo.upsertSkill({
        slug: 'calendar',
        version: '1.0.0',
        title: 'Calendar',
        status: 'installed',
        localPath: 'skills/calendar',
        enabled: true,
      });
      const service = new ClawHubService({
        cli: makeCli(),
        repository: repo,
        workspaceDir: rootDir,
      });

      const synced = await service.syncInstalledFromLockfile();

      expect(synced).toHaveLength(1);
    });

    it('returns repository list when skills value is an array', async () => {
      const rootDir = uniqueDir('clawhub.service.sync-array');
      createdDirs.push(rootDir);
      fs.mkdirSync(path.join(rootDir, '.clawhub'), { recursive: true });
      fs.writeFileSync(
        path.join(rootDir, '.clawhub', 'lock.json'),
        JSON.stringify({ version: 1, skills: [] }),
        'utf8',
      );
      const repo = new ClawHubRepository(':memory:');
      repo.upsertSkill({
        slug: 'calendar',
        version: '1.0.0',
        title: 'Calendar',
        status: 'installed',
        localPath: 'skills/calendar',
        enabled: true,
      });
      const service = new ClawHubService({
        cli: makeCli(),
        repository: repo,
        workspaceDir: rootDir,
      });

      const synced = await service.syncInstalledFromLockfile();

      expect(synced).toHaveLength(1);
    });

    it('keeps valid slugs and deletes not-in when mixed with invalid', async () => {
      const rootDir = uniqueDir('clawhub.service.sync-mixed');
      createdDirs.push(rootDir);
      fs.mkdirSync(path.join(rootDir, '.clawhub'), { recursive: true });
      fs.writeFileSync(
        path.join(rootDir, '.clawhub', 'lock.json'),
        JSON.stringify({
          version: 1,
          skills: {
            calendar: { version: '1.0.0' },
            '../bad': { version: '1.0.0' },
          },
        }),
        'utf8',
      );
      fs.mkdirSync(path.join(rootDir, 'skills', 'calendar'), { recursive: true });
      fs.writeFileSync(
        path.join(rootDir, 'skills', 'calendar', '_meta.json'),
        JSON.stringify({ title: 'Calendar' }),
        'utf8',
      );
      const repo = new ClawHubRepository(':memory:');
      repo.upsertSkill({
        slug: 'stale',
        version: '1.0.0',
        title: 'Stale',
        status: 'installed',
        localPath: 'skills/stale',
        enabled: true,
      });
      const service = new ClawHubService({
        cli: makeCli(),
        repository: repo,
        workspaceDir: rootDir,
      });

      const synced = await service.syncInstalledFromLockfile();

      expect(synced).toHaveLength(1);
      expect(synced[0].slug).toBe('calendar');
      expect(repo.getSkill('stale')).toBeNull();
    });

    it('uses slug as title when meta title is missing', async () => {
      const rootDir = uniqueDir('clawhub.service.sync-notitle');
      createdDirs.push(rootDir);
      fs.mkdirSync(path.join(rootDir, '.clawhub'), { recursive: true });
      fs.writeFileSync(
        path.join(rootDir, '.clawhub', 'lock.json'),
        JSON.stringify({ version: 1, skills: { calendar: { version: '1.0.0' } } }),
        'utf8',
      );
      fs.mkdirSync(path.join(rootDir, 'skills', 'calendar'), { recursive: true });
      fs.writeFileSync(path.join(rootDir, 'skills', 'calendar', '_meta.json'), '{}', 'utf8');
      const service = new ClawHubService({
        cli: makeCli(),
        repository: new ClawHubRepository(':memory:'),
        workspaceDir: rootDir,
      });

      const synced = await service.syncInstalledFromLockfile();

      expect(synced[0].title).toBe('calendar');
    });
  });

  describe('setEnabled', () => {
    it('enables a skill', async () => {
      const repo = new ClawHubRepository(':memory:');
      repo.upsertSkill({
        slug: 'calendar',
        version: '1.0.0',
        title: 'Calendar',
        status: 'installed',
        localPath: 'skills/calendar',
        enabled: false,
      });
      const service = new ClawHubService({ cli: makeCli(), repository: repo });

      const result = await service.setEnabled('calendar', true);

      expect(result.enabled).toBe(true);
    });

    it('throws ClawHubNotFoundError when skill not found', async () => {
      const service = new ClawHubService({
        cli: makeCli(),
        repository: new ClawHubRepository(':memory:'),
      });

      await expect(service.setEnabled('calendar', true)).rejects.toThrow(ClawHubNotFoundError);
    });
  });

  describe('getPromptBlock', () => {
    it('returns prompt block', async () => {
      const service = new ClawHubService({
        cli: makeCli(),
        repository: new ClawHubRepository(':memory:'),
      });

      const block = await service.getPromptBlock();

      expect(typeof block).toBe('string');
    });
  });

  describe('getClawHubService', () => {
    it('returns singleton instance', () => {
      const original = (globalThis as { __clawHubService?: unknown }).__clawHubService;
      (globalThis as { __clawHubService?: unknown }).__clawHubService = undefined;

      const first = getClawHubService();
      const second = getClawHubService();

      expect(first).toBe(second);

      (globalThis as { __clawHubService?: unknown }).__clawHubService = original;
    });
  });
});
