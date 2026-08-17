/**
 * http_request handler — Generic HTTP client for API calls.
 * Gated by OPENCLAW_HTTP_SKILL_ENABLED=true.
 * SSRF guard blocks private/loopback addresses.
 */

import { fetchWithSsrfGuard, readResponseBytesLimited } from '@/server/http/ssrfGuard';

const HTTP_TIMEOUT_MS = 30_000;
const HTTP_BODY_MAX_CHARS = 8_000;

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

  const customHeaders = (args.headers as Record<string, string>) ?? {};
  const body = args.body !== undefined ? JSON.stringify(args.body) : undefined;

  try {
    const res = await fetchWithSsrfGuard(
      url,
      {
        method,
        headers: {
          'Content-Type': body ? 'application/json' : undefined,
          'User-Agent': 'openclaw-http-skill/1.0',
          ...customHeaders,
        } as HeadersInit,
        body: body && ['POST', 'PUT', 'PATCH'].includes(method) ? body : undefined,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      },
      { maxRedirects: 0 },
    );

    const contentType = res.headers.get('content-type') ?? '';
    let responseBody: unknown;

    const responseBytes = await readResponseBytesLimited(res, 1_000_000);
    const responseText = responseBytes.toString('utf8');
    if (contentType.includes('application/json')) {
      try {
        responseBody = JSON.parse(responseText);
      } catch {
        responseBody = responseText;
      }
    } else {
      const text = responseText;
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
