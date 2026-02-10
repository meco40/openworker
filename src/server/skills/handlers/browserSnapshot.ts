export async function browserSnapshotHandler(args: Record<string, unknown>) {
  const url = String(args.url || '').trim() || 'https://example.com';
  const response = await fetch(url, { headers: { 'User-Agent': 'openclaw-browser-skill' } });
  if (!response.ok) throw new Error(`Failed to fetch URL (${response.status}).`);
  const html = await response.text();

  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const descriptionMatch = html.match(
    /<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i,
  );

  const plainText = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    url,
    status: response.status,
    title: titleMatch ? titleMatch[1].trim() : '',
    description: descriptionMatch ? descriptionMatch[1].trim() : '',
    excerpt: plainText.slice(0, 800),
    fetchedAt: new Date().toISOString(),
  };
}
