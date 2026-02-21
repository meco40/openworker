'use client';

import React from 'react';
import type { Skill } from '@/shared/domain/types';
import type { SkillRuntimeConfigStatus } from '@/skills/runtime-config-client';
import { SOURCE_LABELS } from './types';
import { buildSkillConfigHints } from '@/skills/runtime-config-hints';

interface SkillCardProps {
  skill: Skill;
  runtimeConfigs: SkillRuntimeConfigStatus[];
  onToggleInstall: (id: string) => void;
  onRemove: (id: string) => void;
  onInfo: (id: string) => void;
}

export const SkillCard: React.FC<SkillCardProps> = ({
  skill,
  runtimeConfigs,
  onToggleInstall,
  onRemove,
  onInfo,
}) => {
  const sourceMeta = SOURCE_LABELS[skill.source] ?? SOURCE_LABELS['built-in'];
  const requiredConfigs = runtimeConfigs.filter(
    (config) => config.skillId === skill.id && config.required,
  );
  const missingRequiredConfigs = requiredConfigs.filter((config) => !config.configured);
  const setupRequired = missingRequiredConfigs.length > 0;
  const hints = buildSkillConfigHints(skill.id, runtimeConfigs);

  return (
    <div className="group relative flex h-[300px] flex-col overflow-hidden rounded-[2rem] border border-zinc-800 bg-zinc-900/60 p-6 shadow-lg transition-all hover:border-indigo-500/50">
      <div className="mb-3 flex items-center justify-between">
        <span
          className={`rounded border px-2 py-0.5 text-[8px] font-black uppercase ${
            skill.installed
              ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-500'
              : setupRequired
                ? 'border-amber-500/30 bg-amber-500/10 text-amber-400'
                : 'border-zinc-700 bg-zinc-800 text-zinc-500'
          }`}
        >
          {skill.installed ? 'Runtime: Active' : setupRequired ? 'Setup Required' : 'Available'}
        </span>
        <div className="flex items-center gap-2">
          <span
            className={`rounded border px-2 py-0.5 text-[8px] font-black uppercase ${sourceMeta.color}`}
          >
            {sourceMeta.label}
          </span>
          <span className="font-mono text-[9px] text-zinc-600">v{skill.version}</span>
        </div>
      </div>

      <div className="mb-2 flex items-start gap-2">
        <h3 className="text-lg leading-tight font-bold text-white transition-colors group-hover:text-indigo-400">
          {skill.name}
        </h3>
        <button
          type="button"
          aria-label={`Open info for ${skill.name}`}
          onClick={() => onInfo(skill.id)}
          className="mt-0.5 h-5 w-5 shrink-0 rounded-full border border-zinc-700 text-[10px] font-black text-zinc-300 transition-colors hover:border-zinc-500 hover:text-white"
          title={`Info: ${skill.name}`}
        >
          i
        </button>
      </div>
      <p className="mb-4 line-clamp-3 flex-1 text-xs text-zinc-500">{skill.description}</p>
      {hints.requiredHint && (
        <p className="mb-1 line-clamp-2 text-[10px] text-amber-300">{hints.requiredHint}</p>
      )}
      {hints.optionalHint && (
        <p className="mb-2 line-clamp-2 text-[10px] text-zinc-400">{hints.optionalHint}</p>
      )}

      {skill.sourceUrl && (
        <p className="mb-3 truncate font-mono text-[9px] text-zinc-600">{skill.sourceUrl}</p>
      )}

      {setupRequired && (
        <p className="mb-3 line-clamp-2 text-[10px] text-amber-400">
          Missing: {missingRequiredConfigs.map((config) => config.label).join(', ')}
        </p>
      )}

      <div className="mt-auto flex items-center justify-between border-t border-zinc-800/50 pt-4">
        <span className="text-[10px] font-black tracking-tighter text-zinc-600 uppercase">
          {skill.category}
        </span>
        <div className="flex items-center gap-3">
          {skill.source !== 'built-in' && (
            <button
              onClick={() => onRemove(skill.id)}
              className="text-[10px] font-black tracking-widest text-zinc-600 uppercase transition-colors hover:text-red-400"
            >
              Remove
            </button>
          )}
          <button
            onClick={() => onToggleInstall(skill.id)}
            disabled={!skill.installed && setupRequired}
            className={`text-[10px] font-black tracking-widest uppercase transition-all ${
              skill.installed
                ? 'text-rose-500 hover:text-rose-400'
                : 'text-indigo-500 hover:text-indigo-400'
            } disabled:cursor-not-allowed disabled:text-zinc-500`}
          >
            {skill.installed ? 'Deactivate' : 'Activate'}
          </button>
        </div>
      </div>
    </div>
  );
};
