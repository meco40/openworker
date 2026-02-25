import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import Sidebar from '@/components/Sidebar';
import MissionControlView from '@/modules/mission-control/components/MissionControlView';
import { View } from '@/shared/domain/types';

describe('Mission Control shell integration', () => {
  it('exposes Mission Control navigation in the sidebar', () => {
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

    expect(navLabels).toContain('Mission Control');
  });

  it('renders Mission Control iframe target', () => {
    const html = renderToStaticMarkup(createElement(MissionControlView));
    expect(html).toContain('src="/mission-control"');
    expect(html).toContain('title="Mission Control"');
  });
});
