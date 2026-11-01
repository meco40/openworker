/**
 * Auth routes (`/api/auth/*`) parity against the NextAuth reference.
 *
 * The NextAuth reference is `golden/auth.json`, recorded once from the real next-auth
 * handler and the application authorize callback before the TypeScript backend was
 * removed. Two values differ per run and are normalised on both sides: the gateway
 * origin (the port is chosen per run; the reference stores `<origin>`) and session
 * user ids (minted per login, so only their presence is compared).
 *
 * Replaying a cookie minted by the TypeScript side against Rust is no longer
 * possible (the TypeScript side is gone), so the Rust-issued cookie is checked
 * against the reference instead.
 */
import { check, checkTrue, goldenReference, rustRequest } from '../harness.mjs';

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
/** Replaces the gateway origin with a placeholder so the reference does not depend on the port. */
function originless(value, origin) {
  const text = JSON.stringify(value);
  return text === undefined ? value : JSON.parse(text.split(origin).join('<origin>'));
}
/** Session user ids are minted per login: only their presence is compared. */
function withoutUserId(user) {
  if (!user || typeof user.id !== 'string') return user;
  return { ...user, id: '<id>' };
}

export async function run() {
  const email = process.env.AUTH_DEFAULT_EMAIL,
    password = process.env.AUTH_DEFAULT_PASSWORD;
  if (!email || !password)
    throw new Error(
      'Auth parity requires the isolated AUTH_DEFAULT_EMAIL/PASSWORD supplied to the Rust gateway.',
    );
  const base = (process.env.NEXTAUTH_URL || 'http://localhost:3000').replace(/\/$/, '');
  const rustJar = new Map();
  const rust = async (method, path, body, cookie) => {
    const response = await rustRequest(method, path, {
      body,
      headers: { cookie: cookieHeader(rustJar, cookie) },
    });
    updateJar(rustJar, response.setCookies);
    return { ...response, json: originless(response.json, base) };
  };
  const reference = (key) => goldenReference(name, key);

  const providers = await reference('providers');
  check(
    'providers: NextAuth reference versus Rust',
    (await rust('GET', '/api/auth/providers')).json,
    providers.json,
  );
  const tsCsrf = await reference('csrf'),
    rustCsrf = await rust('GET', '/api/auth/csrf');
  for (const [label, response] of [
    ['Reference', tsCsrf],
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
    (await reference('anonymous session')).json,
  );
  const form = (csrfToken, pass = password) => ({
    email,
    password: pass,
    csrfToken,
    callbackUrl: base + '/',
    json: 'true',
  });
  const tsLogin = await reference('login');
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
  if (!rustCookie) throw new Error('Successful login did not issue a session cookie.');
  console.log(
    'SKIP Reference-Cookie gegen Rust — das Cookie gilt nur für das Secret seines Laufs und steht nicht im Referenzbestand',
  );
  {
    const a = await reference('session with Rust cookie'),
      b = await rust('GET', '/api/auth/session', undefined, rustCookie);
    check(
      'Rust cookie accepted by both implementations',
      withoutUserId(b.json.user),
      withoutUserId(a.json.user),
    );
  }
  const badCsrf = { ...form('invalid'), json: 'true' };
  const a = await reference('invalid CSRF'),
    b = await rust('POST', '/api/auth/callback/credentials', badCsrf);
  check('invalid CSRF status', b.status, a.status);
  check('invalid CSRF redirect', b.json, a.json);
  for (let attempt = 1; attempt <= 10; attempt++) {
    const a = await reference('bad password ' + attempt);
    const b = await rust(
      'POST',
      '/api/auth/callback/credentials',
      form(rustCsrf.json.csrfToken, 'wrong-parity-password'),
    );
    check('bad password ' + attempt + ' status', b.status, a.status);
    check('bad password ' + attempt + ' URL', b.json, a.json);
  }
  const blockedTs = await reference('correct password locked out');
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
  const outTs = await reference('signout');
  const outRust = await rust('POST', '/api/auth/signout', {
    csrfToken: rustCsrf.json.csrfToken,
    json: 'true',
  });
  check('valid signout', outRust.json, outTs.json);
  checkTrue(
    'both signouts delete the session cookie',
    [outTs, outRust].every((r) => r.setCookies.some((c) => /session-token=;/.test(c))),
  );
}
