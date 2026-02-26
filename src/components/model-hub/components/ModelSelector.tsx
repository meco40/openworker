import React from 'react';
import type { FetchedModel, CodexThinkingLevel } from '@/components/model-hub/types';

export interface ModelSelectorProps {
  isLoadingModels: boolean;
  filteredLiveModels: FetchedModel[];
  modelSearchQuery: string;
  onModelSearchQueryChange: (query: string) => void;
  selectedModelId: string;
  onSelectedModelIdChange: (modelId: string) => void;
  selectedReasoningEffort: CodexThinkingLevel;
  onSelectedReasoningEffortChange: (level: CodexThinkingLevel) => void;
  isCodexProvider?: boolean;
}

export const ModelSelector: React.FC<ModelSelectorProps> = ({
  isLoadingModels,
  filteredLiveModels,
  modelSearchQuery,
  onModelSearchQueryChange,
  selectedModelId,
  onSelectedModelIdChange,
  selectedReasoningEffort,
  onSelectedReasoningEffortChange,
  isCodexProvider,
}) => {
  const searchInputId = 'model-search-query';
  const modelSelectId = 'model-select';
  const reasoningSelectId = 'model-reasoning-effort';

  if (isLoadingModels) {
    return (
      <div className="space-y-2">
        <p className="text-[10px] font-black tracking-widest text-zinc-500 uppercase">Model</p>
        <div className="animate-pulse rounded-2xl border border-zinc-800 bg-zinc-900 p-4 text-sm text-zinc-500">
          Lade Modelle...
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label
          htmlFor={searchInputId}
          className="text-[10px] font-black tracking-widest text-zinc-500 uppercase"
        >
          Suche
        </label>
        <input
          id={searchInputId}
          type="text"
          value={modelSearchQuery}
          onChange={(e) => onModelSearchQueryChange(e.target.value)}
          placeholder="Modelle filtern..."
          className="w-full rounded-xl border border-zinc-800 bg-zinc-950 p-3 text-sm text-zinc-200 focus:border-indigo-500 focus:outline-none"
        />
      </div>

      <div className="space-y-2">
        <label
          htmlFor={modelSelectId}
          className="text-[10px] font-black tracking-widest text-zinc-500 uppercase"
        >
          Verfügbare Modelle ({filteredLiveModels.length})
        </label>
        <select
          id={modelSelectId}
          value={selectedModelId}
          onChange={(e) => onSelectedModelIdChange(e.target.value)}
          className="w-full rounded-xl border border-zinc-800 bg-zinc-950 p-3 text-sm text-zinc-200 focus:border-indigo-500 focus:outline-none"
          size={Math.min(6, Math.max(3, filteredLiveModels.length))}
        >
          {filteredLiveModels.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
              {model.context_window ? ` (${model.context_window} ctx)` : ''}
            </option>
          ))}
        </select>
      </div>

      {isCodexProvider && (
        <div className="space-y-2">
          <label
            htmlFor={reasoningSelectId}
            className="text-[10px] font-black tracking-widest text-zinc-500 uppercase"
          >
            Reasoning Effort
          </label>
          <select
            id={reasoningSelectId}
            value={selectedReasoningEffort}
            onChange={(e) => onSelectedReasoningEffortChange(e.target.value as CodexThinkingLevel)}
            className="w-full rounded-xl border border-zinc-800 bg-zinc-950 p-3 text-sm text-zinc-200 focus:border-indigo-500 focus:outline-none"
          >
            <option value="off">Off</option>
            <option value="minimal">Minimal</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="xhigh">Extra High</option>
          </select>
          <p className="text-[10px] text-zinc-600">
            Legt fest, wie viel Rechenaufwand das Modell für komplexe Aufgaben investiert.
          </p>
        </div>
      )}
    </div>
  );
};

export default ModelSelector;
