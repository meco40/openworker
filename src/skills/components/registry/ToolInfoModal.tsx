'use client';

import React from 'react';
import type { Skill } from '@/shared/domain/types';
import type { SkillRuntimeConfigStatus } from '@/skills/runtime-config-client';
import { getToolGuide } from '@/skills/tool-guides';

interface ToolInfoModalProps {
  skill: Skill | null;
  runtimeConfigs: SkillRuntimeConfigStatus[];
  onClose: () => void;
}

export const ToolInfoModal: React.FC<ToolInfoModalProps> = ({ skill, runtimeConfigs, onClose }) => {
  if (!skill) return null;

  const toolGuide = getToolGuide(skill, runtimeConfigs);
  if (!toolGuide) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <button
        type="button"
        className="absolute inset-0 h-full w-full cursor-default"
        aria-label="Close tool info"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Tool info"
        className="relative z-10 max-h-[85vh] w-full max-w-2xl overflow-auto rounded-3xl border border-zinc-700 bg-zinc-900 p-8 shadow-2xl"
      >
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h3 className="text-xl font-black tracking-tight text-white uppercase">
              {toolGuide.title}
            </h3>
            <p className="mt-1 font-mono text-[11px] text-zinc-500">
              Function: {skill.functionName}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-xl text-zinc-500 hover:text-white"
            aria-label="Close tool info"
          >
            ✕
          </button>
        </div>

        <section className="mb-5">
          <h4 className="mb-2 text-[11px] font-black tracking-widest text-zinc-300 uppercase">
            What It Is
          </h4>
          <p className="text-sm leading-relaxed text-zinc-400">{toolGuide.whatItIs}</p>
        </section>

        <section className="mb-5">
          <h4 className="mb-2 text-[11px] font-black tracking-widest text-zinc-300 uppercase">
            What It Can Do
          </h4>
          <ul className="list-disc space-y-1 pl-5">
            {toolGuide.whatItCanDo.map((item) => (
              <li key={item} className="text-sm text-zinc-400">
                {item}
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h4 className="mb-2 text-[11px] font-black tracking-widest text-zinc-300 uppercase">
            How To Use
          </h4>
          <ul className="list-disc space-y-1 pl-5">
            {toolGuide.howToUse.map((item) => (
              <li key={item} className="text-sm text-zinc-400">
                {item}
              </li>
            ))}
          </ul>
        </section>

        <div className="mt-8 flex justify-end">
          <button
            onClick={onClose}
            className="rounded-xl bg-zinc-800 px-5 py-2.5 text-xs font-bold text-zinc-300 uppercase transition-all hover:bg-zinc-700"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
