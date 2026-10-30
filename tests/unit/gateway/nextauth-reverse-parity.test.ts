import { describe, expect, it } from 'vitest';
import { decode, getToken } from 'next-auth/jwt';
import { NextRequest } from 'next/server';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// oxlint-disable-next-line security/detect-non-literal-require -- Fixed installed next-auth module; its package exports hide this reference helper.
const { createCSRFToken } = require(
  join(dirname(require.resolve('next-auth')), 'core/lib/csrf-token.js'),
) as {
  createCSRFToken(input: {
    options: { secret: string };
    cookieValue: string;
    bodyValue: string;
    isPost: boolean;
  }): { csrfTokenVerified: boolean };
};
const readFixture = (
  name: string,
): {
  token: string;
  secret: string;
  csrfToken: string;
  csrfCookie: string;
  expectedUserId: string;
  expectedEmail: string;
  expectedName: string;
} =>
  JSON.parse(
    readFileSync(
      resolve(process.cwd(), 'rust/crates/betaclaw-gateway/tests/fixtures', name),
      'utf8',
    ),
  );

describe('Rust -> real next-auth compatibility', () => {
  it('requires the committed Rust fixture and accepts its token through decode and getToken', async () => {
    const fixture = readFixture('rust-session-token.json');
    const decoded = await decode({ token: fixture.token, secret: fixture.secret });
    expect(decoded?.sub).toBe(fixture.expectedUserId);
    expect(decoded?.name).toBe(fixture.expectedName);
    const req = new NextRequest('http://localhost:3000', {
      headers: { cookie: 'next-auth.session-token=' + fixture.token },
    });
    const claims = await getToken({ req, secret: fixture.secret, secureCookie: false });
    expect(claims?.sub).toBe(fixture.expectedUserId);
    expect(claims?.email).toBe(fixture.expectedEmail);
    expect(
      createCSRFToken({
        options: { secret: fixture.secret },
        cookieValue: fixture.csrfCookie,
        bodyValue: fixture.csrfToken,
        isPost: true,
      }).csrfTokenVerified,
    ).toBe(true);
  });
  it('requires the encoded CSRF fixture from the NextAuth handler', () => {
    const fixture = readFixture('nextauth-csrf.json');
    expect(fixture.csrfCookie).toContain('%7C');
    expect(
      createCSRFToken({
        options: { secret: fixture.secret },
        cookieValue: decodeURIComponent(fixture.csrfCookie),
        bodyValue: fixture.csrfToken,
        isPost: true,
      }).csrfTokenVerified,
    ).toBe(true);
  });
});
