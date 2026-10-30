/** Real next-auth + application authorize callback versus the Rust auth routes. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { AuthHandler, serialize } from '../../../fixtures/nextauth.mjs';
import { check, checkTrue, rustRequest } from '../harness.mjs';
export const name = 'auth';
function cookiePair(value) {
  return value.split(';')[0];
}
function updateJar(jar, cookies) {
  for (const cookie of cookies) {
    const pair = cookiePair(cookie),
      index = pair.indexOf('=');
    jar.set(pair.slice(0, index), pair.slice(index + 1));
  }
}
function sessionCookie(cookies) {
  return cookies
    .map(cookiePair)
    .find((value) => /^(?:__Secure-)?next-auth\.session-token(?:\.\d+)?=/.test(value));
}
function cookieHeader(jar, override) {
  const cookies = new Map(jar);
  if (override) {
    for (const name of cookies.keys()) if (/session-token/.test(name)) cookies.delete(name);
    const split = override.indexOf('=');
    cookies.set(override.slice(0, split), override.slice(split + 1));
  }
  return [...cookies].map(([k, v]) => k + '=' + v).join('; ');
}
export async function run() {
  const email = process.env.AUTH_DEFAULT_EMAIL,
    password = process.env.AUTH_DEFAULT_PASSWORD;
  if (!email || !password)
    throw new Error(
      'Auth parity requires the isolated AUTH_DEFAULT_EMAIL/PASSWORD supplied to the Rust gateway.',
    );
  const scratch = mkdtempSync(join(tmpdir(), 'auth-parity-'));
  const previous = process.env.AUTH_DB_PATH;
  process.env.AUTH_DB_PATH = join(scratch, 'auth.db');
  const { authOptions } = createRequire(import.meta.url)('../../../../src/auth.ts');
  const base = (process.env.NEXTAUTH_URL || 'http://localhost:3000').replace(/\/$/, '');
  const rustJar = new Map(),
    tsJar = new Map();
  const rust = async (method, path, body, cookie) => {
    const response = await rustRequest(method, path, {
      body,
      headers: { cookie: cookieHeader(rustJar, cookie) },
    });
    updateJar(rustJar, response.setCookies);
    return response;
  };
  const reference = async (method, path, body, cookie) => {
    const response = await AuthHandler({
      req: new Request(base + path, {
        method,
        headers: {
          host: new URL(base).host,
          'content-type': 'application/json',
          cookie: cookieHeader(tsJar, cookie),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      options: authOptions,
    });
    const setCookies = (response.cookies || []).map((c) => serialize(c.name, c.value, c.options));
    updateJar(tsJar, setCookies);
    return {
      status: response.status ?? 200,
      json: response.redirect ? { url: response.redirect } : response.body,
      setCookies,
    };
  };
  try {
    const providers = await reference('GET', '/api/auth/providers');
    check(
      'providers: real NextAuth versus Rust',
      (await rust('GET', '/api/auth/providers')).json,
      providers.json,
    );
    const tsCsrf = await reference('GET', '/api/auth/csrf'),
      rustCsrf = await rust('GET', '/api/auth/csrf');
    for (const [label, response] of [
      ['TS', tsCsrf],
      ['Rust', rustCsrf],
    ])
      checkTrue(
        label + ' issues token and serialized CSRF cookie',
        /^[a-f0-9]{64}$/.test(response.json.csrfToken) &&
          response.setCookies.some((c) => /csrf-token=/.test(c)),
      );
    check(
      'anonymous session',
      (await rust('GET', '/api/auth/session')).json,
      (await reference('GET', '/api/auth/session')).json,
    );
    const form = (csrfToken, pass = password) => ({
      email,
      password: pass,
      csrfToken,
      callbackUrl: base + '/',
      json: 'true',
    });
    const tsLogin = await reference(
      'POST',
      '/api/auth/callback/credentials',
      form(tsCsrf.json.csrfToken),
    );
    const rustLogin = await rust(
      'POST',
      '/api/auth/callback/credentials',
      form(rustCsrf.json.csrfToken),
    );
    check('successful login status', rustLogin.status, tsLogin.status);
    check('successful login URL', rustLogin.json, tsLogin.json);
    const tsCookie = sessionCookie(tsLogin.setCookies),
      rustCookie = sessionCookie(rustLogin.setCookies);
    checkTrue('both logins issue session cookies', Boolean(tsCookie && rustCookie));
    if (!tsCookie || !rustCookie) throw new Error('Successful login did not issue both cookies.');
    for (const [label, cookie] of [
      ['TS cookie', tsCookie],
      ['Rust cookie', rustCookie],
    ]) {
      const a = await reference('GET', '/api/auth/session', undefined, cookie),
        b = await rust('GET', '/api/auth/session', undefined, cookie);
      check(label + ' accepted by both implementations', b.json.user, a.json.user);
    }
    const badCsrf = { ...form('invalid'), json: 'true' };
    const a = await reference('POST', '/api/auth/callback/credentials', badCsrf),
      b = await rust('POST', '/api/auth/callback/credentials', badCsrf);
    check('invalid CSRF status', b.status, a.status);
    check('invalid CSRF redirect', b.json, a.json);
    for (let attempt = 1; attempt <= 10; attempt++) {
      const a = await reference(
        'POST',
        '/api/auth/callback/credentials',
        form(tsCsrf.json.csrfToken, 'wrong-parity-password'),
      );
      const b = await rust(
        'POST',
        '/api/auth/callback/credentials',
        form(rustCsrf.json.csrfToken, 'wrong-parity-password'),
      );
      check('bad password ' + attempt + ' status', b.status, a.status);
      check('bad password ' + attempt + ' URL', b.json, a.json);
    }
    const blockedTs = await reference(
      'POST',
      '/api/auth/callback/credentials',
      form(tsCsrf.json.csrfToken),
    );
    const blockedRust = await rust(
      'POST',
      '/api/auth/callback/credentials',
      form(rustCsrf.json.csrfToken),
    );
    check('correct password remains locked out', blockedRust.status, blockedTs.status);
    checkTrue(
      'lockout is a credential failure',
      blockedRust.status === 401 && blockedTs.status === 401,
    );
    const outTs = await reference('POST', '/api/auth/signout', {
      csrfToken: tsCsrf.json.csrfToken,
      json: 'true',
    });
    const outRust = await rust('POST', '/api/auth/signout', {
      csrfToken: rustCsrf.json.csrfToken,
      json: 'true',
    });
    check('valid signout', outRust.json, outTs.json);
    checkTrue(
      'both signouts delete the session cookie',
      [outTs, outRust].every((r) => r.setCookies.some((c) => /session-token=;/.test(c))),
    );
  } finally {
    if (previous === undefined) delete process.env.AUTH_DB_PATH;
    else process.env.AUTH_DB_PATH = previous;
    // The TypeScript authorize path keeps its SQLite handle open in a global singleton.
    // Windows refuses to delete the file while it is open, so close it first.
    globalThis.__authUserStore?.close();
    delete globalThis.__authUserStore;
    // Windows keeps the SQLite file locked for a moment after the handle closes.
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
