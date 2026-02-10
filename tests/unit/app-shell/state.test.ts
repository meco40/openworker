import { describe, expect, it } from 'vitest';
import { buildInitialShellState } from '../../../src/modules/app-shell/useAppShellState';

describe('shell state', () => {
  it('creates default view and channels', () => {
    const state = buildInitialShellState();
    expect(state.currentView).toBeDefined();
    expect(Object.keys(state.coupledChannels).length).toBeGreaterThan(0);
  });
});
