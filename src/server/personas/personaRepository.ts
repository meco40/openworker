import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import type {
  CreatePersonaInput,
  PersonaFileName,
  PersonaProfile,
  PersonaSummary,
  PersonaWithFiles,
} from './personaTypes';
import {
  MAX_PERSONA_INSTRUCTION_CHARS,
  PERSONA_FILE_NAMES,
  PERSONA_INSTRUCTION_FILES,
} from './personaTypes';

// ─── Row mappers ─────────────────────────────────────────────

function toPersona(row: Record<string, unknown>): PersonaProfile {
  return {
    id: row.id as string,
    name: row.name as string,
    emoji: row.emoji as string,
    vibe: row.vibe as string,
    preferredModelId: (row.preferred_model_id as string) || null,
    userId: row.user_id as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function toSummary(row: Record<string, unknown>): PersonaSummary {
  return {
    id: row.id as string,
    name: row.name as string,
    emoji: row.emoji as string,
    vibe: row.vibe as string,
    preferredModelId: (row.preferred_model_id as string) || null,
    updatedAt: row.updated_at as string,
  };
}

// ─── Repository ──────────────────────────────────────────────

export class PersonaRepository {
  private readonly db: ReturnType<typeof BetterSqlite3>;

  constructor(dbPath = process.env.PERSONAS_DB_PATH || '.local/personas.db') {
    if (dbPath === ':memory:') {
      this.db = new BetterSqlite3(':memory:');
    } else {
      const fullPath = path.resolve(dbPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      this.db = new BetterSqlite3(fullPath);
    }
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS personas (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        emoji TEXT NOT NULL DEFAULT '🤖',
        vibe TEXT NOT NULL DEFAULT '',
        preferred_model_id TEXT,
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    try {
      this.db.exec('ALTER TABLE personas ADD COLUMN preferred_model_id TEXT');
    } catch {
      // column already exists
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS persona_files (
        persona_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (persona_id, filename),
        FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE CASCADE
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_personas_user
        ON personas (user_id, updated_at DESC);
    `);

    // Enable FK enforcement
    this.db.pragma('foreign_keys = ON');
  }

  // ─── Persona CRUD ──────────────────────────────────────────

  listPersonas(userId: string): PersonaSummary[] {
    const rows = this.db
      .prepare('SELECT * FROM personas WHERE user_id = ? ORDER BY updated_at DESC')
      .all(userId) as Array<Record<string, unknown>>;
    return rows.map(toSummary);
  }

  getPersona(id: string): PersonaProfile | null {
    const row = this.db.prepare('SELECT * FROM personas WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toPersona(row) : null;
  }

  getPersonaWithFiles(id: string): PersonaWithFiles | null {
    const persona = this.getPersona(id);
    if (!persona) return null;

    const fileRows = this.db
      .prepare('SELECT filename, content FROM persona_files WHERE persona_id = ?')
      .all(id) as Array<{ filename: string; content: string }>;

    const files: Partial<Record<PersonaFileName, string>> = {};
    for (const row of fileRows) {
      files[row.filename as PersonaFileName] = row.content;
    }

    return { ...persona, files };
  }

  createPersona(input: CreatePersonaInput): PersonaProfile {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO personas (id, name, emoji, vibe, preferred_model_id, user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.emoji,
        input.vibe,
        input.preferredModelId || null,
        input.userId,
        now,
        now,
      );

    // Seed all file slots with provided content or empty string
    const insertFile = this.db.prepare(
      'INSERT INTO persona_files (persona_id, filename, content) VALUES (?, ?, ?)',
    );
    for (const filename of PERSONA_FILE_NAMES) {
      const content = input.files?.[filename] ?? '';
      insertFile.run(id, filename, content);
    }

    return this.getPersona(id)!;
  }

  updatePersona(
    id: string,
    updates: {
      name?: string;
      emoji?: string;
      vibe?: string;
      preferredModelId?: string | null;
    },
  ): void {
    const now = new Date().toISOString();
    const setClauses: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];

    if (updates.name !== undefined) {
      setClauses.push('name = ?');
      values.push(updates.name);
    }
    if (updates.emoji !== undefined) {
      setClauses.push('emoji = ?');
      values.push(updates.emoji);
    }
    if (updates.vibe !== undefined) {
      setClauses.push('vibe = ?');
      values.push(updates.vibe);
    }
    if (updates.preferredModelId !== undefined) {
      setClauses.push('preferred_model_id = ?');
      values.push(updates.preferredModelId);
    }

    values.push(id);
    this.db.prepare(`UPDATE personas SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
  }

  deletePersona(id: string): boolean {
    // FK CASCADE will remove persona_files
    const result = this.db.prepare('DELETE FROM personas WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // ─── File CRUD ─────────────────────────────────────────────

  getFile(personaId: string, filename: PersonaFileName): string | null {
    const row = this.db
      .prepare('SELECT content FROM persona_files WHERE persona_id = ? AND filename = ?')
      .get(personaId, filename) as { content: string } | undefined;
    return row ? row.content : null;
  }

  saveFile(personaId: string, filename: PersonaFileName, content: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO persona_files (persona_id, filename, content)
         VALUES (?, ?, ?)
         ON CONFLICT(persona_id, filename) DO UPDATE SET content = excluded.content`,
      )
      .run(personaId, filename, content);

    // Touch parent updated_at
    this.db.prepare('UPDATE personas SET updated_at = ? WHERE id = ?').run(now, personaId);
  }

  // ─── System Instruction Composition ─────────────────────────

  /**
   * Composes the system instruction from SOUL.md + AGENTS.md + USER.md,
   * capped at MAX_PERSONA_INSTRUCTION_CHARS.
   * Returns null if persona doesn't exist or all instruction files are empty.
   */
  getPersonaSystemInstruction(personaId: string): string | null {
    const persona = this.getPersona(personaId);
    if (!persona) return null;

    const parts: string[] = [];
    for (const filename of PERSONA_INSTRUCTION_FILES) {
      const content = this.getFile(personaId, filename);
      if (content?.trim()) {
        parts.push(`--- ${filename} ---\n${content.trim()}`);
      }
    }

    if (parts.length === 0) return null;

    let combined = parts.join('\n\n');
    if (combined.length > MAX_PERSONA_INSTRUCTION_CHARS) {
      combined = combined.slice(0, MAX_PERSONA_INSTRUCTION_CHARS) + '\n\n[... truncated]';
    }

    return combined;
  }

  // ─── Lifecycle ─────────────────────────────────────────────

  close(): void {
    this.db.close();
  }
}

// ─── Singleton ───────────────────────────────────────────────

let _instance: PersonaRepository | null = null;

export function getPersonaRepository(): PersonaRepository {
  if (!_instance) {
    _instance = new PersonaRepository();
  }
  return _instance;
}
