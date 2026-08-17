import { ChannelType, View } from '@/shared/domain/types';
import type { AppShellState } from '@/modules/app-shell/types';

export function buildInitialShellState(initialView: View = View.DASHBOARD): AppShellState {
  return {
    currentView: initialView,
    coupledChannels: {
      whatsapp: { type: ChannelType.WHATSAPP, status: 'idle' },
      telegram: { type: ChannelType.TELEGRAM, status: 'idle' },
      discord: { type: ChannelType.DISCORD, status: 'idle' },
      imessage: { type: ChannelType.IMESSAGE, status: 'idle' },
      slack: { type: ChannelType.SLACK, status: 'idle' },
    },
  };
}
