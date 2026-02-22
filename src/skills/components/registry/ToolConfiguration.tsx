'use client';

import React from 'react';
import type { SkillRuntimeConfigStatus } from '@/skills/runtime-config-client';

interface ToolConfigurationProps {
  configs: SkillRuntimeConfigStatus[];
  drafts: Record<string, string>;
  loading: boolean;
  savingId: string | null;
  onRefresh: () => void;
  onDraftChange: (id: string, value: string) => void;
  onSave: (id: string) => void;
  onClear: (id: string) => void;
}

export const ToolConfiguration: React.FC<ToolConfigurationProps> = ({
  configs,
  drafts,
  loading,
  savingId,
  onRefresh,
  onDraftChange,
  onSave,
  onClear,
}) => (
  <section className="rounded-[2rem] border border-zinc-800 bg-zinc-900/60 p-6 shadow-lg">
    <div className="mb-4 flex items-center justify-between gap-3">
      <h3 className="text-sm font-black tracking-widest text-white uppercase">
        Tool Configuration
      </h3>
      <button
        onClick={() => onRefresh()}
        disabled={loading}
        className="rounded-xl border border-zinc-700 bg-zinc-800 px-3 py-2 text-[10px] font-black tracking-widest uppercase hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Refresh
      </button>
    </div>
    <p className="mb-4 text-xs text-zinc-500">
      Configure required credentials once. Skills can only be activated when required fields are
      configured.
    </p>

    <div className="space-y-3">
      {configs.map((config) => (
        <div
          key={config.id}
          className="flex flex-col gap-4 rounded-2xl border border-zinc-700 bg-zinc-800/60 p-4 lg:flex-row lg:items-center lg:justify-between"
        >
          <div className="min-w-0">
            <p className="text-xs font-semibold text-white">
              {config.label}
              {config.required ? (
                <span className="ml-1 text-rose-400" title="Required">
                  *
                </span>
              ) : null}
            </p>
            <p className="mt-1 text-[10px] text-zinc-500">{config.description}</p>
            <p className="mt-1 font-mono text-[10px] text-zinc-600">
              Env fallback: {config.envVars.join(' / ')}
            </p>
          </div>

          <div className="flex-1 lg:max-w-xl">
            <div className="mb-2 flex items-center gap-2">
              <span
                className={`rounded border px-2 py-0.5 text-[9px] font-black uppercase ${
                  config.configured
                    ? config.source === 'store'
                      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                      : 'border-amber-500/30 bg-amber-500/10 text-amber-400'
                    : 'border-zinc-600 bg-zinc-700/30 text-zinc-400'
                }`}
              >
                {config.configured
                  ? config.source === 'store'
                    ? 'Saved'
                    : 'Env Fallback'
                  : 'Missing'}
              </span>
              {config.maskedValue && (
                <span className="truncate font-mono text-[10px] text-zinc-500">
                  {config.maskedValue}
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              <input
                type={config.kind === 'secret' ? 'password' : 'text'}
                value={drafts[config.id] || ''}
                onChange={(e) => onDraftChange(config.id, e.target.value)}
                placeholder={
                  config.kind === 'secret'
                    ? `Enter ${config.label}`
                    : 'Enter value (workspace-relative path)'
                }
                className="w-full rounded-xl border border-zinc-700 bg-zinc-900 p-2.5 font-mono text-xs text-zinc-300 focus:border-indigo-500 focus:outline-none"
              />
              <button
                onClick={() => onSave(config.id)}
                disabled={savingId === config.id || !String(drafts[config.id] || '').trim()}
                className="rounded-xl bg-indigo-600 px-3 py-2 text-[10px] font-black tracking-widest uppercase hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Save
              </button>
              <button
                onClick={() => onClear(config.id)}
                disabled={savingId === config.id || !config.configured}
                className="rounded-xl border border-zinc-700 bg-zinc-800 px-3 py-2 text-[10px] font-black tracking-widest uppercase hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Clear
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  </section>
);
