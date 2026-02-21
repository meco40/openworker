'use client';

import React, { useCallback, useEffect, useState } from 'react';

interface BotStatus {
  botId: string;
  personaId: string;
  peerName: string | null;
  transport: 'webhook' | 'polling';
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

interface PersonaTelegramBotSectionProps {
  personaId: string;
}

export function PersonaTelegramBotSection({ personaId }: PersonaTelegramBotSectionProps) {
  const [bot, setBot] = useState<BotStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const fetchBot = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/personas/${personaId}/telegram`);
      const data = (await res.json()) as { ok: boolean; bot?: BotStatus; error?: string };
      if (data.ok) {
        setBot(data.bot ?? null);
      } else {
        setError(data.error ?? 'Fehler beim Laden');
      }
    } catch {
      setError('Netzwerkfehler');
    } finally {
      setLoading(false);
    }
  }, [personaId]);

  useEffect(() => {
    void fetchBot();
  }, [fetchBot]);

  async function handleConnect(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!tokenInput.trim()) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch(`/api/personas/${personaId}/telegram`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: tokenInput.trim() }),
      });
      const data = (await res.json()) as {
        ok: boolean;
        result?: { peerName?: string };
        error?: string;
      };
      if (data.ok) {
        setSuccess(`Bot verbunden${data.result?.peerName ? ` als @${data.result.peerName}` : ''}!`);
        setTokenInput('');
        await fetchBot();
      } else {
        setError(data.error ?? 'Verbindung fehlgeschlagen');
      }
    } catch {
      setError('Netzwerkfehler');
    } finally {
      setSaving(false);
    }
  }

  async function handleDisconnect() {
    if (!confirm('Telegram Bot von dieser Persona trennen?')) return;
    setDisconnecting(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch(`/api/personas/${personaId}/telegram`, { method: 'DELETE' });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (data.ok) {
        setSuccess('Bot getrennt.');
        setBot(null);
      } else {
        setError(data.error ?? 'Trennen fehlgeschlagen');
      }
    } catch {
      setError('Netzwerkfehler');
    } finally {
      setDisconnecting(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-2 border-t border-zinc-800 pt-6">
        <h4 className="text-lg font-bold text-white">Telegram Bot</h4>
        <p className="text-sm text-zinc-500">Lade...</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 border-t border-zinc-800 pt-6">
      <div className="space-y-1">
        <h4 className="text-lg font-bold text-white">Telegram Bot</h4>
        <p className="text-sm text-zinc-400">
          Verbinde einen eigenen Telegram Bot mit dieser Persona. Jede Persona erhält ihren eigenen
          Bot — Nachrichten laufen getrennt und landen direkt beim richtigen Gesprächspartner.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {success && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-400">
          {success}
        </div>
      )}

      {bot ? (
        <div className="space-y-3 rounded-lg border border-zinc-700 bg-zinc-900 p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-sky-500/20 text-sky-400">
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
                  <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.894 8.221-1.97 9.28c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.12l-6.869 4.326-2.96-.924c-.643-.204-.657-.643.136-.953l11.57-4.461c.537-.194 1.006.131.83.94z" />
                </svg>
              </span>
              <div>
                <p className="text-sm font-medium text-white">
                  {bot.peerName ? `@${bot.peerName}` : 'Telegram Bot'}
                </p>
                <p className="text-xs text-zinc-500">
                  {bot.transport === 'polling' ? 'Polling' : 'Webhook'} ·{' '}
                  {bot.active ? (
                    <span className="text-emerald-400">Aktiv</span>
                  ) : (
                    <span className="text-amber-400">Inaktiv</span>
                  )}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void handleDisconnect()}
              disabled={disconnecting}
              className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {disconnecting ? 'Trenne...' : 'Trennen'}
            </button>
          </div>
          <p className="font-mono text-xs text-zinc-600">ID: {bot.botId}</p>
        </div>
      ) : (
        <form onSubmit={(e) => void handleConnect(e)} className="space-y-3">
          <div className="space-y-1.5">
            <label htmlFor={`tg-token-${personaId}`} className="text-sm font-medium text-zinc-300">
              Bot Token
            </label>
            <input
              id={`tg-token-${personaId}`}
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="123456789:ABCdefGHI..."
              autoComplete="off"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-sm text-white placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none"
            />
            <p className="text-xs text-zinc-600">
              Erstelle einen Bot via{' '}
              <a
                href="https://t.me/BotFather"
                target="_blank"
                rel="noopener noreferrer"
                className="text-sky-500 hover:underline"
              >
                @BotFather
              </a>{' '}
              und füge das Token hier ein.
            </p>
          </div>
          <button
            type="submit"
            disabled={saving || !tokenInput.trim()}
            className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? 'Verbinde...' : 'Bot verbinden'}
          </button>
        </form>
      )}
    </div>
  );
}
