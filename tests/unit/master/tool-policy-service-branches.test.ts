import { describe, expect, it } from 'vitest';
import { SqliteMasterRepository } from '@/server/master/repository/sqliteMasterRepository';
import {
  loadToolPolicy,
  resolveToolPolicy,
  saveToolPolicy,
} from '@/server/master/toolPolicy/service';
import type { MasterToolPolicy } from '@/server/master/types';

function makePolicy(overrides: Partial<MasterToolPolicy> = {}): MasterToolPolicy {
  return {
    id: 'policy-1',
    userId: 'u1',
    workspaceId: 'w1',
    security: 'allowlist',
    ask: 'on_miss',
    allowlist: [],
    updatedBy: 'operator',
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:00.000Z',
    ...overrides,
  };
}

describe('master tool policy service branches', () => {
  it('loadToolPolicy returns existing policy when present', () => {
    const repo = new SqliteMasterRepository(':memory:');
    const scope = { userId: 'u1', workspaceId: 'w1' };
    saveToolPolicy({
      repo,
      scope,
      policy: {
        security: 'allowlist',
        ask: 'on_miss',
        allowlist: ['shell_execute'],
        updatedBy: 'operator',
      },
    });

    const loaded = loadToolPolicy({ repo, scope });
    expect(loaded).not.toBeNull();
    expect(loaded?.security).toBe('allowlist');
    repo.close();
  });

  it('loadToolPolicy returns null when no policy and no fallback', () => {
    const repo = new SqliteMasterRepository(':memory:');
    const scope = { userId: 'u1', workspaceId: 'w1' };

    const loaded = loadToolPolicy({ repo, scope });
    expect(loaded).toBeNull();
    repo.close();
  });

  it('loadToolPolicy builds fallback policy when no existing policy but fallback provided', () => {
    const repo = new SqliteMasterRepository(':memory:');
    const scope = { userId: 'u1', workspaceId: 'w1' };

    const loaded = loadToolPolicy({
      repo,
      scope,
      fallbackAllowlist: ['read_file'],
    });
    expect(loaded).not.toBeNull();
    expect(loaded?.security).toBe('allowlist');
    expect(loaded?.allowlist).toEqual(['read_file']);
    expect(loaded?.id).toBe('default');
    repo.close();
  });

  it('resolveToolPolicy allows when no policy exists', () => {
    const repo = new SqliteMasterRepository(':memory:');
    const scope = { userId: 'u1', workspaceId: 'w1' };

    const result = resolveToolPolicy({
      repo,
      scope,
      actionType: 'shell_execute',
    });
    expect(result.decision).toBe('allow');
    expect(result.policy).toBeNull();
    repo.close();
  });

  it('resolveToolPolicy denies when security is deny', () => {
    const repo = new SqliteMasterRepository(':memory:');
    const scope = { userId: 'u1', workspaceId: 'w1' };
    saveToolPolicy({
      repo,
      scope,
      policy: {
        security: 'deny',
        ask: 'off',
        allowlist: [],
        updatedBy: 'operator',
      },
    });

    const result = resolveToolPolicy({
      repo,
      scope,
      actionType: 'shell_execute',
    });
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('blocks');
    repo.close();
  });

  it('resolveToolPolicy allows everything when security is full', () => {
    const repo = new SqliteMasterRepository(':memory:');
    const scope = { userId: 'u1', workspaceId: 'w1' };
    saveToolPolicy({
      repo,
      scope,
      policy: {
        security: 'full',
        ask: 'off',
        allowlist: [],
        updatedBy: 'operator',
      },
    });

    const result = resolveToolPolicy({
      repo,
      scope,
      actionType: 'shell_execute',
    });
    expect(result.decision).toBe('allow');
    expect(result.matchedAllowlistEntry).toBe('*');
    repo.close();
  });

  it('resolveToolPolicy denies when allowlist miss and ask is off', () => {
    const repo = new SqliteMasterRepository(':memory:');
    const scope = { userId: 'u1', workspaceId: 'w1' };
    saveToolPolicy({
      repo,
      scope,
      policy: {
        security: 'allowlist',
        ask: 'off',
        allowlist: ['read_file'],
        updatedBy: 'operator',
      },
    });

    const result = resolveToolPolicy({
      repo,
      scope,
      actionType: 'shell_execute',
    });
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('requires allowlist match');
    repo.close();
  });

  it('resolveToolPolicy asks when allowlist miss and ask is on_miss', () => {
    const repo = new SqliteMasterRepository(':memory:');
    const scope = { userId: 'u1', workspaceId: 'w1' };
    saveToolPolicy({
      repo,
      scope,
      policy: {
        security: 'allowlist',
        ask: 'on_miss',
        allowlist: ['read_file'],
        updatedBy: 'operator',
      },
    });

    const result = resolveToolPolicy({
      repo,
      scope,
      actionType: 'shell_execute',
    });
    expect(result.decision).toBe('ask');
    expect(result.reason).toContain('approval required');
    repo.close();
  });

  it('resolveToolPolicy asks when ask is always even with allowlist match', () => {
    const repo = new SqliteMasterRepository(':memory:');
    const scope = { userId: 'u1', workspaceId: 'w1' };
    saveToolPolicy({
      repo,
      scope,
      policy: {
        security: 'allowlist',
        ask: 'always',
        allowlist: ['shell_execute'],
        updatedBy: 'operator',
      },
    });

    const result = resolveToolPolicy({
      repo,
      scope,
      actionType: 'shell_execute',
    });
    expect(result.decision).toBe('ask');
    expect(result.matchedAllowlistEntry).toBe('shell_execute');
    repo.close();
  });

  it('resolveToolPolicy allows when allowlist match and ask is on_miss', () => {
    const repo = new SqliteMasterRepository(':memory:');
    const scope = { userId: 'u1', workspaceId: 'w1' };
    saveToolPolicy({
      repo,
      scope,
      policy: {
        security: 'allowlist',
        ask: 'on_miss',
        allowlist: ['shell_execute'],
        updatedBy: 'operator',
      },
    });

    const result = resolveToolPolicy({
      repo,
      scope,
      actionType: 'shell_execute',
    });
    expect(result.decision).toBe('allow');
    expect(result.matchedAllowlistEntry).toBe('shell_execute');
    repo.close();
  });

  it('resolveToolPolicy matches host-scoped allowlist entries', () => {
    const repo = new SqliteMasterRepository(':memory:');
    const scope = { userId: 'u1', workspaceId: 'w1' };
    saveToolPolicy({
      repo,
      scope,
      policy: {
        security: 'allowlist',
        ask: 'on_miss',
        allowlist: ['shell_execute:gateway:*'],
        updatedBy: 'operator',
      },
    });

    // Matching host
    const match = resolveToolPolicy({
      repo,
      scope,
      actionType: 'shell_execute',
      host: 'gateway',
    });
    expect(match.decision).toBe('allow');

    // Non-matching host
    const noMatch = resolveToolPolicy({
      repo,
      scope,
      actionType: 'shell_execute',
      host: 'sandbox',
    });
    expect(noMatch.decision).toBe('ask');
    repo.close();
  });

  it('resolveToolPolicy matches target-context allowlist entries', () => {
    const repo = new SqliteMasterRepository(':memory:');
    const scope = { userId: 'u1', workspaceId: 'w1' };
    saveToolPolicy({
      repo,
      scope,
      policy: {
        security: 'allowlist',
        ask: 'on_miss',
        allowlist: ['shell_execute:gateway:/tmp/*'],
        updatedBy: 'operator',
      },
    });

    const match = resolveToolPolicy({
      repo,
      scope,
      actionType: 'shell_execute',
      host: 'gateway',
      targetContext: '/tmp/file.txt',
    });
    expect(match.decision).toBe('allow');

    const noMatch = resolveToolPolicy({
      repo,
      scope,
      actionType: 'shell_execute',
      host: 'gateway',
      targetContext: '/etc/passwd',
    });
    expect(noMatch.decision).toBe('ask');
    repo.close();
  });

  it('resolveToolPolicy matches wildcard subject entries', () => {
    const repo = new SqliteMasterRepository(':memory:');
    const scope = { userId: 'u1', workspaceId: 'w1' };
    saveToolPolicy({
      repo,
      scope,
      policy: {
        security: 'allowlist',
        ask: 'on_miss',
        allowlist: ['*:gateway:*'],
        updatedBy: 'operator',
      },
    });

    const result = resolveToolPolicy({
      repo,
      scope,
      actionType: 'shell_execute',
      host: 'gateway',
    });
    expect(result.decision).toBe('allow');
    repo.close();
  });

  it('resolveToolPolicy matches fingerprint-based entries', () => {
    const repo = new SqliteMasterRepository(':memory:');
    const scope = { userId: 'u1', workspaceId: 'w1' };
    saveToolPolicy({
      repo,
      scope,
      policy: {
        security: 'allowlist',
        ask: 'on_miss',
        allowlist: ['shell_execute:gateway:fingerprint-123'],
        updatedBy: 'operator',
      },
    });

    const result = resolveToolPolicy({
      repo,
      scope,
      actionType: 'shell_execute',
      host: 'gateway',
      fingerprint: 'fingerprint-123',
    });
    expect(result.decision).toBe('allow');
    repo.close();
  });

  it('resolveToolPolicy handles empty allowlist entries', () => {
    const repo = new SqliteMasterRepository(':memory:');
    const scope = { userId: 'u1', workspaceId: 'w1' };
    saveToolPolicy({
      repo,
      scope,
      policy: {
        security: 'allowlist',
        ask: 'on_miss',
        allowlist: ['', '   ', 'shell_execute'],
        updatedBy: 'operator',
      },
    });

    const result = resolveToolPolicy({
      repo,
      scope,
      actionType: 'shell_execute',
    });
    expect(result.decision).toBe('allow');
    repo.close();
  });
});
