import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authOptions } from '@/auth';
import { AuthUserStore } from '@/server/auth/userStore';

// next-auth's Credentials() returns a stub `authorize`; the real one lives in `options`
// and is merged over it by parseProviders at runtime.
type CredentialsProvider = {
  options: {
    authorize: (
      credentials: Record<string, string>,
      req: { headers: Record<string, unknown> },
    ) => Promise<unknown>;
  };
};

const provider = authOptions.providers[0] as unknown as CredentialsProvider;
const EMAIL = 'limit-user@local.dev';
const PASSWORD = 'limit-correct-pass';
const dbPath = path.join(os.tmpdir(), `auth-credentials-limit-${Date.now()}.db`);
let store: AuthUserStore;

function login(email: string, password: string, ip?: string): Promise<unknown> {
  return provider.options.authorize(
    { email, password },
    { headers: ip ? { 'x-forwarded-for': ip } : {} },
  );
}

beforeAll(() => {
  const keys = ['AUTH_DEFAULT_EMAIL', 'AUTH_DEFAULT_PASSWORD', 'AUTH_DEFAULT_NAME'] as const;
  const previous = keys.map((key) => process.env[key]);
  process.env.AUTH_DEFAULT_EMAIL = EMAIL;
  process.env.AUTH_DEFAULT_PASSWORD = PASSWORD;
  process.env.AUTH_DEFAULT_NAME = 'Limit User';
  store = new AuthUserStore(dbPath);
  keys.forEach((key, index) => {
    const value = previous[index];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
  globalThis.__authUserStore = store;
});

beforeEach(() => {
  delete globalThis.__loginRateLimiter;
});

afterAll(() => {
  store.close();
  delete globalThis.__authUserStore;
  delete globalThis.__loginRateLimiter;
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
});

describe('credentials login rate limiting', () => {
  it('locks an email after 10 failures, even for the correct password', async () => {
    for (let i = 0; i < 10; i += 1) {
      expect(await login(EMAIL, 'wrong-password')).toBeNull();
    }
    expect(await login(EMAIL, PASSWORD)).toBeNull();
  });

  it('gives the same null result for unknown emails and wrong passwords', async () => {
    const wrongPassword = await login(EMAIL, 'wrong-password');
    const unknownEmail = await login('ghost@local.dev', 'whatever');
    expect(wrongPassword).toBeNull();
    expect(unknownEmail).toBeNull();

    for (let i = 0; i < 9; i += 1) await login('ghost@local.dev', 'whatever');
    expect(await login('ghost@local.dev', 'whatever')).toBeNull();
  });

  it('resets the email budget after a successful login', async () => {
    for (let i = 0; i < 9; i += 1) await login(EMAIL, 'wrong-password');
    expect(await login(EMAIL, PASSWORD)).toMatchObject({ email: EMAIL });

    for (let i = 0; i < 9; i += 1) await login(EMAIL, 'wrong-password');
    expect(await login(EMAIL, PASSWORD)).toMatchObject({ email: EMAIL });
  });

  it('blocks a client IP across different emails, but not other IPs', async () => {
    for (let i = 0; i < 10; i += 1) {
      await login(`spray${i}@local.dev`, 'wrong-password', '203.0.113.50');
    }
    expect(await login(EMAIL, PASSWORD, '203.0.113.50')).toBeNull();
    expect(await login(EMAIL, PASSWORD, '198.51.100.9')).toMatchObject({ email: EMAIL });
  });
});
