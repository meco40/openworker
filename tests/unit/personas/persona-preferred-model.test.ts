import { describe, expect, it } from 'vitest';
import { PersonaRepository } from '../../../src/server/personas/personaRepository';

describe('persona model binding persistence', () => {
  it('stores and updates preferredModelId and modelHubProfileId', () => {
    const repo = new PersonaRepository(':memory:');
    const created = repo.createPersona({
      userId: 'user-a',
      name: 'Research Persona',
      emoji: '🔎',
      vibe: 'focused',
      preferredModelId: 'gpt-4o-mini',
      modelHubProfileId: 'team-a',
    } as never);

    const loaded = repo.getPersona(created.id);
    expect(loaded).not.toBeNull();
    expect((loaded as { preferredModelId?: string | null }).preferredModelId).toBe('gpt-4o-mini');
    expect((loaded as { modelHubProfileId?: string | null }).modelHubProfileId).toBe('team-a');

    repo.updatePersona(
      created.id,
      { preferredModelId: 'claude-3.7-sonnet', modelHubProfileId: 'team-b' } as never,
    );
    const updated = repo.getPersona(created.id);
    expect((updated as { preferredModelId?: string | null }).preferredModelId).toBe(
      'claude-3.7-sonnet',
    );
    expect((updated as { modelHubProfileId?: string | null }).modelHubProfileId).toBe('team-b');

    repo.updatePersona(created.id, { preferredModelId: null, modelHubProfileId: null } as never);
    const cleared = repo.getPersona(created.id);
    expect((cleared as { preferredModelId?: string | null }).preferredModelId).toBeNull();
    expect((cleared as { modelHubProfileId?: string | null }).modelHubProfileId).toBeNull();

    repo.close();
  });
});
