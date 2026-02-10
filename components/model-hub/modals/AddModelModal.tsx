import React from 'react';
import type { FetchedModel, ProviderAccount, ProviderCatalogEntry } from '../types';

interface AddModelModalProps {
  isOpen: boolean;
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
  selectedPriority: number;
  onSelectedPriorityChange: (priority: number) => void;
  pipelineLength: number;
  onSave: () => void;
}

const AddModelModal: React.FC<AddModelModalProps> = ({
  isOpen,
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
  selectedPriority,
  onSelectedPriorityChange,
  pipelineLength,
  onSave,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-2xl bg-zinc-900 border border-zinc-800 rounded-3xl shadow-2xl p-8 space-y-8 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-2xl font-black text-white uppercase tracking-tight">Modell hinzufügen</h3>
            <p className="text-sm text-zinc-500 mt-1">Account wählen → Modell auswählen → Priorität → Speichern</p>
          </div>
          <button onClick={onClose} className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-xl text-[10px] font-black uppercase tracking-widest">
            Schließen
          </button>
        </div>

        <div className="space-y-6">
          <div>
            <div className="text-[10px] font-black uppercase tracking-widest text-zinc-500 mb-2">Step 1: Provider Account</div>
            <select
              value={selectedAccountId}
              onChange={(event) => {
                const id = event.target.value;
                onSelectedAccountIdChange(id);
                onSelectedModelIdChange('');
                onFetchLiveModelsForAccount(id);
              }}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-2xl p-4 text-sm text-zinc-200 focus:outline-none focus:border-indigo-500"
            >
              {providerAccounts.map((account) => {
                const provider = providerLookup.get(account.providerId);
                return (
                  <option key={account.id} value={account.id}>
                    {provider?.icon || '?'} {provider?.name || account.providerId} · {account.label} ({account.authMethod})
                  </option>
                );
              })}
            </select>
            {selectedAccount && (
              <div className="flex items-center space-x-2 mt-2">
                <span className="text-[9px] text-zinc-600 font-mono">{selectedAccount.secretMasked}</span>
                {selectedAccount.lastCheckOk === true && <span className="text-[9px] text-emerald-500 font-mono">✓ Verifiziert</span>}
                {selectedAccount.lastCheckOk === false && <span className="text-[9px] text-rose-500 font-mono">✗ Fehler</span>}
              </div>
            )}
          </div>

          <div>
            <div className="text-[10px] font-black uppercase tracking-widest text-zinc-500 mb-2">
              Step 2: Modell wählen {isLoadingModels && <span className="text-indigo-400 animate-pulse ml-2">Lade Modelle...</span>}
            </div>

            {!isLoadingModels && liveModels.length > 20 && (
              <input
                value={modelSearchQuery}
                onChange={(event) => onModelSearchQueryChange(event.target.value)}
                placeholder="Modelle durchsuchen..."
                className="w-full bg-zinc-950 border border-zinc-800 rounded-2xl p-3 text-sm text-zinc-200 focus:outline-none focus:border-indigo-500 mb-2"
              />
            )}

            {!isLoadingModels && filteredLiveModels.length > 0 ? (
              <div className="max-h-64 overflow-y-auto border border-zinc-800 rounded-2xl">
                {filteredLiveModels.map((model) => (
                  <button
                    key={model.id}
                    onClick={() => onSelectedModelIdChange(model.id)}
                    className={`w-full text-left px-4 py-3 flex items-center justify-between border-b border-zinc-800/50 last:border-0 transition-all ${
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
                        <span className="text-[9px] font-mono text-zinc-600">{Math.round(model.context_window / 1000)}K ctx</span>
                      )}
                      {selectedModelId === model.id && (
                        <span className="text-indigo-400 text-sm">✓</span>
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
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-2xl p-4 text-sm text-zinc-200 focus:outline-none focus:border-indigo-500"
                />
                <p className="text-[10px] text-zinc-500">
                  Keine Modelle vom Provider geladen. Bitte Modell-ID manuell eingeben.
                </p>
              </div>
            ) : (
              <div className="bg-zinc-950 border border-zinc-800 rounded-2xl p-8 text-center">
                <div className="text-sm text-zinc-400 animate-pulse">Lade verfügbare Modelle vom Provider...</div>
              </div>
            )}
          </div>

          <div>
            <div className="text-[10px] font-black uppercase tracking-widest text-zinc-500 mb-2">Step 3: Priorität</div>
            <select value={selectedPriority} onChange={(event) => onSelectedPriorityChange(Number(event.target.value))} className="w-full bg-zinc-950 border border-zinc-800 rounded-2xl p-4 text-sm text-zinc-200 focus:outline-none focus:border-indigo-500">
              {Array.from({ length: pipelineLength + 1 }, (_, index) => index + 1).map((priority) => (
                <option key={priority} value={priority}>Priorität {priority} {priority === 1 ? '(Primary)' : ''}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 pt-4 border-t border-zinc-800">
          <button onClick={onClose} className="px-5 py-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-xl text-[10px] font-black uppercase tracking-widest">
            Abbrechen
          </button>
          <button onClick={onSave} disabled={!selectedAccount || !selectedModelId} className="px-6 py-3 bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest transition-all">
            Speichern & Aktivieren
          </button>
        </div>
      </div>
    </div>
  );
};

export default AddModelModal;
