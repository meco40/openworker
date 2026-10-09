import type { IncomingMessage } from 'node:http';
import { RequestCookies } from 'next/dist/compiled/@edge-runtime/cookies';

export function websocketTokenRequest(request: IncomingMessage) {
  const incoming = request.headers;
  const headers = new Headers();
  if (incoming.cookie) headers.set('cookie', incoming.cookie);
  if (incoming.authorization) headers.set('authorization', incoming.authorization);
  return Object.assign(request, {
    cookies: Object.fromEntries(
      new RequestCookies(headers).getAll().map(({ name, value }) => [name, value]),
    ),
  });
}
