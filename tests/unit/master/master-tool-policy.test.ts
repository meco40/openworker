import { describe, expect, it } from 'vitest';
import { SqliteMasterRepository } from '@/server/master/repository/sqliteMasterRepository';
import { saveToolPolicy, loadToolPolicy } from '@/server/master/toolPolicy/service';

describe('master tool policy service', () => {
  it('persists and reloads operator tool policy', () => {
    const repo = new SqliteMasterRepository(':memory:');
    const scope = { userId: 'u1', workspaceId: 'w1' };

    const saved = saveToolPolicy({
      repo,
      scope,
      policy: {
        security: 'allowlist',
        ask: 'on_miss',
        allowlist: ['shell.exec:D:/web/clawtest:*'],
        updatedBy: 'operator-user',
      },
    });

    expect(saved.security).toBe('allowlist');
    expect(loadToolPolicy({ repo, scope })?.allowlist).toContain('shell.exec:D:/web/clawtest:*');
    repo.close();
  });
});
