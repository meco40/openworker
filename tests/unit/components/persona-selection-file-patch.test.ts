import { describe, expect, it } from 'vitest';
import type { PersonaWithFiles } from '@/server/personas/personaTypes';
import { applySavedPersonaFile } from '@/components/personas/hooks/usePersonaSelection';

function buildPersona(): PersonaWithFiles {
  const now = new Date().toISOString();
  return {
    id: 'persona-1',
    name: 'Nata 2',
    slug: 'nata_2',
    emoji: '🤖',
    vibe: 'test',
    preferredModelId: null,
    modelHubProfileId: null,
    memoryPersonaType: 'general',
    isAutonomous: false,
    maxToolCalls: 120,
    userId: 'user-1',
    createdAt: now,
    updatedAt: now,
    files: {
      'SOUL.md': 'soul',
      'AGENTS.md': 'before',
      'USER.md': 'user',
    },
  };
}

describe('applySavedPersonaFile', () => {
  it('updates only the targeted file while preserving other persona data', () => {
    const persona = buildPersona();
    const updated = applySavedPersonaFile(persona, 'AGENTS.md', 'after');

    expect(updated).not.toBeNull();
    expect(updated?.files['AGENTS.md']).toBe('after');
    expect(updated?.files['SOUL.md']).toBe('soul');
    expect(updated?.files['USER.md']).toBe('user');
    expect(updated?.id).toBe(persona.id);
    expect(updated?.slug).toBe(persona.slug);
  });

  it('returns null unchanged when no persona is selected', () => {
    expect(applySavedPersonaFile(null, 'AGENTS.md', 'content')).toBeNull();
  });
});
