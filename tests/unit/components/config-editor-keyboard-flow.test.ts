import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ConfigEditor from '../../../components/ConfigEditor';

describe('config editor keyboard-flow baseline', () => {
  it('renders interactive controls for tab and apply flow', () => {
    const html = renderToStaticMarkup(createElement(ConfigEditor));

    expect(html).toContain('Overview');
    expect(html).toContain('Network');
    expect(html).toContain('Runtime');
    expect(html).toContain('Web UI');
    expect(html).toContain('Apply Config');
  });
});
