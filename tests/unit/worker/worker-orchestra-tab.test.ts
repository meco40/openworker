import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import WorkerOrchestraTab from '../../../components/worker/WorkerOrchestraTab';

describe('worker orchestra tab', () => {
  it('renders orchestra tab shell', () => {
    const html = renderToStaticMarkup(React.createElement(WorkerOrchestraTab));
    expect(html).toContain('🎼 Orchestra');
    expect(html).toContain('Draft erstellen');
    expect(html).toContain('Published');
  });
});
