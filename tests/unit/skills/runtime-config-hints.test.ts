import { describe, expect, it } from 'vitest';
import { buildSkillConfigHints } from '../../../skills/runtime-config-hints';
import type { SkillRuntimeConfigStatus } from '../../../skills/runtime-config-client';

function config(overrides: Partial<SkillRuntimeConfigStatus>): SkillRuntimeConfigStatus {
  return {
    id: 'vision.gemini_api_key',
    skillId: 'vision',
    label: 'Vision (Gemini) API Key',
    description: '',
    kind: 'secret',
    required: true,
    envVars: ['GEMINI_API_KEY'],
    configured: false,
    source: null,
    maskedValue: null,
    updatedAt: null,
    ...overrides,
  };
}

describe('buildSkillConfigHints', () => {
  it('returns required and optional setup hints for a skill', () => {
    const hints = buildSkillConfigHints('vision', [
      config({ id: 'vision.gemini_api_key', required: true, label: 'Vision (Gemini) API Key' }),
      config({
        id: 'vision.extra',
        required: false,
        label: 'Vision Optional Endpoint',
        kind: 'text',
      }),
    ]);

    expect(hints).toEqual({
      requiredHint: 'Requires setup: Vision (Gemini) API Key',
      optionalHint: 'Optional setup: Vision Optional Endpoint',
    });
  });

  it('returns null hints when skill has no runtime config fields', () => {
    const hints = buildSkillConfigHints('browser', []);

    expect(hints.requiredHint).toBeNull();
    expect(hints.optionalHint).toBeNull();
  });
});
