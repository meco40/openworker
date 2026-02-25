import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { View } from '@/shared/domain/types';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('agent room feature flag', () => {
  it('hides sidebar entrypoint when NEXT_PUBLIC_AGENT_ROOM_ENABLED=false', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_AGENT_ROOM_ENABLED', 'false');

    const { default: Sidebar } = await import('@/components/Sidebar');
    const html = renderToStaticMarkup(
      createElement(Sidebar, {
        activeView: View.DASHBOARD,
        onViewChange: () => {},
      }),
    );

    expect(html).not.toContain('Agent Room');
  });
});

