/**
 * web_fetch handler — Fetch a URL and return clean text/markdown content.
 * SSRF guard blocks private/loopback IP ranges.
 */

import { URL } from 'node:url';
import { fetchWithSsrfGuard, readResponseTextLimited } from '@/server/http/ssrfGuard';

const FETCH_MAX_CHARS = 20_000;
const FETCH_TIMEOUT_MS = 20_000;

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

  const maxChars = Math.min(Number(args.max_chars) || FETCH_MAX_CHARS, 50_000);

  try {
    const res = await fetchWithSsrfGuard(
      url,
      {
        headers: {
          'User-Agent': 'openclaw-web-fetch/1.0 (compatible; +https://openclaw.io)',
          Accept: 'text/html,application/xhtml+xml,text/plain,*/*',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
      { maxRedirects: 3 },
    );

    const contentType = res.headers.get('content-type') ?? '';
    const rawBody = await readResponseTextLimited(res, 2_000_000);

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
