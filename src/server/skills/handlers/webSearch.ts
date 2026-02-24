/**
 * web_search handler — Real web search via Brave Search API.
 * Env: BRAVE_SEARCH_API_KEY (required for Brave; falls back to DuckDuckGo scrape)
 */

const BRAVE_API_BASE = 'https://api.search.brave.com/res/v1/web/search';
const WEB_SEARCH_RESULT_LIMIT = 8;
const WEB_SEARCH_SNIPPET_MAX = 300;

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
}

interface BraveSearchResponse {
  web?: { results?: BraveWebResult[] };
}

async function searchViaBrave(
  query: string,
  count: number,
  freshness?: string,
): Promise<{ title: string; url: string; snippet: string }[]> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) throw new Error('BRAVE_SEARCH_API_KEY not set');

  const params = new URLSearchParams({
    q: query,
    count: String(Math.min(count, 20)),
    text_decorations: '0',
    search_lang: 'de',
    ...(freshness ? { freshness } : {}),
  });

  const res = await fetch(`${BRAVE_API_BASE}?${params}`, {
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': apiKey,
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) throw new Error(`Brave Search API error: ${res.status} ${res.statusText}`);

  const data = (await res.json()) as BraveSearchResponse;
  const results = data?.web?.results ?? [];
  return results.slice(0, count).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: (r.description ?? '').slice(0, WEB_SEARCH_SNIPPET_MAX),
  }));
}

async function searchViaDuckDuckGo(
  query: string,
  count: number,
): Promise<{ title: string; url: string; snippet: string }[]> {
  // Minimal DDG instant-answer API (non-JS)
  const params = new URLSearchParams({
    q: query,
    format: 'json',
    no_html: '1',
    skip_disambig: '1',
  });
  const res = await fetch(`https://api.duckduckgo.com/?${params}`, {
    headers: { 'User-Agent': 'openclaw-web-search/1.0' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`DuckDuckGo API error: ${res.status}`);

  const data = (await res.json()) as {
    AbstractURL?: string;
    AbstractText?: string;
    Heading?: string;
    RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
  };

  const results: { title: string; url: string; snippet: string }[] = [];

  if (data.AbstractURL && data.AbstractText) {
    results.push({
      title: data.Heading ?? query,
      url: data.AbstractURL,
      snippet: data.AbstractText.slice(0, WEB_SEARCH_SNIPPET_MAX),
    });
  }

  for (const topic of data.RelatedTopics ?? []) {
    if (!topic.FirstURL || !topic.Text) continue;
    results.push({
      title: '',
      url: topic.FirstURL,
      snippet: topic.Text.slice(0, WEB_SEARCH_SNIPPET_MAX),
    });
    if (results.length >= count) break;
  }

  return results.slice(0, count);
}

export async function webSearchHandler(args: Record<string, unknown>) {
  const query = String(args.query || '').trim();
  if (!query) return { error: 'query is required', results: [] };

  const count = Math.max(1, Math.min(Number(args.count) || WEB_SEARCH_RESULT_LIMIT, 20));
  const freshness = args.freshness ? String(args.freshness) : undefined;

  let results: { title: string; url: string; snippet: string }[];
  let provider: string;

  try {
    results = await searchViaBrave(query, count, freshness);
    provider = 'brave';
  } catch (err) {
    // fallback: DuckDuckGo instant answers
    try {
      results = await searchViaDuckDuckGo(query, count);
      provider = 'duckduckgo';
    } catch {
      return {
        error: `Search failed: ${err instanceof Error ? err.message : String(err)} (DDG fallback also failed)`,
        results: [],
      };
    }
  }

  return {
    query,
    provider,
    count: results.length,
    results,
  };
}
