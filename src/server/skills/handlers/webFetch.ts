/**
 * web_fetch handler — Fetch a URL and return clean text/markdown content.
 * SSRF guard blocks private/loopback IP ranges.
 */

import { URL } from 'node:url';
import * as dns from 'node:dns/promises';

const FETCH_MAX_CHARS = 20_000;
const FETCH_TIMEOUT_MS = 20_000;

// RFC1918 + loopback + link-local ranges
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
  // Direct IP check
  for (const pattern of BLOCKED_RANGES) {
    if (pattern.test(hostname)) {
      throw new Error(`SSRF guard: blocked private/loopback address "${hostname}"`);
    }
  }
  // DNS resolve and check resolved IP
  try {
    const addresses = await dns.resolve4(hostname);
    for (const addr of addresses) {
      for (const pattern of BLOCKED_RANGES) {
        if (pattern.test(addr)) {
          throw new Error(
            `SSRF guard: hostname "${hostname}" resolves to private address "${addr}"`,
          );
        }
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('SSRF guard')) throw err;
    // DNS resolution failure — let the fetch fail naturally
  }
}

function extractTextFromHtml(html: string): string {
  // Remove script/style blocks
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    // Convert heading tags to markdown-like text
    .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_, c) => `\n\n## ${c}\n\n`)
    // Convert paragraphs and divs to newlines
    .replace(/<\/p>|<\/div>|<br\s*\/?>/gi, '\n')
    // Convert links to [text](url)
    .replace(/<a[^>]+href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) =>
      text.trim() ? `[${text.trim()}](${href})` : href,
    )
    // Strip all remaining tags
    .replace(/<[^>]+>/g, ' ')
    // Decode common HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // Collapse whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text;
}

export async function webFetchHandler(args: Record<string, unknown>) {
  const url = String(args.url || '').trim();
  if (!url) return { error: 'url is required' };

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

  const maxChars = Math.min(Number(args.max_chars) || FETCH_MAX_CHARS, 50_000);

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'openclaw-web-fetch/1.0 (compatible; +https://openclaw.io)',
        Accept: 'text/html,application/xhtml+xml,text/plain,*/*',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });

    const contentType = res.headers.get('content-type') ?? '';
    const rawBody = await res.text();

    let content: string;
    if (contentType.includes('text/html')) {
      // Extract title
      const titleMatch = rawBody.match(/<title[^>]*>([^<]*)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : '';
      content = (title ? `# ${title}\n\n` : '') + extractTextFromHtml(rawBody);
    } else {
      content = rawBody;
    }

    return {
      url: res.url,
      status: res.status,
      contentType,
      length: content.length,
      content: content.slice(0, maxChars),
      truncated: content.length > maxChars,
    };
  } catch (err) {
    return { error: `Fetch failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
