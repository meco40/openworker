import type { CoupledChannel } from '@/shared/domain/types';
import type { ActiveTab } from './types';

const CHANNEL_TABS = [
  { id: 'whatsapp', label: 'WhatsApp', icon: '💬', color: 'emerald' },
  { id: 'telegram', label: 'Telegram', icon: '✈️', color: 'blue' },
  { id: 'discord', label: 'Discord', icon: '👾', color: 'indigo' },
  { id: 'imessage', label: 'iMessage', icon: '☁️', color: 'sky' },
  { id: 'slack', label: 'Slack', icon: '🟦', color: 'cyan' },
] as const;

type ChannelPairingTabBarProps = {
  activeTab: ActiveTab;
  coupledChannels: Record<string, CoupledChannel>;
  onSelectTab: (tab: ActiveTab) => void;
};

export function ChannelPairingTabBar({
  activeTab,
  coupledChannels,
  onSelectTab,
}: ChannelPairingTabBarProps) {
  return (
    <div className="flex gap-1 rounded-xl border border-zinc-800 bg-zinc-900/80 p-1.5">
      {CHANNEL_TABS.map((tab) => {
        const status = coupledChannels[tab.id]?.status;
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            onClick={() => onSelectTab(tab.id as ActiveTab)}
            className={`relative flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium transition-all md:flex-none md:justify-start md:px-4 ${
              isActive
                ? 'bg-zinc-800 text-white shadow-sm'
                : 'text-zinc-500 hover:bg-zinc-800/50 hover:text-zinc-300'
            }`}
          >
            <span className="text-base">{tab.icon}</span>
            <span className="hidden sm:inline">{tab.label}</span>
            {status === 'connected' && (
              <span className={`ml-auto h-2 w-2 shrink-0 rounded-full bg-${tab.color}-500`} />
            )}
            {(status === 'pairing' || status === 'awaiting_code') && (
              <span className="ml-auto h-2 w-2 shrink-0 animate-pulse rounded-full bg-amber-500" />
            )}
          </button>
        );
      })}
    </div>
  );
}
