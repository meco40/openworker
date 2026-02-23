import React from 'react';
import type {
  CodexThinkingLevel,
  FetchedModel,
  ProviderAccount,
  ProviderCatalogEntry,
} from '@/components/model-hub/types';

interface AddModelModalProps {
  isOpen: boolean;
  mode: 'pipeline' | 'embedding';
  providerAccounts: ProviderAccount[];
  providerLookup: Map<string, ProviderCatalogEntry>;
  selectedAccountId: string;
  onSelectedAccountIdChange: (accountId: string) => void;
  selectedAccount: ProviderAccount | null;
  onFetchLiveModelsForAccount: (accountId: string) => void;
  onClose: () => void;
  isLoadingModels: boolean;
  liveModels: FetchedModel[];
  filteredLiveModels: FetchedModel[];
  modelSearchQuery: string;
  onModelSearchQueryChange: (query: string) => void;
  selectedModelId: string;
  onSelectedModelIdChange: (modelId: string) => void;
  selectedReasoningEffort: CodexThinkingLevel;
  onSelectedReasoningEffortChange: (reasoningEffort: CodexThinkingLevel) => void;
  selectedPriority: number;
  onSelectedPriorityChange: (priority: number) => void;
  pipelineLength: number;
  onSave: () => void;
}

const AddModelModal: React.FC<AddModelModalProps> = ({
  isOpen,
  mode,
  providerAccounts,
  providerLookup,
  selectedAccountId,
  onSelectedAccountIdChange,
  selectedAccount,
  onFetchLiveModelsForAccount,
  onClose,
  isLoadingModels,
  liveModels,
  filteredLiveModels,
  modelSearchQuery,
  onModelSearchQueryChange,
  selectedModelId,
  onSelectedModelIdChange,
  selectedReasoningEffort,
  onSelectedReasoningEffortChange,
  selectedPriority,
  onSelectedPriorityChange,
  pipelineLength,
  onSave,
}) => {
  if (!isOpen) return null;
  const isEmbeddingMode = mode === 'embedding';
  const isCodexAccount = selectedAccount?.providerId === 'openai-codex';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="max-h-[90vh] w-full max-w-2xl space-y-8 overflow-y-auto rounded-3xl border border-zinc-800 bg-zinc-900 p-8 shadow-2xl">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-2xl font-black tracking-tight text-white uppercase">
              {isEmbeddingMode ? 'Embedding-Modell hinzufügen' : 'Modell hinzufügen'}
            </h3>
            <p className="mt-1 text-sm text-zinc-500">
              {isEmbeddingMode
                ? 'Embedding-Account wählen → Modell auswählen → Priorität → Speichern'
                : 'Account wählen → Modell auswählen → Priorität → Speichern'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-xl bg-zinc-800 px-4 py-2 text-[10px] font-black tracking-widest text-zinc-300 uppercase hover:bg-zinc-700"
          >
            Schließen
          </button>
        </div>

        <div className="space-y-6">
          <div>
            <div className="mb-2 text-[10px] font-black tracking-widest text-zinc-500 uppercase">
              Step 1: Provider Account
            </div>
            <select
              value={selectedAccountId}
              onChange={(event) => {
                const id = event.target.value;
                onSelectedAccountIdChange(id);
                onSelectedModelIdChange('');
                onFetchLiveModelsForAccount(id);
              }}
              className="w-full rounded-2xl border border-zinc-800 bg-zinc-950 p-4 text-sm text-zinc-200 focus:border-indigo-500 focus:outline-none"
            >
              {providerAccounts.map((account) => {
                const provider = providerLookup.get(account.providerId);
                return (
                  <option key={account.id} value={account.id}>
                    {provider?.icon || '?'} {provider?.name || account.providerId} · {account.label}{' '}
                    ({account.authMethod})
                  </option>
                );
              })}
            </select>
            {selectedAccount && (
              <div className="mt-2 flex items-center space-x-2">
                <span className="font-mono text-[9px] text-zinc-600">
                  {selectedAccount.secretMasked}
                </span>
                {selectedAccount.lastCheckOk === true && (
                  <span className="font-mono text-[9px] text-emerald-500">✓ Verifiziert</span>
                )}
                {selectedAccount.lastCheckOk === false && (
                  <span className="font-mono text-[9px] text-rose-500">✗ Fehler</span>
                )}
              </div>
            )}
          </div>

          <div>
            <div className="mb-2 text-[10px] font-black tracking-widest text-zinc-500 uppercase">
              Step 2: Modell wählen{' '}
              {isLoadingModels && (
                <span className="ml-2 animate-pulse text-indigo-400">Lade Modelle...</span>
              )}
            </div>

            {!isLoadingModels && liveModels.length > 20 && (
              <input
                value={modelSearchQuery}
                onChange={(event) => onModelSearchQueryChange(event.target.value)}
                placeholder="Modelle durchsuchen..."
                className="mb-2 w-full rounded-2xl border border-zinc-800 bg-zinc-950 p-3 text-sm text-zinc-200 focus:border-indigo-500 focus:outline-none"
              />
            )}

            {!isLoadingModels && filteredLiveModels.length > 0 ? (
              <div className="max-h-64 overflow-y-auto rounded-2xl border border-zinc-800">
                {filteredLiveModels.map((model) => (
                  <button
                    key={model.id}
                    onClick={() => onSelectedModelIdChange(model.id)}
                    className={`flex w-full items-center justify-between border-b border-zinc-800/50 px-4 py-3 text-left transition-all last:border-0 ${
                      selectedModelId === model.id
                        ? 'bg-indigo-600/10 text-indigo-300'
                        : 'bg-zinc-950 text-zinc-300 hover:bg-zinc-800'
                    }`}
                  >
                    <div>
                      <div className="text-sm font-medium">{model.id}</div>
                      {model.name !== model.id && (
                        <div className="text-[10px] text-zinc-500">{model.name}</div>
                      )}
                    </div>
                    <div className="flex items-center space-x-2">
                      {model.context_window && (
                        <span className="font-mono text-[9px] text-zinc-600">
                          {Math.round(model.context_window / 1000)}K ctx
                        </span>
                      )}
                      {selectedModelId === model.id && (
                        <span className="text-sm text-indigo-400">✓</span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            ) : !isLoadingModels ? (
              <div className="space-y-2">
                <input
                  value={selectedModelId}
                  onChange={(event) => onSelectedModelIdChange(event.target.value)}
                  placeholder="Modell-ID manuell eingeben"
                  className="w-full rounded-2xl border border-zinc-800 bg-zinc-950 p-4 text-sm text-zinc-200 focus:border-indigo-500 focus:outline-none"
                />
                <p className="text-[10px] text-zinc-500">
                  Keine Modelle vom Provider geladen. Bitte Modell-ID manuell eingeben.
                </p>
              </div>
            ) : (
              <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-8 text-center">
                <div className="animate-pulse text-sm text-zinc-400">
                  Lade verfügbare Modelle vom Provider...
                </div>
              </div>
            )}
          </div>

          <div>
            {!isEmbeddingMode && isCodexAccount && (
              <div className="mb-6">
                <div className="mb-2 text-[10px] font-black tracking-widest text-zinc-500 uppercase">
                  Step 3: Denkstufe
                </div>
                <select
                  value={selectedReasoningEffort}
                  onChange={(event) =>
                    onSelectedReasoningEffortChange(event.target.value as CodexThinkingLevel)
                  }
                  className="w-full rounded-2xl border border-zinc-800 bg-zinc-950 p-4 text-sm text-zinc-200 focus:border-indigo-500 focus:outline-none"
                >
                  <option value="off">off</option>
                  <option value="minimal">minimal</option>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                  <option value="xhigh">xhigh</option>
                </select>
                <p className="mt-2 text-[10px] text-zinc-500">
                  Für API-Requests wird `xhigh` kompatibel als `high` übergeben.
                </p>
              </div>
            )}

            <div className="mb-2 text-[10px] font-black tracking-widest text-zinc-500 uppercase">
              Step {!isEmbeddingMode && isCodexAccount ? '4' : '3'}: Priorität
            </div>
            <select
              value={selectedPriority}
              onChange={(event) => onSelectedPriorityChange(Number(event.target.value))}
              className="w-full rounded-2xl border border-zinc-800 bg-zinc-950 p-4 text-sm text-zinc-200 focus:border-indigo-500 focus:outline-none"
            >
              {Array.from({ length: pipelineLength + 1 }, (_, index) => index + 1).map(
                (priority) => (
                  <option key={priority} value={priority}>
                    Priorität {priority} {priority === 1 ? '(Primary)' : ''}
                  </option>
                ),
              )}
            </select>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-zinc-800 pt-4">
          <button
            onClick={onClose}
            className="rounded-xl bg-zinc-800 px-5 py-3 text-[10px] font-black tracking-widest text-zinc-300 uppercase hover:bg-zinc-700"
          >
            Abbrechen
          </button>
          <button
            onClick={onSave}
            disabled={!selectedAccount || !selectedModelId}
            className="rounded-xl bg-indigo-600 px-6 py-3 text-[10px] font-black tracking-widest text-white uppercase transition-all hover:bg-indigo-500 disabled:bg-zinc-800 disabled:text-zinc-600"
          >
            {isEmbeddingMode ? 'Als Embedding speichern' : 'Speichern & Aktivieren'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AddModelModal;
