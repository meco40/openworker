import type BetterSqlite3 from 'better-sqlite3';
import { maskSecret } from '@/server/model-hub/crypto';
import { openSqliteDatabase } from '@/server/db/sqlite';

type ConfigValueKind = 'secret' | 'text';
type ConfigSource = 'store' | 'env' | null;

export interface SkillRuntimeConfigField {
  id: string;
  skillId: string;
  label: string;
  description: string;
  kind: ConfigValueKind;
  required: boolean;
  envVars: string[];
}

export interface SkillRuntimeConfigStatus extends SkillRuntimeConfigField {
  configured: boolean;
  source: ConfigSource;
  maskedValue: string | null;
  updatedAt: string | null;
}

interface StoredConfigRow {
  id: string;
  value: string;
  updated_at: string;
}

export const SKILL_RUNTIME_CONFIG_FIELDS: SkillRuntimeConfigField[] = [
  {
    id: 'vision.gemini_api_key',
    skillId: 'vision',
    label: 'Vision (Gemini) API Key',
    description: 'Required for image analysis in the Vision skill.',
    kind: 'secret',
    required: true,
    envVars: ['GEMINI_API_KEY', 'API_KEY'],
  },
  {
    id: 'github-manager.github_token',
    skillId: 'github-manager',
    label: 'GitHub Token',
    description: 'Optional. Increases API limits and allows private repository access.',
    kind: 'secret',
    required: false,
    envVars: ['GITHUB_TOKEN'],
  },
  {
    id: 'sql-bridge.sqlite_db_path',
    skillId: 'sql-bridge',
    label: 'SQLite Database Path',
    description: 'Required for SQL Bridge queries (workspace-relative path).',
    kind: 'text',
    required: true,
    envVars: ['SQLITE_DB_PATH'],
  },
];

const FIELD_BY_ID = new Map(SKILL_RUNTIME_CONFIG_FIELDS.map((field) => [field.id, field]));

function ensureKnownFieldId(id: string): SkillRuntimeConfigField {
  const field = FIELD_BY_ID.get(id);
  if (!field) {
    throw new Error(`Unsupported runtime config id: ${id}`);
  }
  return field;
}

function maskValue(kind: ConfigValueKind, value: string): string {
  if (kind === 'secret') {
    return maskSecret(value);
  }
  if (value.length <= 8) {
    return value;
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function readEnvValue(
  field: SkillRuntimeConfigField,
  env: Record<string, string | undefined>,
): string | null {
  for (const key of field.envVars) {
    const value = String(env[key] || '').trim();
    if (value) {
      return value;
    }
  }
  return null;
}

export class SkillRuntimeConfigStore {
  private readonly db: BetterSqlite3.Database;

  constructor(dbPath = process.env.SKILLS_DB_PATH || '.local/skills.db') {
    this.db = openSqliteDatabase({ dbPath });

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skill_runtime_config (
        id TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  setValue(id: string, value: string): void {
    ensureKnownFieldId(id);
    const normalized = value.trim();
    if (!normalized) {
      throw new Error('Runtime config value cannot be empty.');
    }
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO skill_runtime_config (id, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(id, normalized, now);
  }

  deleteValue(id: string): void {
    ensureKnownFieldId(id);
    this.db.prepare('DELETE FROM skill_runtime_config WHERE id = ?').run(id);
  }

  getValue(id: string): string | null {
    ensureKnownFieldId(id);
    const row = this.db.prepare('SELECT value FROM skill_runtime_config WHERE id = ?').get(id) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  getUpdatedAt(id: string): string | null {
    ensureKnownFieldId(id);
    const row = this.db
      .prepare('SELECT updated_at FROM skill_runtime_config WHERE id = ?')
      .get(id) as { updated_at: string } | undefined;
    return row?.updated_at ?? null;
  }

  list(): Array<{ id: string; value: string; updatedAt: string }> {
    const rows = this.db
      .prepare('SELECT id, value, updated_at FROM skill_runtime_config ORDER BY id')
      .all() as StoredConfigRow[];
    return rows.map((row) => ({
      id: row.id,
      value: row.value,
      updatedAt: row.updated_at,
    }));
  }
}

declare global {
  var __skillRuntimeConfigStore: SkillRuntimeConfigStore | undefined;
}

export function getSkillRuntimeConfigStore(): SkillRuntimeConfigStore {
  if (!globalThis.__skillRuntimeConfigStore) {
    globalThis.__skillRuntimeConfigStore = new SkillRuntimeConfigStore();
  }
  return globalThis.__skillRuntimeConfigStore;
}

export function getRuntimeConfigCatalog(): SkillRuntimeConfigField[] {
  return SKILL_RUNTIME_CONFIG_FIELDS.map((field) => ({ ...field }));
}

export function getRuntimeConfigValue(
  id: string,
  options?: {
    store?: SkillRuntimeConfigStore;
    env?: Record<string, string | undefined>;
  },
): string | null {
  const field = ensureKnownFieldId(id);
  const store = options?.store ?? getSkillRuntimeConfigStore();
  const env = options?.env ?? process.env;

  const stored = String(store.getValue(field.id) || '').trim();
  if (stored) {
    return stored;
  }
  return readEnvValue(field, env);
}

export function resolveSkillRuntimeConfigStatus(
  store: SkillRuntimeConfigStore = getSkillRuntimeConfigStore(),
  env: Record<string, string | undefined> = process.env,
): SkillRuntimeConfigStatus[] {
  return SKILL_RUNTIME_CONFIG_FIELDS.map((field) => {
    const stored = String(store.getValue(field.id) || '').trim();
    const envValue = readEnvValue(field, env);
    const effective = stored || envValue || '';

    let source: ConfigSource = null;
    if (stored) source = 'store';
    else if (envValue) source = 'env';

    return {
      ...field,
      configured: Boolean(effective),
      source,
      maskedValue: effective ? maskValue(field.kind, effective) : null,
      updatedAt: source === 'store' ? store.getUpdatedAt(field.id) : null,
    };
  });
}
