import { describe, expect, it } from 'vitest';
import { PersonaRepository } from '../../../src/server/personas/personaRepository';

describe('persona preferred model persistence', () => {
  it('stores and updates preferredModelId', () => {
    const repo = new PersonaRepository(':memory:');
    const created = repo.createPersona({
      userId: 'user-a',
      name: 'Research Persona',
      emoji: '🔎',
      vibe: 'focused',
      preferredModelId: 'gpt-4o-mini',
    } as never);

    const loaded = repo.getPersona(created.id);
    expect(loaded).not.toBeNull();
    expect((loaded as { preferredModelId?: string | null }).preferredModelId).toBe('gpt-4o-mini');

    repo.updatePersona(created.id, { preferredModelId: 'claude-3.7-sonnet' } as never);
    const updated = repo.getPersona(created.id);
    expect((updated as { preferredModelId?: string | null }).preferredModelId).toBe(
      'claude-3.7-sonnet',
    );

    repo.updatePersona(created.id, { preferredModelId: null } as never);
    const cleared = repo.getPersona(created.id);
    expect((cleared as { preferredModelId?: string | null }).preferredModelId).toBeNull();

    repo.close();
  });
});
