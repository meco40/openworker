import React from 'react';
import { CAPABILITY_LABELS } from '@/components/model-hub/constants';
import type { ProviderAccount, ProviderCatalogEntry, PipelineModel } from '@/components/model-hub/types';

interface PipelineSectionProps {
  isLoadingPipeline: boolean;
  pipeline: PipelineModel[];
  providerLookup: Map<string, ProviderCatalogEntry>;
  providerAccounts: ProviderAccount[];
  onOpenAddModelModal: () => void;
  onToggleModelStatus: (modelId: string, currentStatus: string) => void;
  onMoveModel: (modelId: string, direction: 'up' | 'down') => void;
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
  onMoveModel,
  onRemoveModelFromPipeline,
  isLoadingAccounts,
  deletingAccountId,
  onSetDeletingAccountId,
  onDeleteAccount,
}) => {
  return (
    <div className="space-y-6 lg:col-span-2">
      <div className="flex items-center justify-between gap-4 px-2">
        <h3 className="flex items-center space-x-2 text-xs font-black tracking-[0.2em] text-zinc-500 uppercase">
          <svg
            className="h-4 w-4 text-indigo-500"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path d="M4 6h16M4 12h16M4 18h7" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <span>Active Model Pipeline</span>
        </h3>
        <button
          onClick={onOpenAddModelModal}
          disabled={providerAccounts.length === 0}
          className="rounded-xl bg-indigo-600 px-4 py-2 text-[10px] font-black tracking-widest text-white uppercase transition-all hover:bg-indigo-500 disabled:bg-zinc-800 disabled:text-zinc-600"
        >
          Model hinzufügen
        </button>
      </div>

      <div className="space-y-4">
        {isLoadingPipeline ? (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-8 text-center">
            <div className="animate-pulse text-sm text-zinc-500">Pipeline wird geladen...</div>
          </div>
        ) : pipeline.length === 0 ? (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-8 text-center">
            <div className="text-sm font-bold text-white">Keine Modelle konfiguriert</div>
            <p className="mt-2 text-xs text-zinc-500">
              Verbinde zuerst einen Provider-Account und füge danach ein Modell hinzu.
            </p>
          </div>
        ) : (
          pipeline.map((model, idx) => {
            const provider = providerLookup.get(model.providerId);
            const account = providerAccounts.find((entry) => entry.id === model.accountId);
            const isFirst = idx === 0;
            const isLast = idx === pipeline.length - 1;
            return (
              <div
                key={model.id}
                className={`group relative flex items-center rounded-2xl border bg-zinc-900 p-6 transition-all duration-300 ${
                  model.status === 'active'
                    ? 'border-zinc-800'
                    : model.status === 'rate-limited'
                      ? 'border-amber-500/30 opacity-70'
                      : 'border-rose-500/30 opacity-50 grayscale'
                }`}
              >
                <div className="mr-6 flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-950 text-xl shadow-inner">
                  {provider?.icon ?? '?'}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center space-x-2">
                    <h4 className="truncate text-base font-bold tracking-tight text-white">
                      {model.modelName}
                    </h4>
                    {idx === 0 && (
                      <span className="rounded border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[8px] font-black text-emerald-500 uppercase">
                        Primary
                      </span>
                    )}
                    {model.status === 'rate-limited' && (
                      <span className="rounded border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[8px] font-black text-amber-500 uppercase">
                        Rate Limited
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center space-x-3">
                    <span className="font-mono text-[10px] text-zinc-600 uppercase">
                      Provider: {provider?.name ?? model.providerId}
                    </span>
                    {account && (
                      <>
                        <span className="text-zinc-800">·</span>
                        <span className="font-mono text-[10px] text-zinc-600">{account.label}</span>
                      </>
                    )}
                    <span className="text-zinc-800">·</span>
                    <span className="font-mono text-[10px] text-zinc-600">P{model.priority}</span>
                    <span className="text-zinc-800">·</span>
                    <span
                      className={`text-[9px] font-black uppercase ${
                        model.status === 'active'
                          ? 'text-emerald-500'
                          : model.status === 'rate-limited'
                            ? 'text-amber-500'
                            : 'text-rose-500'
                      }`}
                    >
                      {model.status}
                    </span>
                  </div>
                  {provider && provider.capabilities.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {provider.capabilities.map((capability) => (
                        <span
                          key={capability}
                          className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[8px] text-zinc-400"
                        >
                          {CAPABILITY_LABELS[capability] || capability}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    onClick={() => onMoveModel(model.id, 'up')}
                    disabled={isFirst}
                    aria-label={`Move ${model.modelName} up`}
                    className="rounded-xl bg-zinc-800 px-3 py-2 text-[9px] font-black tracking-widest text-zinc-400 uppercase transition-all hover:bg-zinc-700 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    ↑
                  </button>
                  <button
                    onClick={() => onMoveModel(model.id, 'down')}
                    disabled={isLast}
                    aria-label={`Move ${model.modelName} down`}
                    className="rounded-xl bg-zinc-800 px-3 py-2 text-[9px] font-black tracking-widest text-zinc-400 uppercase transition-all hover:bg-zinc-700 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    ↓
                  </button>
                  <button
                    onClick={() => onToggleModelStatus(model.id, model.status)}
                    className="rounded-xl bg-zinc-800 px-3 py-2 text-[9px] font-black tracking-widest text-zinc-400 uppercase transition-all hover:bg-zinc-700 hover:text-white"
                  >
                    {model.status === 'active' ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    onClick={() => onRemoveModelFromPipeline(model.id)}
                    className="rounded-xl bg-zinc-800 px-3 py-2 text-[9px] font-black tracking-widest text-zinc-400 uppercase transition-all hover:bg-rose-900/50 hover:text-rose-400"
                  >
                    ✕
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="mt-10 space-y-4">
        <h3 className="px-2 text-xs font-black tracking-[0.2em] text-zinc-500 uppercase">
          Verbundene Accounts ({providerAccounts.length})
        </h3>
        {isLoadingAccounts ? (
          <div className="animate-pulse px-2 text-sm text-zinc-500">Lädt...</div>
        ) : providerAccounts.length === 0 ? (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6 text-center">
            <p className="text-xs text-zinc-500">Noch keine Accounts verbunden.</p>
          </div>
        ) : (
          providerAccounts.map((account) => {
            const provider = providerLookup.get(account.providerId);
            const modelsInPipeline = pipeline.filter(
              (model) => model.accountId === account.id,
            ).length;
            return (
              <div
                key={account.id}
                className="flex items-center rounded-2xl border border-zinc-800 bg-zinc-900 p-5"
              >
                <div className="mr-4 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-950 text-lg">
                  {provider?.icon || '?'}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center space-x-2">
                    <span className="truncate text-sm font-bold text-white">{account.label}</span>
                    <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[8px] text-zinc-400 uppercase">
                      {account.authMethod === 'oauth'
                        ? 'OAuth'
                        : account.authMethod === 'none'
                          ? 'Local'
                          : 'API Key'}
                    </span>
                    {account.lastCheckOk === true && (
                      <span
                        className="h-2 w-2 rounded-full bg-emerald-500"
                        title={account.lastCheckMessage || 'Letzte Prüfung OK'}
                      />
                    )}
                    {account.lastCheckOk === false && (
                      <span
                        className="h-2 w-2 rounded-full bg-rose-500"
                        title={account.lastCheckMessage || 'Letzte Prüfung fehlgeschlagen'}
                      />
                    )}
                  </div>
                  <div className="mt-0.5 flex min-w-0 items-center gap-3">
                    <span className="shrink-0 font-mono text-[10px] text-zinc-600">
                      {provider?.name || account.providerId}
                    </span>
                    <span className="shrink-0 text-zinc-800">·</span>
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-[10px] text-zinc-600"
                      title={account.secretMasked}
                    >
                      {account.secretMasked}
                    </span>
                    <span className="shrink-0 text-zinc-800">·</span>
                    <span className="shrink-0 font-mono text-[10px] text-zinc-600">
                      {modelsInPipeline} Modell{modelsInPipeline !== 1 ? 'e' : ''}
                    </span>
                  </div>
                  {account.lastCheckOk === false && account.lastCheckMessage && (
                    <div
                      className="mt-1 font-mono text-[10px] break-words whitespace-pre-wrap text-rose-400"
                      title={account.lastCheckMessage}
                    >
                      {account.lastCheckMessage}
                    </div>
                  )}
                </div>
                <div className="ml-4 flex shrink-0 items-center gap-2">
                  {deletingAccountId === account.id ? (
                    <>
                      <button
                        onClick={() => onDeleteAccount(account.id)}
                        className="rounded-xl bg-rose-600 px-3 py-2 text-[9px] font-black tracking-widest text-white uppercase hover:bg-rose-500"
                      >
                        Bestätigen
                      </button>
                      <button
                        onClick={() => onSetDeletingAccountId(null)}
                        className="rounded-xl bg-zinc-800 px-3 py-2 text-[9px] font-black tracking-widest text-zinc-400 uppercase hover:bg-zinc-700"
                      >
                        Abbrechen
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => onSetDeletingAccountId(account.id)}
                      className="rounded-xl bg-zinc-800 px-3 py-2 text-[9px] font-black tracking-widest text-zinc-400 uppercase transition-all hover:bg-rose-900/50 hover:text-rose-400"
                    >
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
