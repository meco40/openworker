'use client';

import React, { useState } from 'react';
import { CRON_TEMPLATES } from '@/modules/cron/cronTemplates';
import type { CronRuleDraft } from '@/modules/cron/hooks/useCronRules';

interface CronTemplateSelectorProps {
  onApply: (draft: Partial<CronRuleDraft>) => void;
}

export const CronTemplateSelector: React.FC<CronTemplateSelectorProps> = ({ onApply }) => {
  const [appliedId, setAppliedId] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);

  const handleApply = (templateId: string, draft: CronRuleDraft) => {
    onApply(draft);
    setAppliedId(templateId);
    // Clear the "applied" feedback after 2 seconds
    setTimeout(() => setAppliedId(null), 2000);
  };

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50">
      <button
        type="button"
        onClick={() => setIsExpanded((prev) => !prev)}
        className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-zinc-800/30"
        aria-expanded={isExpanded}
      >
        <div className="flex items-center gap-2">
          <span className="text-base">⚡</span>
          <span className="text-xs font-bold tracking-widest text-zinc-300 uppercase">
            Quick Templates
          </span>
          <span className="rounded bg-indigo-900/40 px-1.5 py-0.5 text-[10px] font-bold text-indigo-400">
            {CRON_TEMPLATES.length}
          </span>
        </div>
        <svg
          className={`h-4 w-4 text-zinc-500 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isExpanded && (
        <div className="border-t border-zinc-800 p-3">
          <p className="mb-3 text-[11px] text-zinc-500">
            Select a template to pre-fill the form. All fields remain editable after applying.
          </p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
            {CRON_TEMPLATES.map((template) => {
              const isApplied = appliedId === template.id;
              return (
                <button
                  key={template.id}
                  type="button"
                  onClick={() => handleApply(template.id, template.draft)}
                  className={`group flex items-start gap-3 rounded-lg border p-3 text-left transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                    isApplied
                      ? 'border-emerald-700/50 bg-emerald-900/20'
                      : 'border-zinc-700/50 bg-zinc-800/30 hover:border-indigo-700/50 hover:bg-indigo-900/10'
                  }`}
                >
                  <span className="mt-0.5 text-lg leading-none">{template.icon}</span>
                  <div className="min-w-0 flex-1">
                    <div
                      className={`text-xs font-bold ${isApplied ? 'text-emerald-300' : 'text-zinc-200 group-hover:text-white'}`}
                    >
                      {isApplied ? '✓ Template applied' : template.label}
                    </div>
                    <div className="mt-0.5 text-[10px] text-zinc-500">{template.description}</div>
                    <code className="mt-1 block font-mono text-[10px] text-indigo-400/80">
                      {template.draft.cronExpression}
                    </code>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
