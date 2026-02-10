import React from 'react';
import { CoupledChannel } from '../../types';

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

const accentClasses: Record<Accent, {
  icon: string;
  border: string;
  button: string;
  buttonHover: string;
  spinner: string;
  text: string;
}> = {
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
      <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-sm">
        <div className={`w-16 h-16 rounded-2xl flex items-center justify-center mx-auto shadow-xl text-3xl ${classes.icon}`}>
          {icon}
        </div>
        <h3 className="text-xl font-bold text-white">{title}</h3>
        <p className="text-zinc-500 text-sm leading-relaxed">{description}</p>
        {hasTokenInput && (
          <input
            type="text"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={tokenPlaceholder}
            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-3 text-sm text-white focus:outline-none focus:border-zinc-500 font-mono"
          />
        )}
        <button
          onClick={onStartPairing}
          disabled={hasTokenInput && !token}
          className={`w-full py-4 ${classes.button} ${classes.buttonHover} text-white font-bold rounded-lg transition-all uppercase tracking-widest shadow-lg disabled:opacity-30`}
        >
          Establish Bridge
        </button>
      </div>
    );
  }

  if (channel.status === 'pairing') {
    return (
      <div className="space-y-6 flex flex-col items-center">
        <div className={`w-12 h-12 border-4 ${classes.spinner} border-t-transparent rounded-full animate-spin`} />
        <div className={`${classes.text} font-mono text-xs font-bold uppercase`}>Handshaking...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-500 w-full max-w-sm">
      <div className={`w-20 h-20 ${classes.button} text-white rounded-full flex items-center justify-center mx-auto shadow-2xl`}>
        <svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
      </div>
      <h3 className="text-2xl font-bold text-white">{title} Live</h3>
      <div className={`mt-8 p-4 bg-zinc-950 border ${classes.border} rounded-xl space-y-4`}>
        <div className="flex space-x-2">
          <input
            value={simMessage}
            onChange={(e) => setSimMessage(e.target.value)}
            placeholder="Ingress test message..."
            className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg p-2.5 text-xs text-white focus:outline-none focus:border-zinc-500 transition-all"
          />
          <button onClick={onSimulate} className={`px-4 py-2 ${classes.button} text-white rounded-lg text-xs font-bold uppercase transition-all`}>
            Push
          </button>
        </div>
      </div>
      <button onClick={onDisconnect} className="w-full py-3 border border-rose-900/50 text-rose-500 text-[10px] font-bold rounded uppercase hover:bg-rose-950/20 transition-all tracking-widest">
        Dismantle Link
      </button>
    </div>
  );
};
