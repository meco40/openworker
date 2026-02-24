/**
 * Unit tests for src/server/skills/skillMd/prompt.ts
 */

import { describe, it, expect } from 'vitest';

import { buildSkillsPromptSection } from '@/server/skills/skillMd/prompt';
import type { EnrichedSkill } from '@/server/skills/skillMd/enricher';

function makeEnrichedSkill(id: string, body: string, emoji?: string): EnrichedSkill {
  return {
    id,
    name: `Skill ${id}`,
    description: `Description for ${id}`,
    version: '1.0.0',
    category: 'Test',
    functionName: `skill_${id}`,
    tool: {
      name: `skill_${id}`,
      description: `Does ${id}`,
      parameters: { type: 'object', properties: {}, required: [] },
    },
    emoji,
    body,
    filePath: `/skills/${id}/SKILL.md`,
    source: 'bundled',
  };
}

describe('buildSkillsPromptSection', () => {
  it('returns empty string when no skills have bodies', () => {
    const skills = [makeEnrichedSkill('a', ''), makeEnrichedSkill('b', '   ')];
    expect(buildSkillsPromptSection(skills)).toBe('');
  });

  it('includes the section header when skills have bodies', () => {
    const skills = [makeEnrichedSkill('a', 'Use this for A.')];
    const result = buildSkillsPromptSection(skills);
    expect(result).toContain('## Skill Guidance');
  });

  it('includes emoji in skill header when provided', () => {
    const skills = [makeEnrichedSkill('browser', 'Browse the web.', '🌐')];
    const result = buildSkillsPromptSection(skills);
    expect(result).toContain('🌐');
    expect(result).toContain('Skill browser');
  });

  it('includes body content in output', () => {
    const skills = [makeEnrichedSkill('x', 'Unique body content for testing.')];
    const result = buildSkillsPromptSection(skills);
    expect(result).toContain('Unique body content for testing.');
  });

  it('truncates at 30k character limit', () => {
    // Create skills with bodies that total well over 30k characters.
    const bigBody = 'x'.repeat(5_000);
    const skills = Array.from({ length: 20 }, (_, i) => makeEnrichedSkill(`skill${i}`, bigBody));
    const result = buildSkillsPromptSection(skills);
    expect(result.length).toBeLessThanOrEqual(30_000);
    expect(result.length).toBeGreaterThan(0);
  });
});
