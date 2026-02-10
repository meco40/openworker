import { ChannelType, View } from '../../../types';
import type { AppShellState } from './types';

export function buildInitialShellState(): AppShellState {
  return {
    currentView: View.DASHBOARD,
    coupledChannels: {
      whatsapp: { type: ChannelType.WHATSAPP, status: 'idle' },
      telegram: { type: ChannelType.TELEGRAM, status: 'idle' },
      discord: { type: ChannelType.DISCORD, status: 'idle' },
      imessage: { type: ChannelType.IMESSAGE, status: 'idle' },
    },
  };
}
