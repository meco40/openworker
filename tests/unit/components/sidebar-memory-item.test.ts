import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import Sidebar from '../../../components/Sidebar';
import { View } from '../../../types';

describe('Sidebar memory navigation', () => {
  it('renders Memory and excludes Team Collaboration navigation entries', () => {
    const html = renderToStaticMarkup(
      createElement(Sidebar, {
        activeView: View.DASHBOARD,
        onViewChange: () => {},
        onToggleCanvas: () => {},
      }),
    );
    const navLabels = Array.from(
      html.matchAll(/<span class="font-medium">([^<]+)<\/span>/g),
      ([, label]) => label,
    );

    expect(navLabels).toContain('Memory');
    expect(navLabels).not.toContain('Team Collaboration');
  });
});
