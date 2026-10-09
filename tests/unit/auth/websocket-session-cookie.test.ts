import { describe, expect, it, vi, afterEach } from 'vitest';
import { websocketTokenRequest } from '@/server/auth/websocketTokenRequest';
import { encode, getToken } from 'next-auth/jwt';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';

afterEach(() => vi.unstubAllEnvs());

describe('gateway session cookie decoding', () => {
  it.each([false, true])('accepts chunked cookies with secureCookie=%s', async (secure) => {
    vi.stubEnv('NEXTAUTH_URL', secure ? 'https://gateway.example' : 'http://localhost:3000');
    const secret = 'isolated-test-secret';
    const jwt = await encode({ token: { id: 'user-cookie-test' }, secret });
    const name = secure ? '__Secure-next-auth.session-token' : 'next-auth.session-token';
    const midpoint = Math.floor(jwt.length / 2);
    const incoming = new IncomingMessage(new Socket());
    incoming.headers.cookie = `${name}.1=${jwt.slice(midpoint)}; unrelated=value; ${name}.0=${jwt.slice(0, midpoint)}`;
    const req = websocketTokenRequest(incoming);
    expect((await getToken({ req, secret }))?.id).toBe('user-cookie-test');
    expect(await getToken({ req, secret: 'wrong-secret' })).toBeNull();
  });
});
