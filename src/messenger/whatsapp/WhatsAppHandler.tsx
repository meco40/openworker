import React from 'react';
import { CoupledChannel } from '@/shared/domain/types';

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
  const simMessageInputId = 'whatsapp-sim-message';

  if (channel.status === 'idle') {
    return (
      <div className="animate-in fade-in flex flex-col gap-5 duration-300">
        <div className="flex items-start gap-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-xl">
            💬
          </div>
          <div>
            <h3 className="font-semibold text-white">WhatsApp Integration</h3>
            <p className="mt-0.5 text-sm text-zinc-400">
              Link your account via the WhatsApp Multi-Device protocol. Scan the QR code to
              authenticate.
            </p>
          </div>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-4">
          <p className="mb-2 text-sm font-medium text-zinc-300">Prerequisites</p>
          <ul className="space-y-1 text-xs text-zinc-500">
            <li className="flex items-center gap-2">
              <span className="h-1 w-1 rounded-full bg-zinc-600" />
              <code className="text-zinc-400">WHATSAPP_BRIDGE_URL</code> environment variable must
              be set
            </li>
            <li className="flex items-center gap-2">
              <span className="h-1 w-1 rounded-full bg-zinc-600" />
              WhatsApp bridge service must be running and reachable
            </li>
          </ul>
        </div>
        <button
          onClick={onStartPairing}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 py-3 text-sm font-semibold text-white transition-colors hover:bg-emerald-500"
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
      <div className="animate-in fade-in flex flex-col items-center gap-6 py-4 duration-300">
        <div className="relative h-44 w-44 overflow-hidden rounded-2xl bg-white p-3 shadow-2xl">
          {/* eslint-disable-next-line @next/next/no-img-element -- external QR image source is generated at runtime */}
          <img
            src="https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=openclaw-wa-link"
            className="h-full w-full"
            alt="QR Code"
          />
          <div className="absolute inset-0 flex items-center justify-center bg-white/50 backdrop-blur-sm">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-emerald-500 border-t-transparent" />
          </div>
        </div>
        <div className="text-center">
          <p className="text-sm font-medium text-white">Awaiting QR scan</p>
          <p className="mt-1 text-xs text-zinc-500">
            Open WhatsApp → Settings → Linked Devices → Link Device
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="animate-in fade-in flex flex-col gap-5 duration-300">
      <div className="flex items-center justify-between rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-600">
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
            <p className="text-sm font-semibold text-white">WhatsApp Connected</p>
            {channel.peerName && (
              <p className="mt-0.5 font-mono text-xs text-zinc-400">{channel.peerName}</p>
            )}
          </div>
        </div>
        <span className="flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-400">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
          Live
        </span>
      </div>

      <div>
        <label
          htmlFor={simMessageInputId}
          className="mb-1.5 block text-xs font-medium text-zinc-400"
        >
          Test Inbound Message
        </label>
        <div className="flex gap-2">
          <input
            id={simMessageInputId}
            value={simMessage}
            onChange={(e) => setSimMessage(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onSimulate()}
            placeholder="Simulate a message from mobile…"
            className="flex-1 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white placeholder-zinc-600 transition-colors focus:border-emerald-500/50 focus:outline-none"
          />
          <button
            onClick={onSimulate}
            className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-600"
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
          Disconnect WhatsApp
        </button>
      </div>
    </div>
  );
};
