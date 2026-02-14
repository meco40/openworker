import { describe, expect, it } from 'vitest';
import { View } from '../../../types';
import { resolveDefaultViewFromConfig } from '../../../src/server/config/uiRuntimeConfig';
import { resolveViewFromConfig } from '../../../src/modules/app-shell/useAppShellState';

describe('default view config', () => {
  it('uses configured default view when valid', () => {
    expect(resolveViewFromConfig('wizard')).toBe(View.WIZARD);
    expect(resolveDefaultViewFromConfig({ ui: { defaultView: 'personas' } })).toBe(View.PERSONAS);
    expect(resolveDefaultViewFromConfig({ ui: { defaultView: 'memory' } })).toBe(View.MEMORY);
  });

  it('falls back to dashboard for invalid values', () => {
    expect(resolveViewFromConfig('invalid-view')).toBe(View.DASHBOARD);
    expect(resolveDefaultViewFromConfig({ ui: { defaultView: 'invalid-view' } })).toBe(
      View.DASHBOARD,
    );
    expect(resolveDefaultViewFromConfig({})).toBe(View.DASHBOARD);
  });
});
