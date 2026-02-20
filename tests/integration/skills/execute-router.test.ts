import { describe, expect, it } from 'vitest';
import { dispatchSkill } from '@/server/skills/executeSkill';

describe('dispatchSkill', () => {
  it('routes file_read', async () => {
    const out = await dispatchSkill('file_read', { path: 'README.md' });
    expect(out).toBeDefined();
  });
});
