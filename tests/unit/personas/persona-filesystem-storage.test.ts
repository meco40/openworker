import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqliteDatabase } from '@/server/db/sqlite';
import { PersonaRepository } from '@/server/personas/personaRepository';

describe('persona filesystem storage', () => {
  const cleanupFiles: string[] = [];

  afterEach(() => {
    delete process.env.PERSONAS_DB_PATH;

    for (const filePath of cleanupFiles.splice(0, cleanupFiles.length)) {
      for (const candidate of [filePath, `${filePath}-wal`, `${filePath}-shm`]) {
        try {
          fs.rmSync(candidate, { force: true });
        } catch {
          // ignore test cleanup errors
        }
      }
    }

    try {
      fs.rmSync(path.resolve('.local/personas'), { recursive: true, force: true });
    } catch {
      // ignore test cleanup errors
    }
  });

  it('writes and reads persona files from filesystem without persisting persona_files rows', () => {
    const personasDbPath = path.resolve(
      '.local',
      `personas.fs.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
    );
    cleanupFiles.push(personasDbPath);
    process.env.PERSONAS_DB_PATH = personasDbPath;

    const repo = new PersonaRepository(personasDbPath);
    const created = repo.createPersona({
      userId: 'u-fs',
      name: 'FS Persona',
      emoji: '🗂️',
      vibe: 'file-first',
      files: {
        'SOUL.md': 'Soul from filesystem',
      },
    } as never);

    const soulPath = path.resolve(`.local/personas/${created.slug}/SOUL.md`);
    expect(fs.existsSync(soulPath)).toBe(true);
    expect(fs.readFileSync(soulPath, 'utf8')).toBe('Soul from filesystem');
    expect(repo.getFile(created.id, 'SOUL.md')).toBe('Soul from filesystem');

    repo.saveFile(created.id, 'AGENTS.md', 'Agents from filesystem');
    const agentsPath = path.resolve(`.local/personas/${created.slug}/AGENTS.md`);
    expect(fs.readFileSync(agentsPath, 'utf8')).toBe('Agents from filesystem');

    const db = openSqliteDatabase({ dbPath: personasDbPath });
    const hasLegacyTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'persona_files'")
      .get() as { 1: number } | undefined;
    if (hasLegacyTable) {
      const row = db
        .prepare('SELECT COUNT(*) AS c FROM persona_files WHERE persona_id = ?')
        .get(created.id) as { c: number };
      expect(row.c).toBe(0);
    } else {
      expect(hasLegacyTable).toBeUndefined();
    }
    db.close();
    repo.close();
  });

  it('migrates legacy persona_files content into missing filesystem files', () => {
    const personasDbPath = path.resolve(
      '.local',
      `personas.fs.migrate.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
    );
    cleanupFiles.push(personasDbPath);
    process.env.PERSONAS_DB_PATH = personasDbPath;

    const firstRepo = new PersonaRepository(personasDbPath);
    const persona = firstRepo.createPersona({
      userId: 'u-fs-migration',
      name: 'Legacy Persona',
      emoji: '📦',
      vibe: 'legacy',
    } as never);
    firstRepo.close();

    const soulPath = path.resolve(`.local/personas/${persona.slug}/SOUL.md`);
    try {
      fs.rmSync(soulPath, { force: true });
    } catch {
      // ignore
    }

    const db = openSqliteDatabase({ dbPath: personasDbPath });
    db.exec(`
      CREATE TABLE IF NOT EXISTS persona_files (
        persona_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (persona_id, filename)
      )
    `);
    db.prepare(
      `INSERT INTO persona_files (persona_id, filename, content)
       VALUES (?, ?, ?)
       ON CONFLICT(persona_id, filename) DO UPDATE SET content = excluded.content`,
    ).run(persona.id, 'SOUL.md', 'Legacy SOUL content');
    db.close();

    const migratedRepo = new PersonaRepository(personasDbPath);
    expect(fs.existsSync(soulPath)).toBe(true);
    expect(fs.readFileSync(soulPath, 'utf8')).toBe('Legacy SOUL content');
    expect(migratedRepo.getFile(persona.id, 'SOUL.md')).toBe('Legacy SOUL content');
    migratedRepo.close();
  });
});
