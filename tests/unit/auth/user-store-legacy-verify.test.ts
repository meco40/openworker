import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthUserStore } from '@/server/auth/userStore';

const tempDbPaths: string[] = [];

function openStore(tag: string): { store: AuthUserStore; db: BetterSqlite3.Database } {
  const dbPath = path.join(os.tmpdir(), `auth-legacy-verify-${Date.now()}-${tag}.db`);
  tempDbPaths.push(dbPath);
  const store = new AuthUserStore(dbPath);
  const db = new BetterSqlite3(dbPath);
  return { store, db };
}

function insertLegacyUser(db: BetterSqlite3.Database, email: string, password: string): void {
  const sha256Hash = crypto.createHash('sha256').update(password).digest('hex');
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO auth_users (id, email, name, password_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(`usr-${email}`, email, 'Legacy', sha256Hash, now, now);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dbPath of tempDbPaths.splice(0, tempDbPaths.length)) {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  }
});

describe('AuthUserStore legacy sha256 verification', () => {
  it('compares legacy hashes with timingSafeEqual', () => {
    const { store, db } = openStore('spy');
    insertLegacyUser(db, 'spy@local.dev', 'pw-spy');
    const spy = vi.spyOn(crypto, 'timingSafeEqual');

    expect(store.verifyCredentials('spy@local.dev', 'pw-spy')?.email).toBe('spy@local.dev');
    expect(spy).toHaveBeenCalled();

    db.close();
    store.close();
  });

  it('rejects a wrong password and does not upgrade the stored hash', () => {
    const { store, db } = openStore('wrong');
    insertLegacyUser(db, 'wrong@local.dev', 'right-password');

    expect(store.verifyCredentials('wrong@local.dev', 'wrong-password')).toBeNull();

    const row = db
      .prepare('SELECT password_hash FROM auth_users WHERE email = ?')
      .get('wrong@local.dev') as { password_hash: string };
    expect(row.password_hash).toBe(
      crypto.createHash('sha256').update('right-password').digest('hex'),
    );

    db.close();
    store.close();
  });

  it('upgrades a legacy hash to scrypt on a successful login', () => {
    const { store, db } = openStore('upgrade');
    insertLegacyUser(db, 'upgrade@local.dev', 'upgrade-pw');

    expect(store.verifyCredentials('upgrade@local.dev', 'upgrade-pw')).not.toBeNull();

    const row = db
      .prepare('SELECT password_hash FROM auth_users WHERE email = ?')
      .get('upgrade@local.dev') as { password_hash: string };
    expect(row.password_hash.startsWith('scrypt$')).toBe(true);
    expect(store.verifyCredentials('upgrade@local.dev', 'upgrade-pw')).not.toBeNull();

    db.close();
    store.close();
  });

  it('runs a password hash for unknown emails so timing does not reveal accounts', () => {
    const { store, db } = openStore('unknown');
    const spy = vi.spyOn(crypto, 'scryptSync');

    expect(store.verifyCredentials('nobody@local.dev', 'any-password')).toBeNull();
    expect(spy).toHaveBeenCalled();

    db.close();
    store.close();
  });
});
