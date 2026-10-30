#!/usr/bin/env node
/** Generate explicitly, or semantically validate committed random auth fixtures with --check. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { AuthHandler, createCSRFToken, serialize, version } from './nextauth.mjs';
const require = createRequire(import.meta.url);
const { encode, decode } = require('next-auth/jwt');
const Credentials = require('next-auth/providers/credentials').default;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dir = resolve(root, 'rust/crates/betaclaw-gateway/tests/fixtures');
const secret = 'betaclaw-nextauth-fixture-secret';
process.env.NEXTAUTH_URL ||= 'http://localhost:3000';
const cookieName = 'next-auth.session-token';
const payload = {
  id: 'usr-fixture-0001',
  sub: 'usr-fixture-0001',
  name: 'Fixture Admin',
  email: 'fixture@example.com',
};
const options = {
  secret,
  providers: [Credentials({ authorize: async () => null })],
  session: { strategy: 'jwt' },
};
async function validate(fixture) {
  const claims = await decode({ token: fixture.token, secret: fixture.secret });
  assert.equal(claims?.sub, fixture.expectedUserId);
  assert.equal(claims?.name, fixture.expectedName);
  assert.equal(claims?.email, fixture.expectedEmail);
  assert(
    claims.exp > Date.now() / 1000 + 14 * 86400,
    'Regenerate the expiring fixture explicitly.',
  );
  const csrf = createCSRFToken({
    options: { secret: fixture.secret },
    cookieValue: decodeURIComponent(fixture.csrfCookie),
    bodyValue: fixture.csrfToken,
    isPost: true,
  });
  assert.equal(csrf.csrfTokenVerified, true);
}
if (process.argv.includes('--check')) {
  const fixture = JSON.parse(readFileSync(resolve(dir, 'nextauth-session-token.json'), 'utf8'));
  await validate(fixture);
  const csrf = JSON.parse(readFileSync(resolve(dir, 'nextauth-csrf.json'), 'utf8'));
  assert.equal(
    createCSRFToken({
      options: { secret: csrf.secret },
      cookieValue: decodeURIComponent(csrf.csrfCookie),
      bodyValue: csrf.csrfToken,
      isPost: true,
    }).csrfTokenVerified,
    true,
  );
  assert(csrf.csrfCookie.includes('%7C'), 'Fixture must contain the serialized cookie delimiter.');
  assert.equal(csrf.generator, 'next-auth/core.AuthHandler');
  console.log(
    'Committed session/CSRF fixtures accepted by next-auth@' + version + '; no files rewritten.',
  );
} else {
  const token = await encode({ token: payload, secret, maxAge: 10 * 365 * 86400 });
  const claims = await decode({ token, secret });
  const response = await AuthHandler({
    req: new Request('http://localhost:3000/api/auth/csrf'),
    options,
  });
  assert.equal(response.status ?? 200, 200);
  const cookie = response.cookies.find((c) => c.name === 'next-auth.csrf-token');
  assert(cookie, 'Real CSRF handler did not issue a cookie.');
  const setCookie = serialize(cookie.name, cookie.value, cookie.options);
  const csrfCookie = setCookie.split(';')[0].slice(cookie.name.length + 1);
  const csrfToken = response.body.csrfToken;
  const fixture = {
    _comment:
      'Generated explicitly by generate-nextauth-token.mjs; CI validates compatibility without rewriting randomness.',
    generator: 'next-auth/jwt.encode',
    nextAuthVersion: version,
    cookieName,
    secret,
    issuedAt: claims.iat,
    expiresAt: claims.exp,
    expectedUserId: payload.id,
    expectedEmail: payload.email,
    expectedName: payload.name,
    token,
    csrfToken,
    csrfCookie,
  };
  await validate(fixture);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    resolve(dir, 'nextauth-session-token.json'),
    JSON.stringify(fixture, null, 2) + '\n',
  );
  writeFileSync(
    resolve(dir, 'nextauth-csrf.json'),
    JSON.stringify(
      {
        generator: 'next-auth/core.AuthHandler',
        nextAuthVersion: version,
        secret,
        csrfToken,
        csrfCookie,
        setCookie,
      },
      null,
      2,
    ) + '\n',
  );
  console.log('Session and serialized CSRF fixtures generated using next-auth@' + version);
}
