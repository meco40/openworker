import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ConfigEditor from '../../../components/ConfigEditor';

describe('config editor behavior smoke', () => {
  it('renders preview-ready controls and helper copy', () => {
    const html = renderToStaticMarkup(createElement(ConfigEditor));

    expect(html).toContain('Apply Config');
    expect(html).toContain('Advanced JSON');
    expect(html).toContain('Simple tabbed setup with advanced JSON editing.');
    expect(html).toContain('Config Source');
  });
});
