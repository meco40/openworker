import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PersonaRepository } from '@/server/personas/personaRepository';

function mockUserContext(context: { userId: string; authenticated: boolean } | null): void {
  vi.doMock('../../../src/server/auth/userContext', () => ({
    resolveRequestUserContext: vi.fn().mockResolvedValue(context),
  }));
}

async function loadPersonaFileRoute() {
  return import('../../../app/api/personas/[id]/files/[filename]/route');
}

describe('personas files route (filesystem-backed)', () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.PERSONAS_DB_PATH;

    for (const filePath of cleanupPaths.splice(0, cleanupPaths.length)) {
      for (const candidate of [filePath, `${filePath}-wal`, `${filePath}-shm`]) {
        try {
          if (fs.existsSync(candidate)) {
            fs.unlinkSync(candidate);
          }
        } catch {
          // ignore cleanup races on sqlite sidecars
        }
      }
    }

    try {
      fs.rmSync(path.resolve('.local/personas'), { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('keeps persona files editable through API while persisting to filesystem', async () => {
    const dbPath = path.join(
      process.cwd(),
      '.local',
      `personas.files.route.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
    );
    cleanupPaths.push(dbPath);
    process.env.PERSONAS_DB_PATH = dbPath;

    const repo = new PersonaRepository(dbPath);
    const persona = repo.createPersona({
      userId: 'user-files',
      name: 'Files Persona',
      emoji: '📝',
      vibe: 'editor',
    } as never);
    repo.close();

    mockUserContext({ userId: 'user-files', authenticated: true });
    const route = await loadPersonaFileRoute();

    const putResponse = await route.PUT(
      new Request(`http://localhost/api/personas/${persona.id}/files/SOUL.md`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Filesystem route content' }),
      }),
      { params: Promise.resolve({ id: persona.id, filename: 'SOUL.md' }) },
    );
    expect(putResponse.status).toBe(200);

    const getResponse = await route.GET(
      new Request(`http://localhost/api/personas/${persona.id}/files/SOUL.md`),
      { params: Promise.resolve({ id: persona.id, filename: 'SOUL.md' }) },
    );
    expect(getResponse.status).toBe(200);
    const payload = (await getResponse.json()) as { ok: boolean; content: string };
    expect(payload.ok).toBe(true);
    expect(payload.content).toBe('Filesystem route content');

    const soulPath = path.resolve(`.local/personas/${persona.slug}/SOUL.md`);
    expect(fs.existsSync(soulPath)).toBe(true);
    expect(fs.readFileSync(soulPath, 'utf8')).toBe('Filesystem route content');
  });
});
