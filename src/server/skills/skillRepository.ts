/**
 * SQLite-based skill persistence.
 *
 * Stores skill metadata (name, tool definition, installed flag, source)
 * so that activation state survives page reloads and server restarts.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { SkillToolDefinition } from '../../shared/toolSchema';
import type { BuiltInSkillSeed } from './builtInSkills';

// ── Row types ────────────────────────────────────────────────────

export interface SkillRow {
  id: string;
  name: string;
  description: string;
  category: string;
  version: string;
  installed: boolean;
  functionName: string;
  source: 'built-in' | 'github' | 'npm' | 'manual';
  sourceUrl: string | null;
  toolDefinition: SkillToolDefinition;
  handlerPath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InstallSkillInput {
  id?: string;
  name: string;
  description: string;
  category: string;
  version: string;
  functionName: string;
  source: 'github' | 'npm' | 'manual';
  sourceUrl?: string;
  toolDefinition: SkillToolDefinition;
  handlerPath?: string;
}

// ── Repository ───────────────────────────────────────────────────

function toRow(raw: Record<string, unknown>): SkillRow {
  return {
    id: String(raw.id),
    name: String(raw.name),
    description: String(raw.description),
    category: String(raw.category),
    version: String(raw.version),
    installed: Boolean(raw.installed),
    functionName: String(raw.function_name),
    source: String(raw.source) as SkillRow['source'],
    sourceUrl: raw.source_url ? String(raw.source_url) : null,
    toolDefinition: JSON.parse(String(raw.tool_definition)) as SkillToolDefinition,
    handlerPath: raw.handler_path ? String(raw.handler_path) : null,
    createdAt: String(raw.created_at),
    updatedAt: String(raw.updated_at),
  };
}

export class SkillRepository {
  private readonly db: DatabaseSync;

  constructor(dbPath = process.env.SKILLS_DB_PATH || '.local/skills.db') {
    const fullPath = path.isAbsolute(dbPath) ? dbPath : path.join(process.cwd(), dbPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    this.db = new DatabaseSync(fullPath);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        category TEXT NOT NULL,
        version TEXT NOT NULL,
        installed INTEGER NOT NULL DEFAULT 0,
        function_name TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'built-in',
        source_url TEXT,
        tool_definition TEXT NOT NULL,
        handler_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  // ── Seed ─────────────────────────────────────────────────────

  /**
   * Seed built-in skills.  Only INSERTs skills whose id does not yet
   * exist, so user toggle state is never overwritten.
   */
  seedBuiltIns(seeds: BuiltInSkillSeed[]): void {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO skills (
        id, name, description, category, version,
        installed, function_name, source, source_url,
        tool_definition, handler_path, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'built-in', NULL, ?, NULL, ?, ?)
    `);

    const now = new Date().toISOString();
    for (const seed of seeds) {
      const m = seed.manifest;
      insert.run(
        m.id,
        m.name,
        m.description,
        m.category,
        m.version,
        seed.installedByDefault ? 1 : 0,
        m.functionName,
        JSON.stringify(m.tool),
        now,
        now,
      );
    }
  }

  // ── CRUD ─────────────────────────────────────────────────────

  listSkills(): SkillRow[] {
    const rows = this.db.prepare('SELECT * FROM skills ORDER BY created_at ASC').all() as Record<
      string,
      unknown
    >[];
    return rows.map(toRow);
  }

  getSkill(id: string): SkillRow | null {
    const row = this.db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toRow(row) : null;
  }

  setInstalled(id: string, installed: boolean): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare('UPDATE skills SET installed = ?, updated_at = ? WHERE id = ?')
      .run(installed ? 1 : 0, now, id) as { changes: number };
    return result.changes > 0;
  }

  installSkill(input: InstallSkillInput): SkillRow {
    const id = input.id || crypto.randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `
        INSERT INTO skills (
          id, name, description, category, version,
          installed, function_name, source, source_url,
          tool_definition, handler_path, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        id,
        input.name,
        input.description,
        input.category,
        input.version,
        input.functionName,
        input.source,
        input.sourceUrl ?? null,
        JSON.stringify(input.toolDefinition),
        input.handlerPath ?? null,
        now,
        now,
      );

    return this.getSkill(id)!;
  }

  removeSkill(id: string): boolean {
    const result = this.db.prepare('DELETE FROM skills WHERE id = ?').run(id) as {
      changes: number;
    };
    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}

// ── Singleton (lazy) ─────────────────────────────────────────────

let _instance: SkillRepository | null = null;
let _seeded = false;

export async function getSkillRepository(): Promise<SkillRepository> {
  if (!_instance) {
    _instance = new SkillRepository();
  }
  if (!_seeded) {
    const { BUILT_IN_SKILLS } = await import('./builtInSkills');
    _instance.seedBuiltIns(BUILT_IN_SKILLS);
    _seeded = true;
  }
  return _instance;
}
