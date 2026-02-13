import type { ClawHubSearchItem, ClawHubSearchParseResult } from './types';

const SEARCH_ROW =
  /^([A-Za-z0-9._/-]+)\s+v([0-9A-Za-z.+-]+)\s+(.+?)\s+\(([-+]?\d*\.?\d+)\)\s*$/;

export function parseClawHubSearchOutput(output: string): ClawHubSearchParseResult {
  const items: ClawHubSearchItem[] = [];
  const parseWarnings: string[] = [];

  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (line.startsWith('- ')) {
      continue;
    }

    const match = SEARCH_ROW.exec(line);
    if (!match) {
      parseWarnings.push(`Unparsed clawhub search line: ${line}`);
      continue;
    }

    items.push({
      slug: match[1],
      version: match[2],
      title: match[3].trim(),
      score: Number.parseFloat(match[4]),
    });
  }

  return { items, parseWarnings };
}
