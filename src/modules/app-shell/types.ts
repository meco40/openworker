import type { CoupledChannel, View } from '@/shared/domain/types';

export interface AppShellState {
  currentView: View;
  coupledChannels: Record<string, CoupledChannel>;
}
