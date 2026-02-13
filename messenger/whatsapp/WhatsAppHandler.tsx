import React from 'react';
import { CoupledChannel } from '../../types';

interface WhatsAppHandlerProps {
  channel: CoupledChannel;
  onStartPairing: () => void;
  onDisconnect: () => void;
  simMessage: string;
  setSimMessage: (val: string) => void;
  onSimulate: () => void;
}

export const WhatsAppHandler: React.FC<WhatsAppHandlerProps> = ({
  channel,
  onStartPairing,
  onDisconnect,
  simMessage,
  setSimMessage,
  onSimulate,
}) => {
  if (channel.status === 'idle') {
    return (
      <div className="animate-in fade-in slide-in-from-bottom-4 max-w-sm space-y-6 duration-500">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-500/10 text-3xl text-emerald-500 shadow-xl">
          💬
        </div>
        <h3 className="text-xl font-bold text-white">WhatsApp Integration</h3>
        <p className="text-sm leading-relaxed text-zinc-500">
          Scan the QR code to link your account via Multi-Device protocol.
        </p>
        <button
          onClick={onStartPairing}
          className="w-full rounded-lg bg-emerald-600 py-4 font-bold tracking-widest text-white uppercase shadow-lg transition-all hover:bg-emerald-700"
        >
          Establish Bridge
        </button>
      </div>
    );
  }

  if (channel.status === 'pairing') {
    return (
      <div className="flex flex-col items-center space-y-6">
        <div className="relative h-48 w-48 overflow-hidden rounded-xl bg-white p-4 shadow-2xl">
          {/* eslint-disable-next-line @next/next/no-img-element -- external QR image source is generated at runtime */}
          <img
            src="https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=openclaw-wa-link"
            className="h-full w-full"
            alt="QR"
          />
          <div className="absolute inset-0 flex items-center justify-center bg-white/40 backdrop-blur-sm">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-emerald-500 border-t-transparent" />
          </div>
        </div>
        <div className="font-mono text-xs font-bold text-emerald-500 uppercase">Handshaking...</div>
      </div>
    );
  }

  return (
    <div className="animate-in fade-in w-full max-w-sm space-y-6 duration-500">
      <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-emerald-500 text-white shadow-2xl">
        <svg className="h-10 w-10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
        </svg>
      </div>
      <div>
        <h3 className="text-2xl font-bold text-white">WhatsApp Bridge Live</h3>
        <p className="mt-1 font-mono text-xs text-zinc-500 uppercase">
          Status: E2E_ENCRYPTED_STREAM
        </p>
      </div>
      <div className="mt-8 space-y-4 rounded-xl border border-emerald-500/20 bg-zinc-950 p-4">
        <div className="flex items-center justify-center space-x-2 text-[10px] font-black tracking-widest text-emerald-500 uppercase">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
          <span>Input Simulator</span>
        </div>
        <div className="flex space-x-2">
          <input
            value={simMessage}
            onChange={(e) => setSimMessage(e.target.value)}
            placeholder="Message from mobile..."
            className="flex-1 rounded-lg border border-zinc-800 bg-zinc-900 p-2.5 text-xs text-white transition-all focus:border-emerald-500 focus:outline-none"
          />
          <button
            onClick={onSimulate}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-bold text-white uppercase transition-all"
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
