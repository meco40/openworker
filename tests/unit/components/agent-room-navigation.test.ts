import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { View } from '@/shared/domain/types';

describe('Agent Room navigation', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('registers Agent Room view enum', () => {
    expect(View.AGENT_ROOM).toBe('agent-room');
  });

  it('shows Agent Room in sidebar navigation', async () => {
    const previous = process.env.NEXT_PUBLIC_AGENT_ROOM_ENABLED;
    process.env.NEXT_PUBLIC_AGENT_ROOM_ENABLED = 'true';
    try {
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
      expect(navLabels).toContain('Agent Room');
    } finally {
      if (previous === undefined) {
        delete process.env.NEXT_PUBLIC_AGENT_ROOM_ENABLED;
      } else {
        process.env.NEXT_PUBLIC_AGENT_ROOM_ENABLED = previous;
      }
    }
  });

  it('reflects runtime flag changes without requiring module reload', async () => {
    vi.stubEnv('NEXT_PUBLIC_AGENT_ROOM_ENABLED', 'false');
    const { default: Sidebar } = await import('@/components/Sidebar');

    const htmlWhenDisabled = renderToStaticMarkup(
      createElement(Sidebar, {
        activeView: View.DASHBOARD,
        onViewChange: () => {},
      }),
    );
    expect(htmlWhenDisabled).not.toContain('Agent Room');

    vi.stubEnv('NEXT_PUBLIC_AGENT_ROOM_ENABLED', 'true');
    const htmlWhenEnabled = renderToStaticMarkup(
      createElement(Sidebar, {
        activeView: View.DASHBOARD,
        onViewChange: () => {},
      }),
    );
    expect(htmlWhenEnabled).toContain('Agent Room');
  });
});
