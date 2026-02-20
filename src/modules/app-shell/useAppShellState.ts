import { ChannelType, View } from '@/shared/domain/types';
import { isAllowedUiDefaultView } from '@/shared/config/uiSchema';
import type { AppShellState } from '@/modules/app-shell/types';

export function resolveViewFromConfig(value: unknown): View {
  const candidate = typeof value === 'string' ? value.trim() : '';
  if (candidate && isAllowedUiDefaultView(candidate)) {
    return candidate as View;
  }
  return View.DASHBOARD;
}

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
