import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import BetterSqlite3 from 'better-sqlite3';

interface AuthUserRecord {
  id: string;
  email: string;
  name: string;
  password_hash: string;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derivedKey}`;
}

function verifyPasswordHash(
  password: string,
  storedHash: string,
): { ok: boolean; needsUpgrade: boolean } {
  // Legacy fallback for existing local dev hashes.
  if (/^[a-f0-9]{64}$/i.test(storedHash)) {
    const legacyHash = crypto.createHash('sha256').update(password).digest('hex');
    return { ok: storedHash === legacyHash, needsUpgrade: true };
  }

  const [scheme, salt, derived] = storedHash.split('$');
  if (scheme !== 'scrypt' || !salt || !derived) {
    return { ok: false, needsUpgrade: false };
  }

  const candidate = crypto.scryptSync(password, salt, 64).toString('hex');
  const expectedBuffer = Buffer.from(derived, 'hex');
  const candidateBuffer = Buffer.from(candidate, 'hex');

  if (expectedBuffer.length !== candidateBuffer.length) {
    return { ok: false, needsUpgrade: false };
  }

  return {
    ok: crypto.timingSafeEqual(expectedBuffer, candidateBuffer),
    needsUpgrade: false,
  };
}

export class AuthUserStore {
  private readonly db: ReturnType<typeof BetterSqlite3>;

  constructor(dbPath = process.env.AUTH_DB_PATH || '.local/auth.db') {
    const fullPath = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    this.db = new BetterSqlite3(fullPath);
    this.migrate();
    this.ensureDefaultUser();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS auth_users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    // Auth.js-compatible tables (additive, non-destructive).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT,
        email TEXT UNIQUE,
        emailVerified TEXT,
        image TEXT
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        userId TEXT NOT NULL,
        type TEXT NOT NULL,
        provider TEXT NOT NULL,
        providerAccountId TEXT NOT NULL,
        refresh_token TEXT,
        access_token TEXT,
        expires_at INTEGER,
        token_type TEXT,
        scope TEXT,
        id_token TEXT,
        session_state TEXT,
        PRIMARY KEY (provider, providerAccountId)
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sessionToken TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        expires TEXT NOT NULL
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS verification_tokens (
        identifier TEXT NOT NULL,
        token TEXT NOT NULL,
        expires TEXT NOT NULL,
        PRIMARY KEY (identifier, token)
      );
    `);
  }

  private ensureDefaultUser(): void {
    const email = (process.env.AUTH_DEFAULT_EMAIL || 'admin@local.dev').trim().toLowerCase();
    const password = (process.env.AUTH_DEFAULT_PASSWORD || 'admin1234').trim();
    const name = (process.env.AUTH_DEFAULT_NAME || 'Local Admin').trim();

    if (!email || !password) {
      return;
    }

    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT OR IGNORE INTO auth_users (id, email, name, password_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      )
      .run(`usr-${crypto.randomUUID()}`, email, name, hashPassword(password), now, now);

    const authUser = this.db
      .prepare('SELECT id, email, name FROM auth_users WHERE email = ?')
      .get(email) as { id: string; email: string; name: string } | undefined;

    if (authUser) {
      this.db
        .prepare(
          `
          INSERT OR IGNORE INTO users (id, name, email, emailVerified, image)
          VALUES (?, ?, ?, NULL, NULL)
        `,
        )
        .run(authUser.id, authUser.name, authUser.email);
    }
  }

  verifyCredentials(email: string, password: string): AuthUser | null {
    const normalized = email.trim().toLowerCase();
    const row = this.db
      .prepare('SELECT id, email, name, password_hash FROM auth_users WHERE email = ?')
      .get(normalized) as AuthUserRecord | undefined;

    if (!row) return null;
    const verification = verifyPasswordHash(password, row.password_hash);
    if (!verification.ok) return null;

    if (verification.needsUpgrade) {
      const now = new Date().toISOString();
      this.db
        .prepare('UPDATE auth_users SET password_hash = ?, updated_at = ? WHERE id = ?')
        .run(hashPassword(password), now, row.id);
    }

    return {
      id: row.id,
      email: row.email,
      name: row.name,
    };
  }

  close(): void {
    this.db.close();
  }
}

declare global {
  var __authUserStore: AuthUserStore | undefined;
}

export function getAuthUserStore(): AuthUserStore {
  if (!globalThis.__authUserStore) {
    globalThis.__authUserStore = new AuthUserStore();
  }
  return globalThis.__authUserStore;
}
