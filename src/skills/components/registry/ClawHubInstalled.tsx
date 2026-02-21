'use client';

import React from 'react';
import type { ClawHubInstalledSkill } from '@/skills/clawhub-client';

interface ClawHubInstalledProps {
  skills: ClawHubInstalledSkill[];
  loading: boolean;
  onRefresh: () => void;
  onUpdate: (slug?: string) => void;
  onUninstall: (slug: string) => void;
  onToggleEnabled: (slug: string, enabled: boolean) => void;
}

export const ClawHubInstalled: React.FC<ClawHubInstalledProps> = ({
  skills,
  loading,
  onRefresh,
  onUpdate,
  onUninstall,
  onToggleEnabled,
}) => (
  <div className="rounded-[2rem] border border-zinc-800 bg-zinc-900/60 p-6 shadow-lg">
    <div className="mb-4 flex items-center justify-between gap-3">
      <h3 className="text-sm font-black tracking-widest text-white uppercase">ClawHub Installed</h3>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onRefresh()}
          disabled={loading}
          className="rounded-xl border border-zinc-700 bg-zinc-800 px-3 py-2 text-[10px] font-black tracking-widest uppercase hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Refresh
        </button>
        <button
          onClick={() => onUpdate()}
          disabled={loading}
          className="rounded-xl bg-emerald-600/80 px-3 py-2 text-[10px] font-black tracking-widest uppercase hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Update All
        </button>
      </div>
    </div>

    <div className="max-h-60 space-y-2 overflow-auto pr-1">
      {skills.map((item) => (
        <div
          key={`${item.slug}:${item.version}`}
          className="flex items-center justify-between gap-3 rounded-xl border border-zinc-700 bg-zinc-800/60 px-3 py-2"
        >
          <div>
            <p className="text-xs font-semibold text-white">{item.title || item.slug}</p>
            <p className="mb-1 font-mono text-[10px] text-zinc-500">
              {item.slug} · v{item.version}
            </p>
            <span
              className={`inline-flex items-center rounded border px-2 py-0.5 text-[9px] font-black uppercase ${
                item.enabled
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                  : 'border-zinc-600 bg-zinc-700/30 text-zinc-400'
              }`}
            >
              {item.enabled ? 'Enabled in Prompt' : 'Disabled'}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => onToggleEnabled(item.slug, !item.enabled)}
              disabled={loading}
              className={`text-[10px] font-black tracking-widest uppercase ${
                item.enabled
                  ? 'text-amber-400 hover:text-amber-300'
                  : 'text-indigo-400 hover:text-indigo-300'
              } disabled:cursor-not-allowed disabled:opacity-50`}
            >
              {item.enabled ? 'Disable' : 'Enable'}
            </button>
            <button
              onClick={() => onUpdate(item.slug)}
              disabled={loading}
              className="text-[10px] font-black tracking-widest text-emerald-400 uppercase hover:text-emerald-300 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Update
            </button>
            <button
              onClick={() => onUninstall(item.slug)}
              disabled={loading}
              className="text-[10px] font-black tracking-widest text-rose-400 uppercase hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Uninstall
            </button>
          </div>
        </div>
      ))}
    </div>

    <p className="mt-3 text-[10px] text-zinc-500">
      ClawHub skills are managed as instruction skills (`SKILL.md`) and do not replace executable
      tool skills.
    </p>
  </div>
);
