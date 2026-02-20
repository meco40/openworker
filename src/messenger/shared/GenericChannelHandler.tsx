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
    icon: string;
    border: string;
    button: string;
    buttonHover: string;
    spinner: string;
    text: string;
  }
> = {
  indigo: {
    icon: 'bg-indigo-500/10 text-indigo-500',
    border: 'border-indigo-500/20',
    button: 'bg-indigo-600',
    buttonHover: 'hover:bg-indigo-700',
    spinner: 'border-indigo-500',
    text: 'text-indigo-500',
  },
  sky: {
    icon: 'bg-sky-500/10 text-sky-500',
    border: 'border-sky-500/20',
    button: 'bg-sky-600',
    buttonHover: 'hover:bg-sky-700',
    spinner: 'border-sky-500',
    text: 'text-sky-500',
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
  const classes = accentClasses[accent];
  const hasTokenInput = typeof token === 'string' && typeof setToken === 'function';

  if (channel.status === 'idle') {
    return (
      <div className="animate-in fade-in slide-in-from-bottom-4 max-w-sm space-y-6 duration-500">
        <div
          className={`mx-auto flex h-16 w-16 items-center justify-center rounded-2xl text-3xl shadow-xl ${classes.icon}`}
        >
          {icon}
        </div>
        <h3 className="text-xl font-bold text-white">{title}</h3>
        <p className="text-sm leading-relaxed text-zinc-500">{description}</p>
        {hasTokenInput && (
          <input
            type="text"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={tokenPlaceholder}
            className="w-full rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-sm text-white focus:border-zinc-500 focus:outline-none"
          />
        )}
        <button
          onClick={onStartPairing}
          disabled={hasTokenInput && !token}
          className={`w-full py-4 ${classes.button} ${classes.buttonHover} rounded-lg font-bold tracking-widest text-white uppercase shadow-lg transition-all disabled:opacity-30`}
        >
          Establish Bridge
        </button>
      </div>
    );
  }

  if (channel.status === 'pairing') {
    return (
      <div className="flex flex-col items-center space-y-6">
        <div
          className={`h-12 w-12 border-4 ${classes.spinner} animate-spin rounded-full border-t-transparent`}
        />
        <div className={`${classes.text} font-mono text-xs font-bold uppercase`}>
          Handshaking...
        </div>
      </div>
    );
  }

  return (
    <div className="animate-in fade-in w-full max-w-sm space-y-6 duration-500">
      <div
        className={`h-20 w-20 ${classes.button} mx-auto flex items-center justify-center rounded-full text-white shadow-2xl`}
      >
        <svg className="h-10 w-10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
        </svg>
      </div>
      <h3 className="text-2xl font-bold text-white">{title} Live</h3>
      <div className={`mt-8 border bg-zinc-950 p-4 ${classes.border} space-y-4 rounded-xl`}>
        <div className="flex space-x-2">
          <input
            value={simMessage}
            onChange={(e) => setSimMessage(e.target.value)}
            placeholder="Ingress test message..."
            className="flex-1 rounded-lg border border-zinc-800 bg-zinc-900 p-2.5 text-xs text-white transition-all focus:border-zinc-500 focus:outline-none"
          />
          <button
            onClick={onSimulate}
            className={`px-4 py-2 ${classes.button} rounded-lg text-xs font-bold text-white uppercase transition-all`}
          >
            Push
          </button>
        </div>
      </div>
      <button
        onClick={onDisconnect}
        className="w-full rounded border border-rose-900/50 py-3 text-[10px] font-bold tracking-widest text-rose-500 uppercase transition-all hover:bg-rose-950/20"
      >
        Dismantle Link
      </button>
    </div>
  );
};
