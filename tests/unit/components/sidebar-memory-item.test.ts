import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import Sidebar from '@/components/Sidebar';
import { View } from '@/shared/domain/types';

describe('Sidebar memory navigation', () => {
  it('uses single-user profile label in navigation', () => {
    const html = renderToStaticMarkup(
      createElement(Sidebar, {
        activeView: View.DASHBOARD,
        onViewChange: () => {},
      }),
    );
    const navLabels = Array.from(
      html.matchAll(/<span class="font-medium">([^<]+)<\/span>/g),
      ([, label]) => label,
    );

    expect(navLabels).toContain('Memory');
    expect(navLabels).toContain('Operator Profile');
    expect(navLabels).not.toContain('SaaS Identity');
    expect(navLabels).not.toContain('Team Collaboration');
  });
});
