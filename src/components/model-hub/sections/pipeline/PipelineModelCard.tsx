import { CAPABILITY_LABELS } from '@/components/model-hub/constants';
import type {
  PipelineModel,
  ProviderAccount,
  ProviderCatalogEntry,
  RateLimitSnapshot,
} from '@/components/model-hub/types';
import { formatCodexRateLimitLabel, resolveCodexRateLimitWindows } from './rateLimits';

interface PipelineModelCardProps {
  model: PipelineModel;
  index: number;
  modelsCount: number;
  showPrimaryBadge: boolean;
  providerLookup: Map<string, ProviderCatalogEntry>;
  providerAccounts: ProviderAccount[];
  onToggleStatus: (modelId: string, currentStatus: string) => void;
  onMove: (modelId: string, direction: 'up' | 'down') => void;
  onRemove: (modelId: string) => void;
  probeRateLimitsByAccountId?: Record<string, RateLimitSnapshot | null>;
}

export function PipelineModelCard({
  model,
  index,
  modelsCount,
  showPrimaryBadge,
  providerLookup,
  providerAccounts,
  onToggleStatus,
  onMove,
  onRemove,
  probeRateLimitsByAccountId,
}: PipelineModelCardProps) {
  const provider = providerLookup.get(model.providerId);
  const account = providerAccounts.find((entry) => entry.id === model.accountId);
  const codexRateLimits =
    model.providerId === 'openai-codex'
      ? (probeRateLimitsByAccountId?.[model.accountId] ?? null)
      : null;
  const { shortWindow: codexShortWindow, longWindow: codexLongWindow } =
    resolveCodexRateLimitWindows(codexRateLimits);
  const isFirst = index === 0;
  const isLast = index === modelsCount - 1;

  return (
    <div
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
          {showPrimaryBadge && index === 0 && (
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
            {codexShortWindow && (
              <span className="rounded border border-indigo-500/30 bg-indigo-500/10 px-1.5 py-0.5 font-mono text-[8px] text-indigo-300">
                {formatCodexRateLimitLabel(
                  (codexShortWindow.window || '5h').toUpperCase(),
                  codexShortWindow,
                )}
              </span>
            )}
            {codexLongWindow && (
              <span className="rounded border border-indigo-500/30 bg-indigo-500/10 px-1.5 py-0.5 font-mono text-[8px] text-indigo-300">
                {formatCodexRateLimitLabel(
                  (codexLongWindow.window || '5d').toUpperCase(),
                  codexLongWindow,
                )}
              </span>
            )}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          onClick={() => onMove(model.id, 'up')}
          disabled={isFirst}
          aria-label={`Move ${model.modelName} up`}
          className="rounded-xl bg-zinc-800 px-3 py-2 text-[9px] font-black tracking-widest text-zinc-400 uppercase transition-all hover:bg-zinc-700 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          ↑
        </button>
        <button
          onClick={() => onMove(model.id, 'down')}
          disabled={isLast}
          aria-label={`Move ${model.modelName} down`}
          className="rounded-xl bg-zinc-800 px-3 py-2 text-[9px] font-black tracking-widest text-zinc-400 uppercase transition-all hover:bg-zinc-700 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          ↓
        </button>
        <button
          onClick={() => onToggleStatus(model.id, model.status)}
          className="rounded-xl bg-zinc-800 px-3 py-2 text-[9px] font-black tracking-widest text-zinc-400 uppercase transition-all hover:bg-zinc-700 hover:text-white"
        >
          {model.status === 'active' ? 'Disable' : 'Enable'}
        </button>
        <button
          onClick={() => onRemove(model.id)}
          className="rounded-xl bg-zinc-800 px-3 py-2 text-[9px] font-black tracking-widest text-zinc-400 uppercase transition-all hover:bg-rose-900/50 hover:text-rose-400"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
