import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import StatsView from '@/components/stats/StatsView';

describe('StatsView ops depth', () => {
  it('renders sessions tab affordance for session-oriented usage analysis', () => {
    const html = renderToStaticMarkup(createElement(StatsView));

    expect(html).toContain('Overview');
    expect(html).toContain('Logs');
    expect(html).toContain('Sessions');
  });
});
