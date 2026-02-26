import React from 'react';
import type {
  ProviderAccount,
  PipelineModel,
  ProviderCatalogEntry,
} from '@/components/model-hub/types';
import ProviderCardComponent from './ProviderCard';

export interface ProviderListProps {
  accounts: ProviderAccount[];
  providerLookup: Map<string, ProviderCatalogEntry>;
  pipeline: PipelineModel[];
  isLoading: boolean;
  deletingAccountId: string | null;
  onSetDeletingAccountId: (accountId: string | null) => void;
  onDeleteAccount: (accountId: string) => void;
}

export const ProviderList: React.FC<ProviderListProps> = ({
  accounts,
  providerLookup,
  pipeline,
  isLoading,
  deletingAccountId,
  onSetDeletingAccountId,
  onDeleteAccount,
}) => {
  if (isLoading) {
    return (
      <div className="mt-10 space-y-4">
        <h3 className="px-2 text-xs font-black tracking-[0.2em] text-zinc-500 uppercase">
          Verbundene Accounts
        </h3>
        <div className="animate-pulse px-2 text-sm text-zinc-500">Lädt...</div>
      </div>
    );
  }

  if (accounts.length === 0) {
    return (
      <div className="mt-10 space-y-4">
        <h3 className="px-2 text-xs font-black tracking-[0.2em] text-zinc-500 uppercase">
          Verbundene Accounts (0)
        </h3>
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6 text-center">
          <p className="text-xs text-zinc-500">Noch keine Accounts verbunden.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-10 space-y-4">
      <h3 className="px-2 text-xs font-black tracking-[0.2em] text-zinc-500 uppercase">
        Verbundene Accounts ({accounts.length})
      </h3>
      {accounts.map((account) => {
        const provider = providerLookup.get(account.providerId);
        const modelsInPipeline = pipeline.filter((model) => model.accountId === account.id).length;
        return (
          <ProviderCardComponent
            key={account.id}
            account={account}
            provider={provider}
            pipelineCount={modelsInPipeline}
            isDeleting={deletingAccountId === account.id}
            onDeleteRequest={() => onSetDeletingAccountId(account.id)}
            onDeleteConfirm={() => onDeleteAccount(account.id)}
            onDeleteCancel={() => onSetDeletingAccountId(null)}
          />
        );
      })}
    </div>
  );
};

export default ProviderList;
