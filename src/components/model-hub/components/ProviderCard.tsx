import React from 'react';
import type { ProviderAccount, ProviderCatalogEntry } from '@/components/model-hub/types';

export interface ProviderCardProps {
  account: ProviderAccount;
  provider: ProviderCatalogEntry | undefined;
  pipelineCount: number;
  isDeleting: boolean;
  onDeleteRequest: () => void;
  onDeleteConfirm: () => void;
  onDeleteCancel: () => void;
}

export const ProviderCard: React.FC<ProviderCardProps> = ({
  account,
  provider,
  pipelineCount,
  isDeleting,
  onDeleteRequest,
  onDeleteConfirm,
  onDeleteCancel,
}) => {
  return (
    <div className="flex items-center rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
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
            {pipelineCount} Modell{pipelineCount !== 1 ? 'e' : ''}
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
        {isDeleting ? (
          <>
            <button
              onClick={onDeleteConfirm}
              className="rounded-xl bg-rose-600 px-3 py-2 text-[9px] font-black tracking-widest text-white uppercase hover:bg-rose-500"
            >
              Bestätigen
            </button>
            <button
              onClick={onDeleteCancel}
              className="rounded-xl bg-zinc-800 px-3 py-2 text-[9px] font-black tracking-widest text-zinc-400 uppercase hover:bg-zinc-700"
            >
              Abbrechen
            </button>
          </>
        ) : (
          <button
            onClick={onDeleteRequest}
            className="rounded-xl bg-zinc-800 px-3 py-2 text-[9px] font-black tracking-widest text-zinc-400 uppercase transition-all hover:bg-rose-900/50 hover:text-rose-400"
          >
            Entfernen
          </button>
        )}
      </div>
    </div>
  );
};

export default ProviderCard;
