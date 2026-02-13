import { describe, expect, it } from 'vitest';

import { ClawHubRepository } from '../../../src/server/clawhub/clawhubRepository';

describe('ClawHubRepository', () => {
  it('stores enabled flag and allows toggling', () => {
    const repo = new ClawHubRepository(':memory:');
    repo.upsertSkill({
      slug: 'calendar',
      version: '1.0.0',
      title: 'Calendar',
      status: 'installed',
      localPath: 'skills/calendar',
    });

    const before = repo.getSkill('calendar');
    expect(before).not.toBeNull();
    expect(before?.enabled).toBe(false);

    const updated = repo.setEnabled('calendar', true);
    expect(updated).toBe(true);

    const after = repo.getSkill('calendar');
    expect(after?.enabled).toBe(true);
  });

  it('preserves enabled flag across sync upserts', () => {
    const repo = new ClawHubRepository(':memory:');
    repo.upsertSkill({
      slug: 'calendar',
      version: '1.0.0',
      title: 'Calendar',
      status: 'installed',
      localPath: 'skills/calendar',
      enabled: true,
    });

    repo.upsertSkill({
      slug: 'calendar',
      version: '1.0.1',
      title: 'Calendar',
      status: 'installed',
      localPath: 'skills/calendar',
    });

    const row = repo.getSkill('calendar');
    expect(row?.version).toBe('1.0.1');
    expect(row?.enabled).toBe(true);
  });
});
