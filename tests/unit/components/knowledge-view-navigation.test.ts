import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import Sidebar from '@/components/Sidebar';
import { View } from '@/shared/domain/types';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('Knowledge view integration', () => {
  it('exposes a dedicated View enum entry for knowledge', () => {
    expect(View.KNOWLEDGE).toBe('knowledge');
  });

  it('shows Knowledge in sidebar navigation', () => {
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
    expect(navLabels).toContain('Knowledge');
  });

  it('routes knowledge view in app shell content', () => {
    const source = read('src/modules/app-shell/components/AppShellViewContent.tsx');
    expect(source).toContain(
      "const KnowledgeView = dynamic(() => import('@/components/KnowledgeView'),",
    );
    expect(source).toContain('currentView === View.KNOWLEDGE');
    expect(source).toContain('label="Knowledge"');
  });
});
