import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import LogsView from '../../../components/LogsView';

describe('LogsView diagnostics panel', () => {
  it('renders a dedicated diagnostics section for health and doctor signals', () => {
    const html = renderToStaticMarkup(createElement(LogsView));

    expect(html).toContain('System Diagnostics');
    expect(html).toContain('Health');
    expect(html).toContain('Doctor');
    expect(html).toContain('No active warnings');
    expect(html).not.toContain('>info<');
    expect(html).not.toContain('>warn<');
    expect(html).not.toContain('>error<');
    expect(html).not.toContain('>debug<');
  });
});
