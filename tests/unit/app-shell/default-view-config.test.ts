import { describe, expect, it } from 'vitest';
import { View } from '@/shared/domain/types';
import { resolveDefaultViewFromConfig } from '@/server/config/uiRuntimeConfig';
import { resolveViewFromConfig } from '@/modules/app-shell/useAppShellState';

const invalidViewValues = ['invalid-view', 'teams'] as const;
const fallbackResolvers = [
  ['resolveViewFromConfig', (value: string) => resolveViewFromConfig(value)],
  [
    'resolveDefaultViewFromConfig',
    (value: string) => resolveDefaultViewFromConfig({ ui: { defaultView: value } }),
  ],
] as const;

describe('default view config', () => {
  it('uses configured default view when valid', () => {
    expect(resolveViewFromConfig('wizard')).toBe(View.WIZARD);
    expect(resolveViewFromConfig('cron')).toBe(View.CRON);
    expect(resolveViewFromConfig('instances')).toBe(View.INSTANCES);
    expect(resolveViewFromConfig('sessions')).toBe(View.SESSIONS);
    expect(resolveDefaultViewFromConfig({ ui: { defaultView: 'personas' } })).toBe(View.PERSONAS);
    expect(resolveDefaultViewFromConfig({ ui: { defaultView: 'cron' } })).toBe(View.CRON);
    expect(resolveDefaultViewFromConfig({ ui: { defaultView: 'memory' } })).toBe(View.MEMORY);
    expect(resolveDefaultViewFromConfig({ ui: { defaultView: 'nodes' } })).toBe(View.NODES);
    expect(resolveDefaultViewFromConfig({ ui: { defaultView: 'agents' } })).toBe(View.AGENTS);
  });

  describe.each(fallbackResolvers)('%s', (_resolverName, resolve) => {
    it.each(invalidViewValues)('falls back to dashboard for "%s"', (value) => {
      expect(resolve(value)).toBe(View.DASHBOARD);
    });
  });

  it('falls back to dashboard when ui config is missing', () => {
    expect(resolveDefaultViewFromConfig({})).toBe(View.DASHBOARD);
  });
});
