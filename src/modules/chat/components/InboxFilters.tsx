import React from 'react';

interface InboxFiltersProps {
  channels: string[];
  activeChannel: string;
  searchQuery: string;
  onChannelChange: (value: string) => void;
  onSearchChange: (value: string) => void;
}

const InboxFilters: React.FC<InboxFiltersProps> = ({
  channels,
  activeChannel,
  searchQuery,
  onChannelChange,
  onSearchChange,
}) => {
  return (
    <div className="border-b border-zinc-800 p-2 space-y-2">
      <div className="flex flex-wrap gap-1">
        {channels.map((channel) => {
          const active = activeChannel === channel;
          return (
            <button
              key={channel}
              type="button"
              aria-pressed={active}
              onClick={() => onChannelChange(channel)}
              className={`px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider transition-colors ${
                active
                  ? 'bg-violet-500/20 text-violet-300 border border-violet-500/40'
                  : 'bg-zinc-900 text-zinc-500 border border-zinc-800 hover:text-zinc-300'
              }`}
            >
              {channel}
            </button>
          );
        })}
      </div>
      <input
        value={searchQuery}
        onChange={(event) => onSearchChange(event.target.value)}
        placeholder="Suche..."
        className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-violet-500/40"
      />
    </div>
  );
};

export default InboxFilters;
