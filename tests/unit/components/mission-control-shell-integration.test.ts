import { createElement } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import Sidebar from '@/components/Sidebar';
import { View } from '@/shared/domain/types';

const ROOT = process.cwd();

describe('Mission Control removal', () => {
  it('does not expose the removed page in the sidebar', () => {
    const html = renderToStaticMarkup(
      createElement(Sidebar, {
        activeView: View.DASHBOARD,
        onViewChange: () => {},
      }),
    );
    const navLabels = Array.from(
      html.matchAll(/<span class="font-medium[^"]*">([^<]+)<\/span>/g),
      ([, label]) => label,
    );

    expect(navLabels).not.toContain('Mission Control');
    expect(html).not.toContain('data-view="mission_control"');
    expect(Object.values(View)).not.toContain('mission_control');
  });

  it('does not leave the removed route or shell module registered', () => {
    expect(fs.existsSync(path.join(ROOT, 'app/mission-control/page.tsx'))).toBe(false);
    expect(
      fs.existsSync(
        path.join(ROOT, 'src/modules/mission-control/components/MissionControlView.tsx'),
      ),
    ).toBe(false);

    const shellSource = fs.readFileSync(
      path.join(ROOT, 'src/modules/app-shell/components/AppShellViewContent.tsx'),
      'utf8',
    );
    expect(shellSource).not.toContain('MissionControlView');
    expect(shellSource).not.toContain('View.MISSION_CONTROL');
  });
});
