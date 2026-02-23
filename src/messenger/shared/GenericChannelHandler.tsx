import React from 'react';
import { CoupledChannel } from '@/shared/domain/types';

type Accent = 'indigo' | 'sky';

interface GenericChannelHandlerProps {
  channel: CoupledChannel;
  title: string;
  icon: string;
  description: string;
  accent: Accent;
  token?: string;
  setToken?: (value: string) => void;
  tokenPlaceholder?: string;
  simMessage: string;
  setSimMessage: (value: string) => void;
  onStartPairing: () => void;
  onDisconnect: () => void;
  onSimulate: () => void;
}

const accentClasses: Record<
  Accent,
  {
    iconBg: string;
    statusBorder: string;
    statusBg: string;
    statusText: string;
    dot: string;
    button: string;
    buttonHover: string;
    sendButton: string;
    sendButtonHover: string;
    spinner: string;
    focus: string;
    badge: string;
  }
> = {
  indigo: {
    iconBg: 'bg-indigo-500/10',
    statusBorder: 'border-indigo-500/20',
    statusBg: 'bg-indigo-500/5',
    statusText: 'text-indigo-400',
    dot: 'bg-indigo-500',
    button: 'bg-indigo-600',
    buttonHover: 'hover:bg-indigo-500',
    sendButton: 'bg-indigo-700',
    sendButtonHover: 'hover:bg-indigo-600',
    spinner: 'border-indigo-500',
    focus: 'focus:border-indigo-500/50',
    badge: 'bg-indigo-500/10 text-indigo-400',
  },
  sky: {
    iconBg: 'bg-sky-500/10',
    statusBorder: 'border-sky-500/20',
    statusBg: 'bg-sky-500/5',
    statusText: 'text-sky-400',
    dot: 'bg-sky-500',
    button: 'bg-sky-600',
    buttonHover: 'hover:bg-sky-500',
    sendButton: 'bg-sky-700',
    sendButtonHover: 'hover:bg-sky-600',
    spinner: 'border-sky-500',
    focus: 'focus:border-sky-500/50',
    badge: 'bg-sky-500/10 text-sky-400',
  },
};

export const GenericChannelHandler: React.FC<GenericChannelHandlerProps> = ({
  channel,
  title,
  icon,
  description,
  accent,
  token,
  setToken,
  tokenPlaceholder,
  simMessage,
  setSimMessage,
  onStartPairing,
  onDisconnect,
  onSimulate,
}) => {
  const c = accentClasses[accent];
  const hasTokenInput = typeof token === 'string' && typeof setToken === 'function';

  if (channel.status === 'idle') {
    return (
      <div className="animate-in fade-in flex flex-col gap-5 duration-300">
        <div className="flex items-start gap-4">
          <div
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-xl ${c.iconBg}`}
          >
            {icon}
          </div>
          <div>
            <h3 className="font-semibold text-white">{title}</h3>
            <p className="mt-0.5 text-sm text-zinc-400">{description}</p>
          </div>
        </div>
        {hasTokenInput && (
          <div>
            <label className="mb-1.5 block text-xs font-medium text-zinc-400">Bot Token</label>
            <input
              type="text"
              value={token}
              onChange={(e) => setToken!(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && token && onStartPairing()}
              placeholder={tokenPlaceholder}
              className={`w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2.5 font-mono text-sm text-white placeholder-zinc-600 transition-colors ${c.focus} focus:outline-none`}
            />
          </div>
        )}
        <button
          onClick={onStartPairing}
          disabled={hasTokenInput && !token}
          className={`flex w-full items-center justify-center gap-2 rounded-lg py-3 text-sm font-semibold text-white transition-colors ${c.button} ${c.buttonHover} disabled:cursor-not-allowed disabled:opacity-40`}
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
            />
          </svg>
          Establish Bridge
        </button>
      </div>
    );
  }

  if (channel.status === 'pairing') {
    return (
      <div className="animate-in fade-in flex flex-col items-center gap-4 py-6 duration-300">
        <div
          className={`h-10 w-10 animate-spin rounded-full border-4 ${c.spinner} border-t-transparent`}
        />
        <div className="text-center">
          <p className="text-sm font-medium text-white">Connecting to {title}</p>
          <p className="mt-1 text-xs text-zinc-500">Establishing bridge…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="animate-in fade-in flex flex-col gap-5 duration-300">
      <div
        className={`flex items-center justify-between rounded-lg border px-4 py-3 ${c.statusBorder} ${c.statusBg}`}
      >
        <div className="flex items-center gap-3">
          <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${c.button}`}>
            <svg
              className="h-4 w-4 text-white"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2.5}
                d="M5 13l4 4L19 7"
              />
            </svg>
          </div>
          <div>
            <p className="text-sm font-semibold text-white">{title} Connected</p>
            {channel.peerName && (
              <p className={`mt-0.5 font-mono text-xs text-zinc-400`}>{channel.peerName}</p>
            )}
          </div>
        </div>
        <span
          className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${c.badge}`}
        >
          <span className={`h-1.5 w-1.5 animate-pulse rounded-full ${c.dot}`} />
          Live
        </span>
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-medium text-zinc-400">
          Test Inbound Message
        </label>
        <div className="flex gap-2">
          <input
            value={simMessage}
            onChange={(e) => setSimMessage(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onSimulate()}
            placeholder="Simulate an inbound message…"
            className={`flex-1 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white placeholder-zinc-600 transition-colors ${c.focus} focus:outline-none`}
          />
          <button
            onClick={onSimulate}
            className={`rounded-lg px-4 py-2 text-sm font-semibold text-white transition-colors ${c.sendButton} ${c.sendButtonHover}`}
          >
            Send
          </button>
        </div>
      </div>

      <div className="border-t border-zinc-800 pt-2">
        <button
          onClick={onDisconnect}
          className="text-sm text-zinc-500 transition-colors hover:text-rose-400"
        >
          Disconnect {title}
        </button>
      </div>
    </div>
  );
};
