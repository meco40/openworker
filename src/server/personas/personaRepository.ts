import type BetterSqlite3 from 'better-sqlite3';
import type {
  CreatePersonaInput,
  MemoryPersonaType,
  PersonaFileName,
  PersonaProfile,
  PersonaSummary,
  SystemPersonaKey,
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
  ensurePersonaFiles,
  ensurePersonaWorkspace,
  readPersonaFile,
  removePersonaWorkspace,
  renamePersonaWorkspace,
  slugifyPersonaName,
  writePersonaFile,
} from '@/server/personas/personaWorkspace';

// ─── Row mappers ─────────────────────────────────────────────

function toPersona(row: Record<string, unknown>): PersonaProfile {
  return {
    id: row.id as string,
    name: row.name as string,
    slug: (row.slug as string) || slugifyPersonaName(String(row.name || 'persona')),
    emoji: row.emoji as string,
    vibe: row.vibe as string,
    systemPersonaKey: (row.system_persona_key as SystemPersonaKey) || null,
    preferredModelId: (row.preferred_model_id as string) || null,
    modelHubProfileId: (row.model_hub_profile_id as string) || null,
    memoryPersonaType: ((row.memory_persona_type as string) || 'general') as MemoryPersonaType,
    isAutonomous: Boolean(row.is_autonomous),
    maxToolCalls: typeof row.max_tool_calls === 'number' ? row.max_tool_calls : 120,
    allowedToolFunctionNames: [],
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
    systemPersonaKey: (row.system_persona_key as SystemPersonaKey) || null,
    preferredModelId: (row.preferred_model_id as string) || null,
    modelHubProfileId: (row.model_hub_profile_id as string) || null,
    memoryPersonaType: ((row.memory_persona_type as string) || 'general') as MemoryPersonaType,
    isAutonomous: Boolean(row.is_autonomous),
    maxToolCalls: typeof row.max_tool_calls === 'number' ? row.max_tool_calls : 120,
    allowedToolFunctionNames: [],
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
        system_persona_key TEXT,
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
    try {
      this.db.exec('ALTER TABLE personas ADD COLUMN is_autonomous INTEGER NOT NULL DEFAULT 0');
    } catch {
      // column already exists
    }
    try {
      this.db.exec('ALTER TABLE personas ADD COLUMN max_tool_calls INTEGER NOT NULL DEFAULT 120');
    } catch {
      // column already exists
    }
    try {
      this.db.exec('ALTER TABLE personas ADD COLUMN system_persona_key TEXT');
    } catch {
      // column already exists
    }
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_personas_slug_unique
        ON personas (slug);
    `);
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_personas_user_system_key_unique
        ON personas (user_id, system_persona_key)
        WHERE system_persona_key IS NOT NULL;
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_personas_user
        ON personas (user_id, updated_at DESC);
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS persona_tool_permissions (
        persona_id TEXT NOT NULL,
        function_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (persona_id, function_name)
      );
    `);

    this.backfillPersonaSlugsAndWorkspaces();
    this.migratePersonaFilesToFilesystem();
  }

  // ─── Persona CRUD ──────────────────────────────────────────

  listPersonas(userId: string): PersonaSummary[] {
    const rows = this.db
      .prepare('SELECT * FROM personas WHERE user_id = ? ORDER BY updated_at DESC')
      .all(userId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.attachAllowedToolFunctions(toSummary(row)));
  }

  listAllPersonas(): PersonaSummary[] {
    const rows = this.db.prepare('SELECT * FROM personas ORDER BY updated_at DESC').all() as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => this.attachAllowedToolFunctions(toSummary(row)));
  }

  getPersona(id: string): PersonaProfile | null {
    const row = this.db.prepare('SELECT * FROM personas WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.attachAllowedToolFunctions(toPersona(row)) : null;
  }

  getSystemPersona(userId: string, key: SystemPersonaKey): PersonaProfile | null {
    const row = this.db
      .prepare('SELECT * FROM personas WHERE user_id = ? AND system_persona_key = ? LIMIT 1')
      .get(userId, key) as Record<string, unknown> | undefined;
    return row ? this.attachAllowedToolFunctions(toPersona(row)) : null;
  }

  getPersonaWithFiles(id: string): PersonaWithFiles | null {
    const persona = this.getPersona(id);
    if (!persona) return null;

    const files: Partial<Record<PersonaFileName, string>> = {};
    for (const filename of PERSONA_FILE_NAMES) {
      files[filename] = readPersonaFile(persona.slug, filename) ?? '';
    }

    return { ...persona, files };
  }

  createPersona(input: CreatePersonaInput): PersonaProfile {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const memoryPersonaType = input.memoryPersonaType || 'general';
    const slug = this.resolveUniqueSlugOrThrow(input.name);
    const systemPersonaKey = input.systemPersonaKey || null;
    const allowedToolFunctionNames = normalizeAllowedToolFunctionNames(
      input.allowedToolFunctionNames,
    );

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO personas (id, name, slug, emoji, vibe, system_persona_key, preferred_model_id, model_hub_profile_id, memory_persona_type, is_autonomous, max_tool_calls, user_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.name,
          slug,
          input.emoji,
          input.vibe,
          systemPersonaKey,
          input.preferredModelId || null,
          input.modelHubProfileId || null,
          memoryPersonaType,
          input.isAutonomous ? 1 : 0,
          typeof input.maxToolCalls === 'number' ? input.maxToolCalls : 120,
          input.userId,
          now,
          now,
        );
      this.replaceAllowedToolFunctionNames(id, allowedToolFunctionNames, now);
    })();
    ensurePersonaFiles(slug, input.files);

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
      isAutonomous?: boolean;
      maxToolCalls?: number;
    },
  ): void {
    const current = this.getPersona(id);
    if (!current) return;
    this.assertSystemPersonaMutationAllowed(current, updates);

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
    if (updates.isAutonomous !== undefined) {
      setClauses.push('is_autonomous = ?');
      values.push(updates.isAutonomous ? 1 : 0);
    }
    if (updates.maxToolCalls !== undefined) {
      const clamped = Math.max(3, Math.min(500, Math.floor(updates.maxToolCalls)));
      setClauses.push('max_tool_calls = ?');
      values.push(clamped);
    }

    values.push(id);
    this.db.transaction(() => {
      this.db.prepare(`UPDATE personas SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
      if (shouldRenameWorkspace) {
        renamePersonaWorkspace(current.slug, nextSlug);
      } else {
        ensurePersonaFiles(current.slug);
      }
    })();
  }

  deletePersona(id: string): boolean {
    const existing = this.getPersona(id);
    if (!existing) return false;
    if (existing.systemPersonaKey) {
      throw new Error('Cannot delete a system persona.');
    }

    const result = this.db.prepare('DELETE FROM personas WHERE id = ?').run(id);
    if (result.changes > 0) {
      removePersonaWorkspace(existing.slug);
    }
    return result.changes > 0;
  }

  // ─── File CRUD ─────────────────────────────────────────────

  getFile(personaId: string, filename: PersonaFileName): string | null {
    const persona = this.getPersona(personaId);
    if (!persona) return null;
    return readPersonaFile(persona.slug, filename);
  }

  saveFile(personaId: string, filename: PersonaFileName, content: string): void {
    const persona = this.getPersona(personaId);
    if (!persona) return;

    const now = new Date().toISOString();
    writePersonaFile(persona.slug, filename, content);

    // Touch parent updated_at
    this.db.prepare('UPDATE personas SET updated_at = ? WHERE id = ?').run(now, personaId);
  }

  // ─── System Instruction Composition ─────────────────────────

  /**
   * Composes the system instruction from SOUL.md + AGENTS.md + USER.md.
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

  setAllowedToolFunctionNames(personaId: string, functionNames: string[]): void {
    const persona = this.getPersona(personaId);
    if (!persona) return;
    const now = new Date().toISOString();
    this.replaceAllowedToolFunctionNames(
      personaId,
      normalizeAllowedToolFunctionNames(functionNames),
      now,
    );
    this.db.prepare('UPDATE personas SET updated_at = ? WHERE id = ?').run(now, personaId);
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

  private attachAllowedToolFunctions<T extends PersonaProfile | PersonaSummary>(persona: T): T {
    return {
      ...persona,
      allowedToolFunctionNames: this.listAllowedToolFunctionNames(persona.id),
    };
  }

  private listAllowedToolFunctionNames(personaId: string): string[] {
    const rows = this.db
      .prepare(
        'SELECT function_name FROM persona_tool_permissions WHERE persona_id = ? ORDER BY function_name ASC',
      )
      .all(personaId) as Array<{ function_name: string }>;
    return rows.map((row) => row.function_name);
  }

  private replaceAllowedToolFunctionNames(
    personaId: string,
    functionNames: string[],
    now: string,
  ): void {
    this.db.prepare('DELETE FROM persona_tool_permissions WHERE persona_id = ?').run(personaId);
    const insertPermission = this.db.prepare(
      `INSERT INTO persona_tool_permissions (persona_id, function_name, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    );
    for (const functionName of functionNames) {
      insertPermission.run(personaId, functionName, now, now);
    }
  }

  private assertSystemPersonaMutationAllowed(
    persona: PersonaProfile,
    updates: {
      name?: string;
      emoji?: string;
      vibe?: string;
      preferredModelId?: string | null;
      modelHubProfileId?: string | null;
      memoryPersonaType?: MemoryPersonaType;
      isAutonomous?: boolean;
      maxToolCalls?: number;
    },
  ): void {
    if (!persona.systemPersonaKey) return;
    if (updates.name !== undefined) {
      throw new Error('Cannot rename a system persona.');
    }
  }

  private backfillPersonaSlugsAndWorkspaces(): void {
    const rows = this.db
      .prepare('SELECT id, name, slug FROM personas ORDER BY created_at ASC')
      .all() as Array<{ id: string; name: string; slug: string | null }>;

    const used = new Set(
      rows.map((row) => String(row.slug || '').trim()).filter((slug) => slug.length > 0),
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

  private migratePersonaFilesToFilesystem(): void {
    const personas = this.db.prepare('SELECT id, slug FROM personas').all() as Array<{
      id: string;
      slug: string | null;
    }>;
    const hasLegacyTable = Boolean(
      this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'persona_files'")
        .get(),
    );
    if (!hasLegacyTable) {
      for (const persona of personas) {
        const slug = String(persona.slug || '').trim();
        if (!slug) continue;
        ensurePersonaFiles(slug);
      }
      return;
    }

    const legacyRows = this.db
      .prepare('SELECT persona_id, filename, content FROM persona_files')
      .all() as Array<{ persona_id: string; filename: string; content: string }>;

    const legacyByPersonaId = new Map<string, Partial<Record<PersonaFileName, string>>>();
    for (const row of legacyRows) {
      if (!PERSONA_FILE_NAMES.includes(row.filename as PersonaFileName)) {
        continue;
      }
      const existing = legacyByPersonaId.get(row.persona_id) || {};
      existing[row.filename as PersonaFileName] = row.content;
      legacyByPersonaId.set(row.persona_id, existing);
    }

    for (const persona of personas) {
      const slug = String(persona.slug || '').trim();
      if (!slug) continue;
      const legacyFiles = legacyByPersonaId.get(persona.id);
      ensurePersonaFiles(slug, legacyFiles);

      if (!legacyFiles) continue;
      for (const filename of PERSONA_FILE_NAMES) {
        const legacyContent = legacyFiles[filename];
        if (typeof legacyContent !== 'string' || legacyContent.length === 0) {
          continue;
        }

        const currentContent = readPersonaFile(slug, filename);
        if (currentContent !== null && currentContent.trim().length === 0) {
          writePersonaFile(slug, filename, legacyContent);
        }
      }
    }

    this.db.exec('DROP TABLE IF EXISTS persona_files');
  }
}

function normalizeAllowedToolFunctionNames(functionNames?: string[]): string[] {
  if (!Array.isArray(functionNames)) return [];
  return [
    ...new Set(functionNames.map((value) => String(value || '').trim()).filter(Boolean)),
  ].sort((left, right) => left.localeCompare(right));
}

// ─── Singleton ───────────────────────────────────────────────

let _instance: PersonaRepository | null = null;

export function getPersonaRepository(): PersonaRepository {
  if (!_instance) {
    _instance = new PersonaRepository();
  }
  return _instance;
}
