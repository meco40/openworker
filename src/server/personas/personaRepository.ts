import type BetterSqlite3 from 'better-sqlite3';
import type {
  CreatePersonaInput,
  MemoryPersonaType,
  PersonaFileName,
  PersonaProfile,
  PersonaSummary,
  PersonaWithFiles,
} from '@/server/personas/personaTypes';
import { openSqliteDatabase } from '@/server/db/sqlite';
import {
  MAX_PERSONA_INSTRUCTION_CHARS,
  MEMORY_PERSONA_TYPES,
  PERSONA_FILE_NAMES,
  PERSONA_INSTRUCTION_FILES,
} from '@/server/personas/personaTypes';
import {
  ensurePersonaWorkspace,
  renamePersonaWorkspace,
  slugifyPersonaName,
} from '@/server/personas/personaWorkspace';

const NEXUS_PERSONA_NAME = 'nexus';

// ─── Row mappers ─────────────────────────────────────────────

function toPersona(row: Record<string, unknown>): PersonaProfile {
  return {
    id: row.id as string,
    name: row.name as string,
    slug: (row.slug as string) || slugifyPersonaName(String(row.name || 'persona')),
    emoji: row.emoji as string,
    vibe: row.vibe as string,
    preferredModelId: (row.preferred_model_id as string) || null,
    modelHubProfileId: (row.model_hub_profile_id as string) || null,
    memoryPersonaType: ((row.memory_persona_type as string) || 'general') as MemoryPersonaType,
    userId: row.user_id as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function toSummary(row: Record<string, unknown>): PersonaSummary {
  return {
    id: row.id as string,
    name: row.name as string,
    slug: (row.slug as string) || slugifyPersonaName(String(row.name || 'persona')),
    emoji: row.emoji as string,
    vibe: row.vibe as string,
    preferredModelId: (row.preferred_model_id as string) || null,
    modelHubProfileId: (row.model_hub_profile_id as string) || null,
    memoryPersonaType: ((row.memory_persona_type as string) || 'general') as MemoryPersonaType,
    updatedAt: row.updated_at as string,
  };
}

// ─── Repository ──────────────────────────────────────────────

export class PersonaRepository {
  private readonly db: ReturnType<typeof BetterSqlite3>;

  constructor(dbPath = process.env.PERSONAS_DB_PATH || '.local/personas.db') {
    this.db = openSqliteDatabase({ dbPath });
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
        model_hub_profile_id TEXT,
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
    try {
      this.db.exec('ALTER TABLE personas ADD COLUMN model_hub_profile_id TEXT');
    } catch {
      // column already exists
    }
    try {
      this.db.exec(
        "ALTER TABLE personas ADD COLUMN memory_persona_type TEXT NOT NULL DEFAULT 'general'",
      );
    } catch {
      // column already exists
    }
    try {
      this.db.exec('ALTER TABLE personas ADD COLUMN slug TEXT');
    } catch {
      // column already exists
    }
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_personas_slug_unique
        ON personas (slug);
    `);

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

    this.backfillPersonaSlugsAndWorkspaces();
  }

  // ─── Persona CRUD ──────────────────────────────────────────

  listPersonas(userId: string): PersonaSummary[] {
    const rows = this.db
      .prepare('SELECT * FROM personas WHERE user_id = ? ORDER BY updated_at DESC')
      .all(userId) as Array<Record<string, unknown>>;
    return rows.map(toSummary);
  }

  listAllPersonas(): PersonaSummary[] {
    const rows = this.db
      .prepare('SELECT * FROM personas ORDER BY updated_at DESC')
      .all() as Array<Record<string, unknown>>;
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
    const memoryPersonaType = input.memoryPersonaType || 'general';
    const slug = this.resolveUniqueSlugOrThrow(input.name);

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO personas (id, name, slug, emoji, vibe, preferred_model_id, model_hub_profile_id, memory_persona_type, user_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.name,
          slug,
          input.emoji,
          input.vibe,
          input.preferredModelId || null,
          input.modelHubProfileId || null,
          memoryPersonaType,
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

      ensurePersonaWorkspace(slug);
    })();

    return this.getPersona(id)!;
  }

  updatePersona(
    id: string,
    updates: {
      name?: string;
      emoji?: string;
      vibe?: string;
      preferredModelId?: string | null;
      modelHubProfileId?: string | null;
      memoryPersonaType?: MemoryPersonaType;
    },
  ): void {
    const current = this.getPersona(id);
    if (!current) return;

    const now = new Date().toISOString();
    const setClauses: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];
    let nextSlug = current.slug;
    let shouldRenameWorkspace = false;

    if (updates.name !== undefined) {
      setClauses.push('name = ?');
      values.push(updates.name);
      const candidateSlug = slugifyPersonaName(updates.name);
      if (candidateSlug !== current.slug) {
        this.assertUniquePersonaSlug(candidateSlug, id);
        nextSlug = candidateSlug;
        shouldRenameWorkspace = true;
        setClauses.push('slug = ?');
        values.push(candidateSlug);
      }
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
    if (updates.modelHubProfileId !== undefined) {
      setClauses.push('model_hub_profile_id = ?');
      values.push(updates.modelHubProfileId);
    }
    if (updates.memoryPersonaType !== undefined) {
      if (MEMORY_PERSONA_TYPES.includes(updates.memoryPersonaType)) {
        setClauses.push('memory_persona_type = ?');
        values.push(updates.memoryPersonaType);
      }
    }

    values.push(id);
    this.db.transaction(() => {
      this.db.prepare(`UPDATE personas SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
      if (shouldRenameWorkspace) {
        renamePersonaWorkspace(current.slug, nextSlug);
      } else {
        ensurePersonaWorkspace(current.slug);
      }
    })();
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
   * and for persona "Nexus" additionally includes TOOLS.md.
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

    if (persona.name.trim().toLowerCase() === NEXUS_PERSONA_NAME) {
      const toolsContent = this.getFile(personaId, 'TOOLS.md');
      if (toolsContent?.trim()) {
        parts.push(`--- TOOLS.md ---\n${toolsContent.trim()}`);
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

  private resolveUniqueSlugOrThrow(name: string): string {
    const slug = slugifyPersonaName(name);
    this.assertUniquePersonaSlug(slug);
    return slug;
  }

  private assertUniquePersonaSlug(slug: string, excludePersonaId?: string): void {
    const existing = this.db.prepare('SELECT id FROM personas WHERE slug = ? LIMIT 1').get(slug) as
      | { id: string }
      | undefined;
    if (!existing) return;
    if (excludePersonaId && existing.id === excludePersonaId) return;
    throw new Error(`Persona slug already exists: "${slug}".`);
  }

  private backfillPersonaSlugsAndWorkspaces(): void {
    const rows = this.db
      .prepare('SELECT id, name, slug FROM personas ORDER BY created_at ASC')
      .all() as Array<{ id: string; name: string; slug: string | null }>;

    const used = new Set(
      rows
        .map((row) => String(row.slug || '').trim())
        .filter((slug) => slug.length > 0),
    );

    const updateSlug = this.db.prepare('UPDATE personas SET slug = ? WHERE id = ?');
    for (const row of rows) {
      const currentSlug = String(row.slug || '').trim();
      if (currentSlug) {
        ensurePersonaWorkspace(currentSlug);
        continue;
      }

      const baseSlug = slugifyPersonaName(row.name);
      let nextSlug = baseSlug;
      let suffix = 1;
      while (used.has(nextSlug)) {
        suffix += 1;
        nextSlug = `${baseSlug}_${suffix}`;
      }

      updateSlug.run(nextSlug, row.id);
      used.add(nextSlug);
      ensurePersonaWorkspace(nextSlug);
    }
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
