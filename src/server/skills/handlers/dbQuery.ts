import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { getRuntimeConfigValue } from '@/server/skills/runtimeConfig';
import { openSqliteDatabase } from '@/server/db/sqlite';
import { assertPathWithinRoot } from '@/server/security/pathBoundary';

const MAX_RESULT_ROWS = 200;
const WORKSPACE_ROOT = path.resolve('.');

function ensureWorkspacePath(userPath: string): string {
  const resolved = path.resolve(WORKSPACE_ROOT, userPath);
  return assertPathWithinRoot(resolved, WORKSPACE_ROOT);
}

export async function dbQueryHandler(args: Record<string, unknown>) {
  const query = String(args.query || '').trim();
  if (!query) throw new Error('db_query requires query.');
  if (!/^(select|with|pragma|explain)\b/i.test(query)) {
    throw new Error('Only read-only SQL statements are allowed.');
  }

  const dbPath = getRuntimeConfigValue('sql-bridge.sqlite_db_path');
  if (!dbPath) {
    throw new Error(
      'SQLite DB path missing. Configure "SQLite Database Path" in Skill Registry > Tool Configuration or set SQLITE_DB_PATH.',
    );
  }

  const resolved = ensureWorkspacePath(dbPath);
  const realPath = await realpath(resolved);
  const safeRealPath = assertPathWithinRoot(realPath, WORKSPACE_ROOT);
  const db = openSqliteDatabase({ dbPath: safeRealPath, readonly: true, enableWal: false });
  try {
    const statement = db.prepare(query);
    const rows = statement.all();
    return {
      rowCount: rows.length,
      rows: rows.slice(0, MAX_RESULT_ROWS),
      truncated: rows.length > MAX_RESULT_ROWS,
    };
  } finally {
    db.close();
  }
}
