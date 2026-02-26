import type { CoupledChannel } from '@/shared/domain/types';

const CONNECTED_CHANNEL_BADGES = [
  { id: 'whatsapp', label: 'WhatsApp', color: 'emerald' },
  { id: 'telegram', label: 'Telegram', color: 'blue' },
  { id: 'discord', label: 'Discord', color: 'indigo' },
  { id: 'imessage', label: 'iMessage', color: 'sky' },
  { id: 'slack', label: 'Slack', color: 'cyan' },
] as const;

type ChannelPairingHeaderProps = {
  coupledChannels: Record<string, CoupledChannel>;
};

export function ChannelPairingHeader({ coupledChannels }: ChannelPairingHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h2 className="text-xl font-bold tracking-tight text-white">Messenger Coupling</h2>
        <p className="mt-0.5 text-sm text-zinc-500">
          Bridge external communications to the Gateway Control Plane.
        </p>
      </div>
      <div className="hidden shrink-0 items-center gap-2 md:flex">
        {CONNECTED_CHANNEL_BADGES.filter((tab) => coupledChannels[tab.id]?.status === 'connected').map(
          (tab) => (
            <span
              key={tab.id}
              className="flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1 text-xs text-zinc-300"
            >
              <span className={`h-1.5 w-1.5 rounded-full bg-${tab.color}-500`} />
              {tab.label}
            </span>
          ),
        )}
      </div>
    </div>
  );
}
