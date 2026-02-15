import React from 'react';
import { CAPABILITY_LABELS } from '../constants';
import type {
  ConnectMessage,
  PipelineModel,
  ProviderAccount,
  ProviderCatalogEntry,
  SessionStats,
} from '../types';

interface SidebarSectionProps {
  providerCatalog: ProviderCatalogEntry[];
  connectProviderId: string;
  onConnectProviderIdChange: (providerId: string) => void;
  selectedConnectProvider: ProviderCatalogEntry | null;
  availableAuthMethods: Array<'none' | 'api_key' | 'oauth'>;
  connectAuthMethod: 'none' | 'api_key' | 'oauth';
  onConnectAuthMethodChange: (method: 'none' | 'api_key' | 'oauth') => void;
  connectLabel: string;
  onConnectLabelChange: (label: string) => void;
  connectSecret: string;
  onConnectSecretChange: (secret: string) => void;
  isConnecting: boolean;
  connectMessage: ConnectMessage | null;
  accountsError: string | null;
  onConnectProviderAccount: () => void;
  pipeline: PipelineModel[];
  providerAccounts: ProviderAccount[];
  isLoadingAccounts: boolean;
  sessionStats: SessionStats;
}

const SidebarSection: React.FC<SidebarSectionProps> = ({
  providerCatalog,
  connectProviderId,
  onConnectProviderIdChange,
  selectedConnectProvider,
  availableAuthMethods,
  connectAuthMethod,
  onConnectAuthMethodChange,
  connectLabel,
  onConnectLabelChange,
  connectSecret,
  onConnectSecretChange,
  isConnecting,
  connectMessage,
  accountsError,
  onConnectProviderAccount,
  pipeline,
  providerAccounts,
  isLoadingAccounts,
  sessionStats,
}) => {
  const oauthNeedsSetup =
    connectAuthMethod === 'oauth' && selectedConnectProvider?.oauthConfigured === false;
  const oauthSetupHint =
    selectedConnectProvider?.id === 'openai-codex'
      ? 'OpenAI Codex OAuth ist aktuell nicht verfügbar. Bitte lokal mit `codex login` anmelden oder OAuth-Konfiguration prüfen.'
      : 'OAuth ist noch nicht serverseitig konfiguriert. Setze die erforderlichen OAuth-ENV Variablen und lade die Seite neu.';

  return (
    <div className="space-y-8">
      <div className="space-y-4 rounded-3xl border border-zinc-800 bg-zinc-900 p-6 shadow-xl">
        <h4 className="text-[10px] font-black tracking-widest text-zinc-500 uppercase">
          Provider Account verbinden
        </h4>

        <select
          value={connectProviderId}
          onChange={(event) => onConnectProviderIdChange(event.target.value)}
          className="w-full rounded-2xl border border-zinc-800 bg-zinc-950 p-3 text-sm text-zinc-200 focus:border-indigo-500 focus:outline-none"
        >
          {providerCatalog.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.icon} {provider.name}
            </option>
          ))}
        </select>

        {selectedConnectProvider && (
          <div className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-950 p-3">
            <div className="flex flex-wrap gap-1">
              {selectedConnectProvider.capabilities.map((capability) => (
                <span
                  key={capability}
                  className="rounded bg-indigo-500/10 px-1.5 py-0.5 font-mono text-[8px] text-indigo-400"
                >
                  {CAPABILITY_LABELS[capability] || capability}
                </span>
              ))}
            </div>
            <div className="font-mono text-[9px] text-zinc-600">
              Auth:{' '}
              {selectedConnectProvider.authMethods
                .map((method) =>
                  method === 'none' ? 'Local/No Auth' : method === 'api_key' ? 'API Key' : 'OAuth',
                )
                .join(' / ')}
            </div>
            {selectedConnectProvider.docsUrl && (
              <a
                href={selectedConnectProvider.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[9px] text-indigo-400 underline hover:text-indigo-300"
              >
                Provider Docs →
              </a>
            )}
          </div>
        )}

        {availableAuthMethods.length > 1 && (
          <select
              value={connectAuthMethod}
              onChange={(event) =>
                onConnectAuthMethodChange(event.target.value as 'none' | 'api_key' | 'oauth')
              }
            className="w-full rounded-2xl border border-zinc-800 bg-zinc-950 p-3 text-sm text-zinc-200 focus:border-indigo-500 focus:outline-none"
          >
            {availableAuthMethods.map((method) => (
              <option key={method} value={method}>
                {method === 'none'
                  ? '🖥️ Lokal (kein Key)'
                  : method === 'api_key'
                    ? '🔑 API Key'
                    : '🔒 OAuth (Browser Login)'}
              </option>
            ))}
          </select>
        )}

        <input
          value={connectLabel}
          onChange={(event) => onConnectLabelChange(event.target.value)}
          placeholder="Account Label"
          className="w-full rounded-2xl border border-zinc-800 bg-zinc-950 p-3 text-sm text-zinc-200 focus:border-indigo-500 focus:outline-none"
        />

        {connectAuthMethod === 'api_key' && (
          <input
            value={connectSecret}
            onChange={(event) => onConnectSecretChange(event.target.value)}
            type="password"
            placeholder="API Key"
            className="w-full rounded-2xl border border-zinc-800 bg-zinc-950 p-3 text-sm text-zinc-200 focus:border-indigo-500 focus:outline-none"
          />
        )}

        {oauthNeedsSetup && (
          <div className="rounded-xl border border-amber-500/30 bg-zinc-950 p-2 font-mono text-[10px] text-amber-300">
            {oauthSetupHint}
          </div>
        )}

        <button
          onClick={onConnectProviderAccount}
          disabled={isConnecting || oauthNeedsSetup}
          className="w-full rounded-xl bg-indigo-600 py-3 text-[10px] font-black tracking-widest text-white uppercase transition-all hover:bg-indigo-500 disabled:opacity-50"
        >
          {oauthNeedsSetup
            ? 'OAuth Setup fehlt'
            : connectAuthMethod === 'oauth'
              ? '🔒 OAuth starten'
              : isConnecting
                ? 'Verbinde...'
                : connectAuthMethod === 'none'
                  ? '🖥️ Lokalen Provider verbinden'
                  : '🔑 Provider verbinden'}
        </button>

        {connectMessage && (
          <div
            className={`rounded-xl p-2 font-mono text-[10px] ${connectMessage.ok ? 'border border-emerald-500/20 bg-emerald-500/5 text-emerald-400' : 'border border-rose-500/20 bg-rose-500/5 text-rose-400'}`}
          >
            {connectMessage.text}
          </div>
        )}
        {accountsError && (
          <div className="rounded-xl border border-rose-500/30 bg-zinc-950 p-2 font-mono text-[10px] text-rose-400">
            {accountsError}
          </div>
        )}
      </div>

      <div className="rounded-3xl border border-zinc-800 bg-zinc-900 p-6 shadow-xl">
        <h4 className="mb-6 text-[10px] font-black tracking-widest text-zinc-500 uppercase">
          System Status
        </h4>
        <div className="space-y-4 font-mono text-[9px] text-zinc-600">
          <div className="flex justify-between">
            <span>PIPELINE_STATUS</span>
            <span className={pipeline.length > 0 ? 'text-emerald-500' : 'text-amber-400'}>
              {pipeline.length > 0 ? 'ACTIVE' : 'EMPTY'}
            </span>
          </div>
          <div className="flex justify-between">
            <span>CONNECTED_ACCOUNTS</span>
            <span className="text-indigo-400">
              {isLoadingAccounts ? '...' : providerAccounts.length}
            </span>
          </div>
          <div className="flex justify-between">
            <span>PIPELINE_MODELS</span>
            <span className="text-indigo-400">{pipeline.length}</span>
          </div>
          <div className="flex justify-between">
            <span>ACTIVE_MODELS</span>
            <span className="text-emerald-500">
              {pipeline.filter((model) => model.status === 'active').length}
            </span>
          </div>
          <div className="flex justify-between">
            <span>CATALOG_PROVIDERS</span>
            <span className="text-indigo-400">{providerCatalog.length}</span>
          </div>
          <div className="flex justify-between">
            <span>AUTH_METHODS</span>
            <span className="text-indigo-400">Local + API Key + OAuth</span>
          </div>
          <div className="flex justify-between">
            <span>LAST_PROBE</span>
            <span
              className={
                sessionStats.lastProbeOk === true
                  ? 'text-emerald-500'
                  : sessionStats.lastProbeOk === false
                    ? 'text-rose-400'
                    : 'text-zinc-500'
              }
            >
              {sessionStats.lastProbeOk === null
                ? 'N/A'
                : sessionStats.lastProbeOk
                  ? 'OK'
                  : 'FAILED'}
            </span>
          </div>
          <div className="flex justify-between">
            <span>SESSION_REQUESTS</span>
            <span className="text-indigo-400">{sessionStats.requests}</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SidebarSection;
