import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import Sidebar from '@/components/Sidebar';
import { View } from '@/shared/domain/types';

describe('Sidebar ops seven-point navigation', () => {
  it('contains all seven operations points', () => {
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

    expect(navLabels).toContain('Instances');
    expect(navLabels).toContain('Sessions');
    expect(navLabels).toContain('Usage Stats');
    expect(navLabels).toContain('Cron');
    expect(navLabels).toContain('Nodes');
    expect(navLabels).toContain('Agents');
    expect(navLabels).toContain('System Logs');
  });
});
