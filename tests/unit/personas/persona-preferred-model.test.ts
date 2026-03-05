import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PersonaRepository } from '@/server/personas/personaRepository';
import { getTestArtifactsRoot } from '../../helpers/testArtifacts';

describe('persona model binding persistence', () => {
  const cleanupDirs: string[] = [];

  function createTestPersonasRootPath(): string {
    const rootPath = path.resolve(
      getTestArtifactsRoot(),
      `personas.test.preferred.${Date.now()}.${Math.random().toString(36).slice(2)}`,
    );
    cleanupDirs.push(rootPath);
    process.env.PERSONAS_ROOT_PATH = rootPath;
    return rootPath;
  }

  afterEach(() => {
    delete process.env.PERSONAS_ROOT_PATH;
    for (const dirPath of cleanupDirs.splice(0, cleanupDirs.length)) {
      try {
        fs.rmSync(dirPath, { recursive: true, force: true });
      } catch {
        // ignore in tests
      }
    }
  });

  it('stores and updates preferredModelId and modelHubProfileId', () => {
    createTestPersonasRootPath();
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

    repo.updatePersona(created.id, {
      preferredModelId: 'claude-3.7-sonnet',
      modelHubProfileId: 'team-b',
    } as never);
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

  it('does not include TOOLS.md in system instruction for non-Nexus personas', () => {
    createTestPersonasRootPath();
    const repo = new PersonaRepository(':memory:');
    const created = repo.createPersona({
      userId: 'user-a',
      name: 'Tool Persona',
      emoji: '🛠️',
      vibe: 'pragmatic',
      files: {
        'SOUL.md': 'Core behavior',
        'AGENTS.md': 'Agent constraints',
        'USER.md': 'User preferences',
        'TOOLS.md': 'Use safe_shell for local search',
      },
    } as never);

    const instruction = repo.getPersonaSystemInstruction(created.id);
    expect(instruction).not.toContain('--- TOOLS.md ---');
    expect(instruction).toContain('--- SOUL.md ---');
    expect(instruction).toContain('--- AGENTS.md ---');
    expect(instruction).toContain('--- USER.md ---');

    repo.close();
  });

  it('does not treat TOOLS.md as an authorization-bearing instruction even for Nexus', () => {
    createTestPersonasRootPath();
    const repo = new PersonaRepository(':memory:');
    const created = repo.createPersona({
      userId: 'user-a',
      name: 'Nexus',
      emoji: '🧠',
      vibe: 'operator',
      files: {
        'SOUL.md': 'Core behavior',
        'AGENTS.md': 'Agent constraints',
        'USER.md': 'User preferences',
        'TOOLS.md': 'Use safe_shell for local search',
      },
    } as never);

    const instruction = repo.getPersonaSystemInstruction(created.id);
    expect(instruction).not.toContain('--- TOOLS.md ---');
    expect(instruction).toContain('--- SOUL.md ---');

    repo.close();
  });
});
