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
  const tokenInputId = 'telegram-bot-token';
  const pairingCodeInputId = 'telegram-pairing-code';
  const simMessageInputId = 'telegram-sim-message';

  if (channel.status === 'idle') {
    return (
      <div className="animate-in fade-in flex flex-col gap-5 duration-300">
        <div className="flex items-start gap-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-500/10 text-xl">
            ✈️
          </div>
          <div>
            <h3 className="font-semibold text-white">Telegram Integration</h3>
            <p className="mt-0.5 text-sm text-zinc-400">
              Enter your BotFather API token to bridge Telegram traffic directly into the control
              plane.
            </p>
          </div>
        </div>
        <div>
          <label htmlFor={tokenInputId} className="mb-1.5 block text-xs font-medium text-zinc-400">
            Bot Token
          </label>
          <input
            id={tokenInputId}
            type="text"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && token && onStartPairing()}
            placeholder="TELEGRAM_API_TOKEN"
            className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2.5 font-mono text-sm text-white placeholder-zinc-600 transition-colors focus:border-blue-500/50 focus:outline-none"
          />
        </div>
        <button
          onClick={onStartPairing}
          disabled={!token}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
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
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-blue-500 border-t-transparent" />
        <div className="text-center">
          <p className="text-sm font-medium text-white">Validating Bot Token</p>
          <p className="mt-1 text-xs text-zinc-500">Contacting Telegram API…</p>
        </div>
      </div>
    );
  }

  if (channel.status === 'awaiting_code') {
    return (
      <div className="animate-in fade-in flex flex-col gap-5 duration-300">
        <div className="flex items-start gap-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-xl">
            🔐
          </div>
          <div>
            <h3 className="font-semibold text-white">Confirm Telegram Pairing</h3>
            <p className="mt-0.5 text-sm text-zinc-400">
              Send any message to your Telegram bot, then enter the pairing code you receive.
            </p>
          </div>
        </div>
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-300">
          <span className="font-semibold">Step 1:</span> Open Telegram and message your bot.
          <br />
          <span className="font-semibold">Step 2:</span> The bot replies with a pairing code — paste
          it below.
        </div>
        <div>
          <label
            htmlFor={pairingCodeInputId}
            className="mb-1.5 block text-xs font-medium text-zinc-400"
          >
            Pairing Code
          </label>
          <input
            id={pairingCodeInputId}
            type="text"
            value={pairingCode}
            onChange={(e) => setPairingCode(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && pairingCode.trim() && onConfirmPairingCode()}
            placeholder="Enter the code from the bot"
            className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2.5 font-mono text-sm text-white placeholder-zinc-600 transition-colors focus:border-blue-500/50 focus:outline-none"
          />
        </div>
        <button
          onClick={onConfirmPairingCode}
          disabled={!pairingCode.trim() || isConfirmingCode}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isConfirmingCode ? (
            <>
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
              Confirming…
            </>
          ) : (
            'Confirm Pairing Code'
          )}
        </button>
        <div className="border-t border-zinc-800 pt-2">
          <button
            onClick={onDisconnect}
            className="text-sm text-zinc-500 transition-colors hover:text-rose-400"
          >
            Cancel pairing
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="animate-in fade-in flex flex-col gap-5 duration-300">
      <div className="flex items-center justify-between rounded-lg border border-blue-500/20 bg-blue-500/5 px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600">
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
            <p className="text-sm font-semibold text-white">Telegram Bot Connected</p>
            {channel.peerName && (
              <p className="mt-0.5 font-mono text-xs text-zinc-400">{channel.peerName}</p>
            )}
          </div>
        </div>
        <span className="flex items-center gap-1.5 rounded-full bg-blue-500/10 px-2.5 py-1 text-xs font-medium text-blue-400">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
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
            placeholder="Simulate a message from Telegram…"
            className="flex-1 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white placeholder-zinc-600 transition-colors focus:border-blue-500/50 focus:outline-none"
          />
          <button
            onClick={onSimulate}
            className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-600"
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
          Disconnect Telegram
        </button>
      </div>
    </div>
  );
};
