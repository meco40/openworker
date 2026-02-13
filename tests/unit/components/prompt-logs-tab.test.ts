import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import PromptLogsTab from '../../../components/stats/PromptLogsTab';

describe('PromptLogsTab', () => {
  it('renders logs panel shell with filters and table headers', () => {
    const html = renderToStaticMarkup(createElement(PromptLogsTab));

    expect(html).toContain('Prompt Dispatch Logs');
    expect(html).toContain('Reset All Data');
    expect(html).toContain('Logger Diagnostics');
    expect(html).toContain('Attempts Since Boot');
    expect(html).toContain('Search prompts');
    expect(html).toContain('Provider');
    expect(html).toContain('Model');
    expect(html).toContain('Costs');
    expect(html).toContain('Risk');
  });
});
