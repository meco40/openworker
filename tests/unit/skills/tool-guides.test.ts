import { describe, expect, it } from 'vitest';
import type { Skill } from '../../../types';
import type { SkillRuntimeConfigStatus } from '../../../skills/runtime-config-client';
import { getToolGuide } from '../../../skills/tool-guides';

function makeSkill(overrides: Partial<Skill>): Skill {
  return {
    id: 'vision',
    name: 'Live Vision',
    description: 'Echtzeit-Analyse von Kamera-Feeds und Screen-Streams.',
    category: 'Media',
    installed: true,
    version: '2.4.0',
    functionName: 'vision_analyze',
    source: 'built-in',
    ...overrides,
  };
}

function makeConfig(overrides: Partial<SkillRuntimeConfigStatus>): SkillRuntimeConfigStatus {
  return {
    id: 'vision.gemini_api_key',
    skillId: 'vision',
    label: 'Vision (Gemini) API Key',
    description: 'Required for image analysis in the Vision skill.',
    kind: 'secret',
    required: true,
    envVars: ['GEMINI_API_KEY', 'API_KEY'],
    configured: false,
    source: null,
    maskedValue: null,
    updatedAt: null,
    ...overrides,
  };
}

describe('getToolGuide', () => {
  it('returns specific guide content for known built-in tools', () => {
    const guide = getToolGuide(makeSkill({ id: 'vision' }), [makeConfig({})]);
    expect(guide.title).toBe('Live Vision');
    expect(guide.whatItIs.toLowerCase()).toContain('image');
    expect(guide.howToUse.join(' ')).toContain('Vision (Gemini) API Key');
  });

  it('falls back to generic guidance for unknown tools', () => {
    const guide = getToolGuide(makeSkill({ id: 'custom-skill', name: 'Custom Tool' }), []);
    expect(guide.title).toBe('Custom Tool');
    expect(guide.whatItCanDo.length).toBeGreaterThan(0);
    expect(guide.howToUse.length).toBeGreaterThan(0);
  });
});
