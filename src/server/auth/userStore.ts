import crypto from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import { openSqliteDatabase } from '@/server/db/sqlite';

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

const publicDefaultPasswordHash = crypto.createHash('sha256').update('admin1234').digest('hex');

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derivedKey}`;
}

// Used for unknown emails so the response time does not reveal which accounts exist.
let dummyHash: string | undefined;
function getDummyHash(): string {
  dummyHash ??= hashPassword(crypto.randomBytes(16).toString('hex'));
  return dummyHash;
}

function verifyPasswordHash(
  password: string,
  storedHash: string,
): { ok: boolean; needsUpgrade: boolean } {
  // Legacy fallback for existing local dev hashes.
  if (/^[a-f0-9]{64}$/i.test(storedHash)) {
    const legacyBuffer = crypto.createHash('sha256').update(password).digest();
    const storedBuffer = Buffer.from(storedHash, 'hex');
    const ok =
      storedBuffer.length === legacyBuffer.length &&
      crypto.timingSafeEqual(storedBuffer, legacyBuffer);
    return { ok, needsUpgrade: true };
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
    this.db = openSqliteDatabase({ dbPath });
    try {
      this.migrate();
      this.ensureDefaultUser();
    } catch (error) {
      this.db.close();
      throw error;
    }
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
    const email = (process.env.AUTH_DEFAULT_EMAIL || '').trim().toLowerCase();
    const password = (process.env.AUTH_DEFAULT_PASSWORD || '').trim();
    const name = (process.env.AUTH_DEFAULT_NAME || 'Local Admin').trim();

    if (!email || !password) {
      if (email || password) {
        throw new Error('Set both AUTH_DEFAULT_EMAIL and AUTH_DEFAULT_PASSWORD.');
      }
      if (
        process.env.NODE_ENV === 'production' &&
        !this.db.prepare('SELECT 1 FROM auth_users LIMIT 1').get()
      ) {
        throw new Error(
          'Configure AUTH_DEFAULT_EMAIL and AUTH_DEFAULT_PASSWORD for the first admin.',
        );
      }
      return;
    }
    if (verifyPasswordHash(password, publicDefaultPasswordHash).ok) {
      throw new Error('The public default admin password is unsafe; choose a unique password.');
    }

    const now = new Date().toISOString();
    const existing = this.db
      .prepare('SELECT id, password_hash FROM auth_users WHERE email = ?')
      .get(email) as { id: string; password_hash: string } | undefined;
    // Explicit bootstrap credentials can recover an old default account without deleting it.
    if (existing && verifyPasswordHash('admin1234', existing.password_hash).ok) {
      this.db
        .prepare('UPDATE auth_users SET password_hash = ?, updated_at = ? WHERE id = ?')
        .run(hashPassword(password), now, existing.id);
    }
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
    if (verifyPasswordHash(password, publicDefaultPasswordHash).ok) return null;
    const normalized = email.trim().toLowerCase();
    const row = this.db
      .prepare('SELECT id, email, name, password_hash FROM auth_users WHERE email = ?')
      .get(normalized) as AuthUserRecord | undefined;

    if (!row) {
      verifyPasswordHash(password, getDummyHash());
      return null;
    }
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
