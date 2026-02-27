import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { View } from '@/shared/domain/types';

describe('Master view routing', () => {
  it('registers master view enum', () => {
    expect(View.MASTER).toBe('master');
  });

  it('shows Master in sidebar navigation', async () => {
    const { default: Sidebar } = await import('@/components/Sidebar');
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
    expect(navLabels).toContain('Master');
  });

  it('wires MasterView dynamic import and route branch', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/modules/app-shell/components/AppShellViewContent.tsx'),
      'utf8',
    );
    expect(source).toContain(
      "const MasterView = dynamic(() => import('@/modules/master/components/MasterView')",
    );
    expect(source).toContain('currentView === View.MASTER');
    expect(source).toContain('label="Master"');
  });
});
