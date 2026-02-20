import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import Sidebar from '@/components/Sidebar';
import { View } from '@/shared/domain/types';

describe('Sidebar cron navigation', () => {
  it('includes Cron in the sidebar navigation', () => {
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

    expect(navLabels).toContain('Cron');
  });
});
