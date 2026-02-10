import { describe, expect, it } from 'vitest';
import { mapSkillsToTools } from '../skills/definitions';
import type { Skill } from '../types';

const baseSkill = (overrides: Partial<Skill>): Skill => ({
  id: 'x',
  name: 'X',
  description: 'X',
  category: 'general',
  installed: false,
  version: '1.0.0',
  ...overrides,
});

describe('mapSkillsToTools', () => {
  it('maps installed search skill to native googleSearch tool', () => {
    const skills: Skill[] = [
      baseSkill({ id: 'search', installed: true }),
      baseSkill({ id: 'browser', installed: false }),
    ];

    const tools = mapSkillsToTools(skills, 'gemini');

    expect(tools).toContainEqual({ googleSearch: {} });
  });

  it('wraps function-declaration skills in functionDeclarations array', () => {
    const skills: Skill[] = [
      baseSkill({ id: 'search', installed: true }),
      baseSkill({ id: 'browser', installed: true }),
    ];

    const tools = mapSkillsToTools(skills, 'gemini');
    const browserTool = tools.find(
      (tool) => Array.isArray(tool.functionDeclarations),
    );

    expect(browserTool).toBeDefined();
    expect(browserTool?.functionDeclarations[0]?.name).toBe('browser_snapshot');
  });
});
