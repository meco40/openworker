'use client';

import React, { useState } from 'react';
import type { InstallTab } from './types';

interface InstallModalProps {
  show: boolean;
  tab: InstallTab;
  value: string;
  loading: boolean;
  error: string;
  onClose: () => void;
  onTabChange: (tab: InstallTab) => void;
  onValueChange: (value: string) => void;
  onInstall: () => Promise<void>;
}

const INSTALL_TABS: [InstallTab, string][] = [
  ['github', 'GitHub URL'],
  ['npm', 'npm Package'],
  ['manifest', 'Paste Manifest'],
  ['clawhub', 'ClawHub'],
];

export const InstallModal: React.FC<InstallModalProps> = ({
  show,
  tab,
  value,
  loading,
  error,
  onClose,
  onTabChange,
  onValueChange,
  onInstall,
}) => {
  const [localError, setLocalError] = useState('');

  if (!show) return null;

  const handleInstall = async () => {
    setLocalError('');
    try {
      await onInstall();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    }
  };

  const displayError = error || localError;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-xl rounded-3xl border border-zinc-700 bg-zinc-900 p-8 shadow-2xl">
        <div className="mb-6 flex items-center justify-between">
          <h3 className="text-xl font-black tracking-tight text-white uppercase">Install Skill</h3>
          <button onClick={onClose} className="text-xl text-zinc-500 hover:text-white">
            ✕
          </button>
        </div>

        {/* Tabs */}
        <div className="mb-6 flex gap-2">
          {INSTALL_TABS.map(([t, label]) => (
            <button
              key={t}
              onClick={() => {
                onTabChange(t);
                setLocalError('');
              }}
              className={`rounded-xl px-4 py-2 text-xs font-bold tracking-wider uppercase transition-all ${
                tab === t
                  ? 'bg-indigo-600 text-white'
                  : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Input */}
        {tab === 'manifest' ? (
          <textarea
            value={value}
            onChange={(e) => onValueChange(e.target.value)}
            placeholder={'{\n  "id": "my-skill",\n  "name": "My Skill",\n  ...skill.json\n}'}
            className="h-40 w-full resize-none rounded-xl border border-zinc-700 bg-zinc-800 p-4 font-mono text-xs text-zinc-300 focus:border-indigo-500 focus:outline-none"
          />
        ) : (
          <input
            value={value}
            onChange={(e) => onValueChange(e.target.value)}
            placeholder={
              tab === 'github'
                ? 'https://github.com/user/skill-repo'
                : tab === 'npm'
                  ? '@openclaw/skill-weather'
                  : 'calendar'
            }
            className="w-full rounded-xl border border-zinc-700 bg-zinc-800 p-4 font-mono text-sm text-zinc-300 focus:border-indigo-500 focus:outline-none"
          />
        )}

        {/* Security notice */}
        <p className="mt-3 text-[10px] text-amber-500/70">
          ⚠ External skills can affect runtime behavior. Only install from trusted sources.
        </p>

        {displayError && (
          <p className="mt-3 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-400">
            {displayError}
          </p>
        )}

        <div className="mt-6 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="rounded-xl bg-zinc-800 px-6 py-3 text-xs font-bold text-zinc-400 uppercase transition-all hover:bg-zinc-700"
          >
            Cancel
          </button>
          <button
            onClick={handleInstall}
            disabled={loading || !value.trim()}
            className="rounded-xl bg-indigo-600 px-6 py-3 text-xs font-bold text-white uppercase shadow-lg shadow-indigo-500/20 transition-all hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? 'Installing…' : 'Install'}
          </button>
        </div>
      </div>
    </div>
  );
};
