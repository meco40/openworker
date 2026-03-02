import React from 'react';
import { PipelineCards } from '@/components/model-hub/sections/pipeline/PipelineCards';
import { ProviderAccountsPanel } from '@/components/model-hub/sections/pipeline/ProviderAccountsPanel';
import type { PipelineSectionProps } from '@/components/model-hub/sections/pipeline/types';

const PipelineSection: React.FC<PipelineSectionProps> = ({
  isLoadingPipeline,
  pipeline,
  isLoadingEmbeddingPipeline,
  embeddingPipeline,
  providerLookup,
  providerAccounts,
  onOpenAddModelModal,
  onOpenAddEmbeddingModelModal,
  onToggleModelStatus,
  onMoveModel,
  onRemoveModelFromPipeline,
  onToggleEmbeddingModelStatus,
  onMoveEmbeddingModel,
  onRemoveEmbeddingModelFromPipeline,
  isLoadingAccounts,
  deletingAccountId,
  onSetDeletingAccountId,
  onDeleteAccount,
  probeRateLimitsByAccountId,
}) => {
  const hasEmbeddingCapableAccount = providerAccounts.some((account) =>
    providerLookup.get(account.providerId)?.capabilities.includes('embeddings'),
  );

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
        <PipelineCards
          isLoading={isLoadingPipeline}
          models={pipeline}
          showPrimaryBadge
          emptyTitle="Keine Modelle konfiguriert"
          emptyDescription="Verbinde zuerst einen Provider-Account und füge danach ein Modell hinzu."
          providerLookup={providerLookup}
          providerAccounts={providerAccounts}
          onToggleStatus={onToggleModelStatus}
          onMove={onMoveModel}
          onRemove={onRemoveModelFromPipeline}
          probeRateLimitsByAccountId={probeRateLimitsByAccountId}
        />
      </div>

      <div className="mt-8 flex items-center justify-between gap-4 px-2">
        <h3 className="flex items-center space-x-2 text-xs font-black tracking-[0.2em] text-zinc-500 uppercase">
          <svg
            className="h-4 w-4 text-emerald-500"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              d="M4 7h16M4 12h16M4 17h10M16 4l4 4-4 4"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span>Active Embedding Model</span>
        </h3>
        <button
          onClick={onOpenAddEmbeddingModelModal}
          disabled={!hasEmbeddingCapableAccount}
          className="rounded-xl bg-emerald-600 px-4 py-2 text-[10px] font-black tracking-widest text-white uppercase transition-all hover:bg-emerald-500 disabled:bg-zinc-800 disabled:text-zinc-600"
        >
          Embedding hinzufügen
        </button>
      </div>

      {!isLoadingEmbeddingPipeline && embeddingPipeline.length === 0 && (
        <div className="mx-2 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
          <p className="text-xs font-bold text-amber-300">Warnung</p>
          <p className="mt-1 text-xs text-amber-200/90">
            Bitte ein Embedding Model hinzufügen, sonst kann der Embedding-Dienst nicht genutzt
            werden.
          </p>
        </div>
      )}

      <div className="space-y-4">
        <PipelineCards
          isLoading={isLoadingEmbeddingPipeline}
          models={embeddingPipeline}
          showPrimaryBadge={false}
          emptyTitle="Kein Embedding-Modell konfiguriert"
          emptyDescription="Füge ein Modell mit Embeddings-Unterstützung hinzu, um Embedding-Requests gezielt zu routen."
          providerLookup={providerLookup}
          providerAccounts={providerAccounts}
          onToggleStatus={onToggleEmbeddingModelStatus}
          onMove={onMoveEmbeddingModel}
          onRemove={onRemoveEmbeddingModelFromPipeline}
          probeRateLimitsByAccountId={probeRateLimitsByAccountId}
        />
      </div>

      <ProviderAccountsPanel
        providerAccounts={providerAccounts}
        providerLookup={providerLookup}
        pipeline={pipeline}
        isLoadingAccounts={isLoadingAccounts}
        deletingAccountId={deletingAccountId}
        onSetDeletingAccountId={onSetDeletingAccountId}
        onDeleteAccount={onDeleteAccount}
      />
    </div>
  );
};

export default PipelineSection;
