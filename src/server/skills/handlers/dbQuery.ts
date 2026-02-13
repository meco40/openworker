import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { getRuntimeConfigValue } from '../runtimeConfig';

const MAX_RESULT_ROWS = 200;

function ensureWorkspacePath(userPath: string): string {
  const workspaceRoot = path.resolve('.');
  const resolved = path.resolve(workspaceRoot, userPath);
  if (!resolved.startsWith(workspaceRoot)) {
    throw new Error('Path escapes workspace root.');
  }
  return resolved;
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
  const db = new BetterSqlite3(resolved, { readonly: true });
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
