import type { CoupledChannel, View } from '../../../types';

export interface AppShellState {
  currentView: View;
  coupledChannels: Record<string, CoupledChannel>;
}
