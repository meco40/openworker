import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ConfigEditor from '../../../components/ConfigEditor';

describe('config editor accessibility baseline', () => {
  it('renders aria labels for key controls', () => {
    const html = renderToStaticMarkup(createElement(ConfigEditor));

    expect(html).toContain('aria-label="Reload config"');
    expect(html).toContain('aria-label="Open apply preview"');
    expect(html).toContain('Advanced JSON');
  });
});
