import type BetterSqlite3 from 'better-sqlite3';

export type SqliteDb = ReturnType<typeof BetterSqlite3>;
export type SqlParam = string | number | null;
