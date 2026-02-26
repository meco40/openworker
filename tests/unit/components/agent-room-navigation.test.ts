import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { View } from '@/shared/domain/types';

describe('Agent Room navigation', () => {
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
});
