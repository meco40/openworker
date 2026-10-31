import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthUserStore } from '@/server/auth/userStore';

const tempDbPaths: string[] = [];

function withAuthEnv(
  values: {
    email?: string;
    password?: string;
    name?: string;
  },
  fn: () => void,
): void {
  const prevEmail = process.env.AUTH_DEFAULT_EMAIL;
  const prevPassword = process.env.AUTH_DEFAULT_PASSWORD;
  const prevName = process.env.AUTH_DEFAULT_NAME;

  if (values.email === undefined) {
    delete process.env.AUTH_DEFAULT_EMAIL;
  } else {
    process.env.AUTH_DEFAULT_EMAIL = values.email;
  }

  if (values.password === undefined) {
    delete process.env.AUTH_DEFAULT_PASSWORD;
  } else {
    process.env.AUTH_DEFAULT_PASSWORD = values.password;
  }

  if (values.name === undefined) {
    delete process.env.AUTH_DEFAULT_NAME;
  } else {
    process.env.AUTH_DEFAULT_NAME = values.name;
  }

  try {
    fn();
  } finally {
    if (prevEmail === undefined) {
      delete process.env.AUTH_DEFAULT_EMAIL;
    } else {
      process.env.AUTH_DEFAULT_EMAIL = prevEmail;
    }

    if (prevPassword === undefined) {
      delete process.env.AUTH_DEFAULT_PASSWORD;
    } else {
      process.env.AUTH_DEFAULT_PASSWORD = prevPassword;
    }

    if (prevName === undefined) {
      delete process.env.AUTH_DEFAULT_NAME;
    } else {
      process.env.AUTH_DEFAULT_NAME = prevName;
    }
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dbPath of tempDbPaths.splice(0, tempDbPaths.length)) {
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
  }
});

describe('AuthUserStore', () => {
  it('does not create an implicit admin in development', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const dbPath = path.join(os.tmpdir(), `auth-user-store-${crypto.randomUUID()}.db`);
    tempDbPaths.push(dbPath);
    withAuthEnv({}, () => {
      const store = new AuthUserStore(dbPath);
      const db = new BetterSqlite3(dbPath);
      expect(db.prepare('SELECT id FROM auth_users').all()).toEqual([]);
      db.close();
      store.close();
    });
  });

  it('requires explicit credentials for the first production admin', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const dbPath = path.join(os.tmpdir(), `auth-user-store-${crypto.randomUUID()}.db`);
    tempDbPaths.push(dbPath);
    withAuthEnv({}, () => {
      expect(() => new AuthUserStore(dbPath)).toThrow('for the first admin');
    });
  });

  it.each([
    {
      credentials: { email: 'admin@example.test', password: '' },
      message: 'Set both AUTH_DEFAULT_EMAIL and AUTH_DEFAULT_PASSWORD.',
    },
    {
      credentials: { email: '', password: 'unique-bootstrap-password' },
      message: 'Set both AUTH_DEFAULT_EMAIL and AUTH_DEFAULT_PASSWORD.',
    },
    {
      credentials: { email: 'admin@example.test', password: 'admin1234' },
      message: 'The public default admin password is unsafe; choose a unique password.',
    },
  ])('rejects incomplete or publicly known bootstrap credentials', ({ credentials, message }) => {
    const dbPath = path.join(os.tmpdir(), `auth-user-store-${crypto.randomUUID()}.db`);
    tempDbPaths.push(dbPath);
    withAuthEnv(credentials, () => expect(() => new AuthUserStore(dbPath)).toThrow(message));
  });

  it('blocks an old default password and recovers that account with explicit credentials', () => {
    const dbPath = path.join(os.tmpdir(), `auth-user-store-${crypto.randomUUID()}.db`);
    tempDbPaths.push(dbPath);
    withAuthEnv({}, () => {
      const store = new AuthUserStore(dbPath);
      const db = new BetterSqlite3(dbPath);
      const now = new Date().toISOString();
      db.prepare('INSERT INTO auth_users VALUES (?, ?, ?, ?, ?, ?)').run(
        'old-admin',
        'admin@local.dev',
        'Old Admin',
        crypto.createHash('sha256').update('admin1234').digest('hex'),
        now,
        now,
      );
      expect(store.verifyCredentials('admin@local.dev', 'admin1234')).toBeNull();
      db.close();
      store.close();
    });
    withAuthEnv({ email: 'admin@local.dev', password: 'unique-bootstrap-password' }, () => {
      const store = new AuthUserStore(dbPath);
      expect(store.verifyCredentials('admin@local.dev', 'unique-bootstrap-password')?.id).toBe(
        'old-admin',
      );
      expect(store.verifyCredentials('admin@local.dev', 'admin1234')).toBeNull();
      store.close();
    });
  });

  it('stores default user password with a scrypt hash format', () => {
    const dbPath = path.join(os.tmpdir(), `auth-user-store-${Date.now()}-a.db`);
    tempDbPaths.push(dbPath);

    withAuthEnv(
      {
        email: 'security-test@local.dev',
        password: 'Secur3Password!',
        name: 'Security Test',
      },
      () => {
        const store = new AuthUserStore(dbPath);

        const reader = new BetterSqlite3(dbPath);
        const row = reader
          .prepare('SELECT password_hash FROM auth_users WHERE email = ?')
          .get('security-test@local.dev') as { password_hash: string };

        expect(row.password_hash.startsWith('scrypt$')).toBe(true);

        reader.close();
        (store as unknown as { close?: () => void }).close?.();
        vi.stubEnv('NODE_ENV', 'production');
        withAuthEnv({}, () => {
          const reopened = new AuthUserStore(dbPath);
          expect(
            reopened.verifyCredentials('security-test@local.dev', 'Secur3Password!'),
          ).not.toBeNull();
          reopened.close();
        });
      },
    );
  });

  it('accepts legacy sha256 credentials and upgrades stored hash', () => {
    const dbPath = path.join(os.tmpdir(), `auth-user-store-${Date.now()}-b.db`);
    tempDbPaths.push(dbPath);

    withAuthEnv(
      {
        email: '',
        password: '',
        name: '',
      },
      () => {
        const store = new AuthUserStore(dbPath);
        const db = new BetterSqlite3(dbPath);

        const password = 'legacy-password';
        const sha256Hash = crypto.createHash('sha256').update(password).digest('hex');
        const now = new Date().toISOString();

        db.prepare(
          `
          INSERT INTO auth_users (id, email, name, password_hash, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `,
        ).run('usr-legacy', 'legacy@local.dev', 'Legacy User', sha256Hash, now, now);

        const verified = store.verifyCredentials('legacy@local.dev', password);
        expect(verified?.id).toBe('usr-legacy');

        const upgraded = db
          .prepare('SELECT password_hash FROM auth_users WHERE id = ?')
          .get('usr-legacy') as { password_hash: string };

        expect(upgraded.password_hash.startsWith('scrypt$')).toBe(true);

        db.close();
        (store as unknown as { close?: () => void }).close?.();
      },
    );
  });
});
