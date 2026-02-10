import React from 'react';
import { CAPABILITY_LABELS } from '../constants';
import type { ProviderAccount, ProviderCatalogEntry, PipelineModel } from '../types';

interface PipelineSectionProps {
  isLoadingPipeline: boolean;
  pipeline: PipelineModel[];
  providerLookup: Map<string, ProviderCatalogEntry>;
  providerAccounts: ProviderAccount[];
  onOpenAddModelModal: () => void;
  onToggleModelStatus: (modelId: string, currentStatus: string) => void;
  onRemoveModelFromPipeline: (modelId: string) => void;
  isLoadingAccounts: boolean;
  deletingAccountId: string | null;
  onSetDeletingAccountId: (accountId: string | null) => void;
  onDeleteAccount: (accountId: string) => void;
}

const PipelineSection: React.FC<PipelineSectionProps> = ({
  isLoadingPipeline,
  pipeline,
  providerLookup,
  providerAccounts,
  onOpenAddModelModal,
  onToggleModelStatus,
  onRemoveModelFromPipeline,
  isLoadingAccounts,
  deletingAccountId,
  onSetDeletingAccountId,
  onDeleteAccount,
}) => {
  return (
    <div className="lg:col-span-2 space-y-6">
      <div className="flex items-center justify-between gap-4 px-2">
        <h3 className="text-xs font-black text-zinc-500 uppercase tracking-[0.2em] flex items-center space-x-2">
          <svg className="w-4 h-4 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h7" strokeWidth="2" strokeLinecap="round" /></svg>
          <span>Active Model Pipeline</span>
        </h3>
        <button onClick={onOpenAddModelModal} disabled={providerAccounts.length === 0} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest transition-all">
          Model hinzufügen
        </button>
      </div>

      <div className="space-y-4">
        {isLoadingPipeline ? (
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-8 text-center">
            <div className="text-sm text-zinc-500 animate-pulse">Pipeline wird geladen...</div>
          </div>
        ) : pipeline.length === 0 ? (
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-8 text-center">
            <div className="text-sm font-bold text-white">Keine Modelle konfiguriert</div>
            <p className="text-xs text-zinc-500 mt-2">
              Verbinde zuerst einen Provider-Account und füge danach ein Modell hinzu.
            </p>
          </div>
        ) : (
          pipeline.map((model, idx) => {
            const provider = providerLookup.get(model.providerId);
            const account = providerAccounts.find((entry) => entry.id === model.accountId);
            return (
              <div
                key={model.id}
                className={`bg-zinc-900 border transition-all duration-300 rounded-2xl p-6 flex items-center group relative ${
                  model.status === 'active'
                    ? 'border-zinc-800'
                    : model.status === 'rate-limited'
                      ? 'border-amber-500/30 opacity-70'
                      : 'border-rose-500/30 opacity-50 grayscale'
                }`}
              >
                <div className="w-12 h-12 rounded-xl bg-zinc-950 border border-zinc-800 flex items-center justify-center text-xl mr-6 shadow-inner shrink-0">
                  {provider?.icon ?? '?'}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center space-x-2">
                    <h4 className="font-bold text-white text-base truncate tracking-tight">{model.modelName}</h4>
                    {idx === 0 && <span className="bg-emerald-500/10 text-emerald-500 text-[8px] font-black uppercase px-2 py-0.5 rounded border border-emerald-500/20">Primary</span>}
                    {model.status === 'rate-limited' && <span className="bg-amber-500/10 text-amber-500 text-[8px] font-black uppercase px-2 py-0.5 rounded border border-amber-500/20">Rate Limited</span>}
                  </div>
                  <div className="flex items-center space-x-3 mt-1 flex-wrap">
                    <span className="text-[10px] text-zinc-600 font-mono uppercase">Provider: {provider?.name ?? model.providerId}</span>
                    {account && (
                      <>
                        <span className="text-zinc-800">·</span>
                        <span className="text-[10px] text-zinc-600 font-mono">{account.label}</span>
                      </>
                    )}
                    <span className="text-zinc-800">·</span>
                    <span className="text-[10px] text-zinc-600 font-mono">P{model.priority}</span>
                    <span className="text-zinc-800">·</span>
                    <span className={`text-[9px] font-black uppercase ${
                      model.status === 'active' ? 'text-emerald-500' : model.status === 'rate-limited' ? 'text-amber-500' : 'text-rose-500'
                    }`}>{model.status}</span>
                  </div>
                  {provider && provider.capabilities.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {provider.capabilities.map((capability) => (
                        <span key={capability} className="text-[8px] font-mono bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded">
                          {CAPABILITY_LABELS[capability] || capability}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button onClick={() => onToggleModelStatus(model.id, model.status)} className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-white rounded-xl text-[9px] font-black uppercase tracking-widest transition-all">
                    {model.status === 'active' ? 'Disable' : 'Enable'}
                  </button>
                  <button onClick={() => onRemoveModelFromPipeline(model.id)} className="px-3 py-2 bg-zinc-800 hover:bg-rose-900/50 text-zinc-400 hover:text-rose-400 rounded-xl text-[9px] font-black uppercase tracking-widest transition-all">
                    ✕
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="space-y-4 mt-10">
        <h3 className="text-xs font-black text-zinc-500 uppercase tracking-[0.2em] px-2">Verbundene Accounts ({providerAccounts.length})</h3>
        {isLoadingAccounts ? (
          <div className="text-sm text-zinc-500 px-2 animate-pulse">Lädt...</div>
        ) : providerAccounts.length === 0 ? (
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 text-center">
            <p className="text-xs text-zinc-500">Noch keine Accounts verbunden.</p>
          </div>
        ) : (
          providerAccounts.map((account) => {
            const provider = providerLookup.get(account.providerId);
            const modelsInPipeline = pipeline.filter((model) => model.accountId === account.id).length;
            return (
              <div key={account.id} className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 flex items-center">
                <div className="w-10 h-10 rounded-lg bg-zinc-950 border border-zinc-800 flex items-center justify-center text-lg mr-4 shrink-0">
                  {provider?.icon || '?'}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center space-x-2">
                    <span className="font-bold text-white text-sm truncate">{account.label}</span>
                    <span className="text-[8px] font-mono bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded uppercase">
                      {account.authMethod === 'oauth' ? 'OAuth' : 'API Key'}
                    </span>
                    {account.lastCheckOk === true && <span className="w-2 h-2 rounded-full bg-emerald-500" title="Letzte Prüfung OK" />}
                    {account.lastCheckOk === false && <span className="w-2 h-2 rounded-full bg-rose-500" title="Letzte Prüfung fehlgeschlagen" />}
                  </div>
                  <div className="flex items-center space-x-3 mt-0.5">
                    <span className="text-[10px] text-zinc-600 font-mono">{provider?.name || account.providerId}</span>
                    <span className="text-zinc-800">·</span>
                    <span className="text-[10px] text-zinc-600 font-mono">{account.secretMasked}</span>
                    <span className="text-zinc-800">·</span>
                    <span className="text-[10px] text-zinc-600 font-mono">{modelsInPipeline} Modell{modelsInPipeline !== 1 ? 'e' : ''}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {deletingAccountId === account.id ? (
                    <>
                      <button onClick={() => onDeleteAccount(account.id)} className="px-3 py-2 bg-rose-600 hover:bg-rose-500 text-white rounded-xl text-[9px] font-black uppercase tracking-widest">
                        Bestätigen
                      </button>
                      <button onClick={() => onSetDeletingAccountId(null)} className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 rounded-xl text-[9px] font-black uppercase tracking-widest">
                        Abbrechen
                      </button>
                    </>
                  ) : (
                    <button onClick={() => onSetDeletingAccountId(account.id)} className="px-3 py-2 bg-zinc-800 hover:bg-rose-900/50 text-zinc-400 hover:text-rose-400 rounded-xl text-[9px] font-black uppercase tracking-widest transition-all">
                      Entfernen
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

export default PipelineSection;
