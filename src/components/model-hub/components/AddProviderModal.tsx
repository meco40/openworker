import React from 'react';
import { CAPABILITY_LABELS } from '@/components/model-hub/constants';
import type { ConnectMessage, ProviderCatalogEntry } from '@/components/model-hub/types';

export interface AddProviderModalProps {
  // Provider selection
  providerCatalog: ProviderCatalogEntry[];
  connectProviderId: string;
  onConnectProviderIdChange: (providerId: string) => void;
  selectedConnectProvider: ProviderCatalogEntry | null;

  // Auth method
  availableAuthMethods: Array<'none' | 'api_key' | 'oauth'>;
  connectAuthMethod: 'none' | 'api_key' | 'oauth';
  onConnectAuthMethodChange: (method: 'none' | 'api_key' | 'oauth') => void;

  // Form fields
  connectLabel: string;
  onConnectLabelChange: (label: string) => void;
  connectSecret: string;
  onConnectSecretChange: (secret: string) => void;

  // Actions
  isConnecting: boolean;
  onConnect: () => void;

  // Messages
  connectMessage: ConnectMessage | null;
  accountsError: string | null;

  // Pipeline status
  hasPipelineModels: boolean;
}

export const AddProviderModal: React.FC<AddProviderModalProps> = ({
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
  onConnect,
  connectMessage,
  accountsError,
}) => {
  const providerSelectId = 'provider-select';
  const authMethodSelectId = 'provider-auth-method';
  const accountLabelInputId = 'provider-account-label';
  const apiKeyInputId = 'provider-api-key';

  const oauthNeedsSetup =
    connectAuthMethod === 'oauth' && selectedConnectProvider?.oauthConfigured === false;
  const oauthSetupHint =
    selectedConnectProvider?.id === 'openai-codex'
      ? 'OpenAI Codex OAuth ist aktuell nicht verfügbar. Bitte lokal mit `codex login` anmelden oder OAuth-Konfiguration prüfen.'
      : 'OAuth ist noch nicht serverseitig konfiguriert. Setze die erforderlichen OAuth-ENV Variablen und lade die Seite neu.';

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <label
          htmlFor={providerSelectId}
          className="text-[10px] font-black tracking-widest text-zinc-500 uppercase"
        >
          Provider
        </label>
        <select
          id={providerSelectId}
          value={connectProviderId}
          onChange={(e) => onConnectProviderIdChange(e.target.value)}
          className="w-full rounded-xl border border-zinc-800 bg-zinc-950 p-3 text-sm text-zinc-200 focus:border-indigo-500 focus:outline-none"
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
      </div>

      {availableAuthMethods.length > 1 && (
        <div className="space-y-2">
          <label
            htmlFor={authMethodSelectId}
            className="text-[10px] font-black tracking-widest text-zinc-500 uppercase"
          >
            Authentifizierungsmethode
          </label>
          <select
            id={authMethodSelectId}
            value={connectAuthMethod}
            onChange={(e) =>
              onConnectAuthMethodChange(e.target.value as 'none' | 'api_key' | 'oauth')
            }
            className="w-full rounded-xl border border-zinc-800 bg-zinc-950 p-3 text-sm text-zinc-200 focus:border-indigo-500 focus:outline-none"
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
        </div>
      )}

      <div className="space-y-2">
        <label
          htmlFor={accountLabelInputId}
          className="text-[10px] font-black tracking-widest text-zinc-500 uppercase"
        >
          Account Label
        </label>
        <input
          id={accountLabelInputId}
          type="text"
          value={connectLabel}
          onChange={(e) => onConnectLabelChange(e.target.value)}
          placeholder="z.B. OpenAI Production"
          className="w-full rounded-xl border border-zinc-800 bg-zinc-950 p-3 text-sm text-zinc-200 focus:border-indigo-500 focus:outline-none"
        />
      </div>

      {connectAuthMethod === 'api_key' && (
        <div className="space-y-2">
          <label
            htmlFor={apiKeyInputId}
            className="text-[10px] font-black tracking-widest text-zinc-500 uppercase"
          >
            API Key
          </label>
          <input
            id={apiKeyInputId}
            type="password"
            value={connectSecret}
            onChange={(e) => onConnectSecretChange(e.target.value)}
            placeholder="sk-..."
            className="w-full rounded-xl border border-zinc-800 bg-zinc-950 p-3 text-sm text-zinc-200 focus:border-indigo-500 focus:outline-none"
          />
        </div>
      )}

      {oauthNeedsSetup && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 font-mono text-[10px] text-amber-300">
          {oauthSetupHint}
        </div>
      )}

      <button
        onClick={onConnect}
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
          className={`rounded-xl p-3 font-mono text-[10px] ${
            connectMessage.ok
              ? 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-400'
              : 'border border-rose-500/20 bg-rose-500/10 text-rose-400'
          }`}
        >
          {connectMessage.text}
        </div>
      )}

      {accountsError && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 font-mono text-[10px] text-rose-400">
          {accountsError}
        </div>
      )}
    </div>
  );
};

export default AddProviderModal;
