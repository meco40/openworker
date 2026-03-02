import { PipelineModelCard } from './PipelineModelCard';
import type { PipelineCardsProps } from './types';

export function PipelineCards({
  isLoading,
  models,
  showPrimaryBadge,
  emptyTitle,
  emptyDescription,
  providerLookup,
  providerAccounts,
  onToggleStatus,
  onMove,
  onRemove,
  probeRateLimitsByAccountId,
}: PipelineCardsProps) {
  if (isLoading) {
    return (
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-8 text-center">
        <div className="animate-pulse text-sm text-zinc-500">Pipeline wird geladen...</div>
      </div>
    );
  }

  if (models.length === 0) {
    return (
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-8 text-center">
        <div className="text-sm font-bold text-white">{emptyTitle}</div>
        <p className="mt-2 text-xs text-zinc-500">{emptyDescription}</p>
      </div>
    );
  }

  return (
    <>
      {models.map((model, index) => (
        <PipelineModelCard
          key={model.id}
          model={model}
          index={index}
          modelsCount={models.length}
          showPrimaryBadge={showPrimaryBadge}
          providerLookup={providerLookup}
          providerAccounts={providerAccounts}
          onToggleStatus={onToggleStatus}
          onMove={onMove}
          onRemove={onRemove}
          probeRateLimitsByAccountId={probeRateLimitsByAccountId}
        />
      ))}
    </>
  );
}
