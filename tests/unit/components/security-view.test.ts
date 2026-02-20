import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import SecurityView from '../../../components/SecurityView';

describe('SecurityView', () => {
  it('renders tabs for overview and whitelist', () => {
    const html = renderToStaticMarkup(createElement(SecurityView));

    expect(html).toContain('Overview');
    expect(html).toContain('Whitelist');
    expect(html).not.toContain('Worker Policies');
  });
});
