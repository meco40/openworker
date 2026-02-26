'use client';

import React from 'react';
import type { ModelConfigSectionProps } from '../types';
import { useValidation } from '../hooks';

export function ModelConfigSection({
  pipelineModels,
  preferredModelId,
  onPreferredModelChange,
  savingPreferredModel,
}: ModelConfigSectionProps) {
  const { activeModels, hasMultipleActiveModels } = useValidation({
    pipelineModels,
    preferredModelId,
  });

  if (activeModels.length === 0) {
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
        <div className="flex items-start gap-3">
          <svg
            className="mt-0.5 h-5 w-5 text-amber-400"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
            />
          </svg>
          <div>
            <p className="font-medium text-amber-400">Keine aktiven Modelle</p>
            <p className="mt-1 text-sm text-amber-300/70">
              Es sind keine aktiven Modelle in der Pipeline konfiguriert. Bitte füge zuerst Modelle
              im Model Hub hinzu.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Model Selection */}
      <div className="space-y-2">
        <label htmlFor="persona-preferred-model" className="text-sm font-medium text-zinc-300">
          Bevorzugtes Modell
        </label>
        <select
          id="persona-preferred-model"
          value={preferredModelId ?? ''}
          onChange={(e) => onPreferredModelChange(e.target.value ? e.target.value : null)}
          disabled={savingPreferredModel || !hasMultipleActiveModels}
          className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        >
          <option value="">
            {hasMultipleActiveModels
              ? 'Automatisch (Primary)'
              : `${activeModels[0]?.modelName} (Primary)`}
          </option>
          {activeModels.map((model) => (
            <option key={model.id} value={model.modelName}>
              {model.modelName} ({model.providerId})
            </option>
          ))}
        </select>
        {!hasMultipleActiveModels && (
          <p className="text-xs text-zinc-500">
            Es ist nur ein Modell aktiv. Die Auswahl ist auf das Primary-Modell beschränkt.
          </p>
        )}
      </div>

      {/* Active Models List */}
      <div className="space-y-2 pt-4">
        <h5 className="text-sm font-medium text-zinc-400">Aktive Modelle in Pipeline</h5>
        <div className="space-y-2">
          {activeModels
            .sort((a, b) => a.priority - b.priority)
            .map((model, index) => (
              <div
                key={model.id}
                className={`flex items-center justify-between rounded-lg border p-3 ${
                  preferredModelId === model.modelName || (!preferredModelId && index === 0)
                    ? 'border-indigo-500/50 bg-indigo-500/10'
                    : 'border-zinc-800 bg-zinc-900/50'
                }`}
              >
                <div className="flex items-center gap-3">
                  <span
                    className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
                      index === 0
                        ? 'bg-emerald-500/20 text-emerald-400'
                        : 'bg-zinc-700 text-zinc-400'
                    }`}
                  >
                    {index + 1}
                  </span>
                  <div>
                    <p className="text-sm font-medium text-white">{model.modelName}</p>
                    <p className="text-xs text-zinc-500">{model.providerId}</p>
                  </div>
                </div>
                {index === 0 && (
                  <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-xs font-medium text-emerald-400">
                    Primary
                  </span>
                )}
                {preferredModelId === model.modelName && index !== 0 && (
                  <span className="rounded-full bg-indigo-500/20 px-2 py-0.5 text-xs font-medium text-indigo-400">
                    Bevorzugt
                  </span>
                )}
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
