import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MAX_RESULT_ROWS = 200;

function ensureWorkspacePath(userPath: string): string {
  const workspaceRoot = process.cwd();
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

  const dbPath = process.env.SQLITE_DB_PATH;
  if (!dbPath) {
    throw new Error('SQLITE_DB_PATH is not configured.');
  }

  const resolved = ensureWorkspacePath(dbPath);
  const db = new DatabaseSync(resolved, { readOnly: true });
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
