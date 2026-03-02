import type { ProviderAccountsPanelProps } from './types';

function resolveAuthMethodLabel(authMethod: 'none' | 'api_key' | 'oauth'): string {
  if (authMethod === 'oauth') {
    return 'OAuth';
  }
  if (authMethod === 'none') {
    return 'Local';
  }
  return 'API Key';
}

export function ProviderAccountsPanel({
  providerAccounts,
  providerLookup,
  pipeline,
  isLoadingAccounts,
  deletingAccountId,
  onSetDeletingAccountId,
  onDeleteAccount,
}: ProviderAccountsPanelProps) {
  return (
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
                    {resolveAuthMethodLabel(account.authMethod)}
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
  );
}
