
import React from 'react';
import { CoupledChannel } from '../../types';

interface TelegramHandlerProps {
  channel: CoupledChannel;
  onStartPairing: () => void;
  onConfirmPairingCode: () => void;
  onDisconnect: () => void;
  pairingCode: string;
  setPairingCode: (val: string) => void;
  isConfirmingCode: boolean;
  token: string;
  setToken: (val: string) => void;
  simMessage: string;
  setSimMessage: (val: string) => void;
  onSimulate: () => void;
}

export const TelegramHandler: React.FC<TelegramHandlerProps> = ({ 
  channel,
  onStartPairing,
  onConfirmPairingCode,
  onDisconnect,
  pairingCode,
  setPairingCode,
  isConfirmingCode,
  token,
  setToken,
  simMessage,
  setSimMessage,
  onSimulate,
}) => {
  if (channel.status === 'idle') {
    return (
      <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-sm">
        <div className="w-16 h-16 bg-blue-500/10 text-blue-500 rounded-2xl flex items-center justify-center mx-auto shadow-xl text-3xl">✈️</div>
        <h3 className="text-xl font-bold text-white">Telegram Integration</h3>
        <p className="text-zinc-500 text-sm leading-relaxed">Input your BotFather API token to bridge Telegram traffic.</p>
        <input type="text" value={token} onChange={e => setToken(e.target.value)} placeholder="TELEGRAM_API_TOKEN" className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-3 text-sm text-white focus:outline-none focus:border-blue-500 font-mono" />
        <button onClick={onStartPairing} disabled={!token} className="w-full py-4 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-lg transition-all uppercase tracking-widest shadow-lg disabled:opacity-30">Establish Bridge</button>
      </div>
    );
  }

  if (channel.status === 'pairing') {
    return (
      <div className="space-y-6 flex flex-col items-center">
        <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
        <div className="text-blue-500 font-mono text-xs font-bold uppercase">Validating Bot Token...</div>
      </div>
    );
  }

  if (channel.status === 'awaiting_code') {
    return (
      <div className="space-y-6 animate-in fade-in duration-500 w-full max-w-sm">
        <div className="w-16 h-16 bg-blue-500/10 text-blue-500 rounded-2xl flex items-center justify-center mx-auto shadow-xl text-3xl">
          🔐
        </div>
        <h3 className="text-xl font-bold text-white">Confirm Telegram Pairing</h3>
        <p className="text-zinc-500 text-sm leading-relaxed">
          Send any message to your Telegram bot, then enter the received pairing code here.
        </p>
        <input
          type="text"
          value={pairingCode}
          onChange={(e) => setPairingCode(e.target.value)}
          placeholder="PAIRING_CODE"
          className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-3 text-sm text-white focus:outline-none focus:border-blue-500 font-mono"
        />
        <button
          onClick={onConfirmPairingCode}
          disabled={!pairingCode.trim() || isConfirmingCode}
          className="w-full py-4 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-lg transition-all uppercase tracking-widest shadow-lg disabled:opacity-30"
        >
          {isConfirmingCode ? 'Confirming...' : 'Confirm Pairing Code'}
        </button>
        <button
          onClick={onDisconnect}
          className="w-full py-3 border border-rose-900/50 text-rose-500 text-[10px] font-bold rounded uppercase hover:bg-rose-950/20 transition-all tracking-widest"
        >
          Cancel Pairing
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-500 w-full max-w-sm">
      <div className="w-20 h-20 bg-blue-500 text-white rounded-full flex items-center justify-center mx-auto shadow-2xl">
        <svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
      </div>
      <h3 className="text-2xl font-bold text-white">Telegram Bot Live</h3>
      <div className="mt-8 p-4 bg-zinc-950 border border-blue-500/20 rounded-xl space-y-4">
        <div className="flex space-x-2">
          <input value={simMessage} onChange={e => setSimMessage(e.target.value)} placeholder="Ingress test message..." className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg p-2.5 text-xs text-white focus:outline-none focus:border-blue-500 transition-all" />
          <button onClick={onSimulate} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-xs font-bold uppercase transition-all">Push</button>
        </div>
      </div>
      <button onClick={onDisconnect} className="w-full py-3 border border-rose-900/50 text-rose-500 text-[10px] font-bold rounded uppercase hover:bg-rose-950/20 transition-all tracking-widest">Dismantle Link</button>
    </div>
  );
};
