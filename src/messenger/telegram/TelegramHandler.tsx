import React from 'react';
import { CoupledChannel } from '@/shared/domain/types';

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
      <div className="animate-in fade-in slide-in-from-bottom-4 max-w-sm space-y-6 duration-500">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-500/10 text-3xl text-blue-500 shadow-xl">
          ✈️
        </div>
        <h3 className="text-xl font-bold text-white">Telegram Integration</h3>
        <p className="text-sm leading-relaxed text-zinc-500">
          Input your BotFather API token to bridge Telegram traffic.
        </p>
        <input
          type="text"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="TELEGRAM_API_TOKEN"
          className="w-full rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-sm text-white focus:border-blue-500 focus:outline-none"
        />
        <button
          onClick={onStartPairing}
          disabled={!token}
          className="w-full rounded-lg bg-blue-600 py-4 font-bold tracking-widest text-white uppercase shadow-lg transition-all hover:bg-blue-700 disabled:opacity-30"
        >
          Establish Bridge
        </button>
      </div>
    );
  }

  if (channel.status === 'pairing') {
    return (
      <div className="flex flex-col items-center space-y-6">
        <div className="h-12 w-12 animate-spin rounded-full border-4 border-blue-500 border-t-transparent" />
        <div className="font-mono text-xs font-bold text-blue-500 uppercase">
          Validating Bot Token...
        </div>
      </div>
    );
  }

  if (channel.status === 'awaiting_code') {
    return (
      <div className="animate-in fade-in w-full max-w-sm space-y-6 duration-500">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-500/10 text-3xl text-blue-500 shadow-xl">
          🔐
        </div>
        <h3 className="text-xl font-bold text-white">Confirm Telegram Pairing</h3>
        <p className="text-sm leading-relaxed text-zinc-500">
          Send any message to your Telegram bot, then enter the received pairing code here.
        </p>
        <input
          type="text"
          value={pairingCode}
          onChange={(e) => setPairingCode(e.target.value)}
          placeholder="PAIRING_CODE"
          className="w-full rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-sm text-white focus:border-blue-500 focus:outline-none"
        />
        <button
          onClick={onConfirmPairingCode}
          disabled={!pairingCode.trim() || isConfirmingCode}
          className="w-full rounded-lg bg-blue-600 py-4 font-bold tracking-widest text-white uppercase shadow-lg transition-all hover:bg-blue-700 disabled:opacity-30"
        >
          {isConfirmingCode ? 'Confirming...' : 'Confirm Pairing Code'}
        </button>
        <button
          onClick={onDisconnect}
          className="w-full rounded border border-rose-900/50 py-3 text-[10px] font-bold tracking-widest text-rose-500 uppercase transition-all hover:bg-rose-950/20"
        >
          Cancel Pairing
        </button>
      </div>
    );
  }

  return (
    <div className="animate-in fade-in w-full max-w-sm space-y-6 duration-500">
      <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-blue-500 text-white shadow-2xl">
        <svg className="h-10 w-10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
        </svg>
      </div>
      <h3 className="text-2xl font-bold text-white">Telegram Bot Live</h3>
      <div className="mt-8 space-y-4 rounded-xl border border-blue-500/20 bg-zinc-950 p-4">
        <div className="flex space-x-2">
          <input
            value={simMessage}
            onChange={(e) => setSimMessage(e.target.value)}
            placeholder="Ingress test message..."
            className="flex-1 rounded-lg border border-zinc-800 bg-zinc-900 p-2.5 text-xs text-white transition-all focus:border-blue-500 focus:outline-none"
          />
          <button
            onClick={onSimulate}
            className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-bold text-white uppercase transition-all"
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
