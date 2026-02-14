import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import Sidebar from '../../../components/Sidebar';
import { View } from '../../../types';

describe('Sidebar memory navigation', () => {
  it('renders the Memory navigation entry', () => {
    const html = renderToStaticMarkup(
      createElement(Sidebar, {
        activeView: View.DASHBOARD,
        onViewChange: () => {},
        onToggleCanvas: () => {},
      }),
    );

    expect(html).toContain('Memory');
  });
});
