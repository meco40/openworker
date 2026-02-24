/**
 * Unit tests for src/server/skills/skillMd/filter.ts
 */

import { describe, it, expect } from 'vitest';

import { filterEligibleSkills } from '@/server/skills/skillMd/filter';
import type { ParsedSkillMd } from '@/server/skills/skillMd/types';

function makeSkill(
  overrides: Partial<ParsedSkillMd['frontmatter']> & { id?: string },
): ParsedSkillMd {
  return {
    tier: 'built-in',
    frontmatter: { id: 'test-skill', ...overrides },
    body: 'body',
    filePath: '/path/SKILL.md',
    source: 'bundled',
  };
}

describe('filterEligibleSkills', () => {
  it('includes skills with no restrictions', () => {
    const skills = [makeSkill({ id: 'open-skill' })];
    const result = filterEligibleSkills(skills, { platform: 'linux' });
    expect(result).toHaveLength(1);
  });

  it('filters out skills for wrong OS', () => {
    const skills = [makeSkill({ id: 'mac-only', os: ['darwin'] })];
    const result = filterEligibleSkills(skills, { platform: 'linux' });
    expect(result).toHaveLength(0);
  });

  it('always: true bypasses OS check', () => {
    const skills = [makeSkill({ id: 'always-on', os: ['darwin'], always: true })];
    const result = filterEligibleSkills(skills, { platform: 'linux' });
    expect(result).toHaveLength(1);
  });

  it('filters out skills when required env var is missing', () => {
    const originalEnv = process.env['SKILL_TEST_VAR_MISSING'];
    delete process.env['SKILL_TEST_VAR_MISSING'];
    const skills = [makeSkill({ id: 'env-skill', requires: { env: ['SKILL_TEST_VAR_MISSING'] } })];
    const result = filterEligibleSkills(skills);
    expect(result).toHaveLength(0);
    if (originalEnv !== undefined) process.env['SKILL_TEST_VAR_MISSING'] = originalEnv;
  });

  it('includes skills when required env var is present', () => {
    process.env['SKILL_TEST_VAR_EXISTS'] = 'yes';
    const skills = [makeSkill({ id: 'env-skill', requires: { env: ['SKILL_TEST_VAR_EXISTS'] } })];
    const result = filterEligibleSkills(skills);
    expect(result).toHaveLength(1);
    delete process.env['SKILL_TEST_VAR_EXISTS'];
  });
});
