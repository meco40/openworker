import { describe, expect, it } from 'vitest';
import { mapSkillsToTools } from '@/skills/definitions';
import type { Skill } from '@/shared/domain/types';

const makeSkill = (id: string, installed: boolean): Skill => ({
  id,
  name: id,
  description: `Skill ${id}`,
  category: 'Test',
  installed,
  version: '1.0.0',
  functionName: `${id}_execute`,
  source: 'built-in',
});

describe('mapSkillsToTools', () => {
  const skills: Skill[] = [
    makeSkill('browser', true),
    makeSkill('search', true),
    makeSkill('filesystem', false),
  ];

  it('maps installed skills to Gemini tool declarations', () => {
    const tools = mapSkillsToTools(skills, 'gemini');
    expect(tools.length).toBe(2); // browser + search

    // Browser should have functionDeclarations wrapper
    const browserTool = tools.find(
      (t: unknown) => typeof t === 'object' && t !== null && 'functionDeclarations' in t,
    );
    expect(browserTool).toBeDefined();

    // Search should be googleSearch built-in
    const searchTool = tools.find(
      (t: unknown) => typeof t === 'object' && t !== null && 'googleSearch' in t,
    );
    expect(searchTool).toBeDefined();
  });

  it('maps installed skills to OpenAI format', () => {
    const tools = mapSkillsToTools(skills, 'openai');
    // Search has no openai config, so only browser
    expect(tools.length).toBe(1);
    const tool = tools[0] as { type: string; function: { name: string } };
    expect(tool.type).toBe('function');
    expect(tool.function.name).toBe('browser_snapshot');
  });

  it('maps installed skills to Claude format', () => {
    const tools = mapSkillsToTools(skills, 'claude');
    expect(tools.length).toBe(1);
    const tool = tools[0] as { name: string; input_schema: unknown };
    expect(tool.name).toBe('browser_snapshot');
    expect(tool.input_schema).toBeDefined();
  });

  it('returns empty array when no skills are installed', () => {
    const noSkills = skills.map((s) => ({ ...s, installed: false }));
    const tools = mapSkillsToTools(noSkills, 'gemini');
    expect(tools).toEqual([]);
  });

  it('defaults to gemini provider', () => {
    const tools = mapSkillsToTools(skills);
    expect(tools.length).toBe(2); // browser + search
  });
});
