import { describe, expect, it } from 'vitest';

import { parseClawHubSearchOutput } from '../../../src/server/clawhub/searchParser';

describe('parseClawHubSearchOutput', () => {
  it('parses standard search output rows', () => {
    const output = [
      'calendar v1.0.0  Calendar  (0.520)',
      'feishu-calendar v1.0.2  Feishu Calendar  (0.476)',
      '- Searching',
    ].join('\n');

    const parsed = parseClawHubSearchOutput(output);

    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0]).toMatchObject({
      slug: 'calendar',
      version: '1.0.0',
      title: 'Calendar',
      score: 0.52,
    });
    expect(parsed.parseWarnings).toEqual([]);
  });

  it('returns warnings for unparsed lines', () => {
    const output = ['calendar v1.0.0  Calendar  (0.520)', 'INVALID_LINE'].join('\n');

    const parsed = parseClawHubSearchOutput(output);

    expect(parsed.items).toHaveLength(1);
    expect(parsed.parseWarnings).toHaveLength(1);
    expect(parsed.parseWarnings[0]).toContain('INVALID_LINE');
  });
});
