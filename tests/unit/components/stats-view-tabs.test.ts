import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import StatsView from '../../../components/StatsView';

describe('StatsView tabs', () => {
  it('renders overview and logs tab buttons', () => {
    const html = renderToStaticMarkup(createElement(StatsView));

    expect(html).toContain('Overview');
    expect(html).toContain('Logs');
  });
});
