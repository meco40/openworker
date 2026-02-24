/**
 * http_request handler — Generic HTTP client for API calls.
 * Gated by OPENCLAW_HTTP_SKILL_ENABLED=true.
 * SSRF guard blocks private/loopback addresses.
 */

import { URL } from 'node:url';
import * as dns from 'node:dns/promises';

const HTTP_TIMEOUT_MS = 30_000;
const HTTP_BODY_MAX_CHARS = 8_000;

const BLOCKED_RANGES = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^169\.254\./,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i,
];

async function assertNotSsrf(hostname: string): Promise<void> {
  for (const pattern of BLOCKED_RANGES) {
    if (pattern.test(hostname)) {
      throw new Error(`SSRF guard: blocked private/loopback address "${hostname}"`);
    }
  }
  try {
    const addresses = await dns.resolve4(hostname);
    for (const addr of addresses) {
      for (const pattern of BLOCKED_RANGES) {
        if (pattern.test(addr)) {
          throw new Error(`SSRF guard: "${hostname}" resolves to private address "${addr}"`);
        }
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('SSRF guard')) throw err;
  }
}

export async function httpRequestHandler(args: Record<string, unknown>) {
  if (String(process.env.OPENCLAW_HTTP_SKILL_ENABLED || 'false').toLowerCase() !== 'true') {
    return {
      error:
        'http_request skill is disabled. Set OPENCLAW_HTTP_SKILL_ENABLED=true in your environment to enable it.',
    };
  }

  const method = String(args.method || 'GET').toUpperCase();
  const url = String(args.url || '').trim();
  if (!url) return { error: 'url is required' };

  const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];
  if (!ALLOWED_METHODS.includes(method)) {
    return { error: `Unsupported HTTP method: ${method}. Allowed: ${ALLOWED_METHODS.join(', ')}` };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: `Invalid URL: ${url}` };
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { error: `Unsupported protocol: ${parsed.protocol}` };
  }

  try {
    await assertNotSsrf(parsed.hostname);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  const customHeaders = (args.headers as Record<string, string>) ?? {};
  const body = args.body !== undefined ? JSON.stringify(args.body) : undefined;

  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': body ? 'application/json' : undefined,
        'User-Agent': 'openclaw-http-skill/1.0',
        ...customHeaders,
      } as HeadersInit,
      body: body && ['POST', 'PUT', 'PATCH'].includes(method) ? body : undefined,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });

    const contentType = res.headers.get('content-type') ?? '';
    let responseBody: unknown;

    if (contentType.includes('application/json')) {
      try {
        responseBody = await res.json();
      } catch {
        responseBody = await res.text();
      }
    } else {
      const text = await res.text();
      responseBody =
        text.length > HTTP_BODY_MAX_CHARS ? text.slice(0, HTTP_BODY_MAX_CHARS) + '…' : text;
    }

    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    return {
      status: res.status,
      statusText: res.statusText,
      headers: responseHeaders,
      body: responseBody,
    };
  } catch (err) {
    return { error: `HTTP request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
