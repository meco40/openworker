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
  availableAuthMethods: Array<'api_key' | 'oauth'>;
  connectAuthMethod: 'api_key' | 'oauth';
  onConnectAuthMethodChange: (method: 'api_key' | 'oauth') => void;
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
  return (
    <div className="space-y-8">
      <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 shadow-xl space-y-4">
        <h4 className="text-[10px] font-black text-zinc-500 uppercase tracking-widest">Provider Account verbinden</h4>

        <select value={connectProviderId} onChange={(event) => onConnectProviderIdChange(event.target.value)} className="w-full bg-zinc-950 border border-zinc-800 rounded-2xl p-3 text-sm text-zinc-200 focus:outline-none focus:border-indigo-500">
          {providerCatalog.map((provider) => (
            <option key={provider.id} value={provider.id}>{provider.icon} {provider.name}</option>
          ))}
        </select>

        {selectedConnectProvider && (
          <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-3 space-y-2">
            <div className="flex flex-wrap gap-1">
              {selectedConnectProvider.capabilities.map((capability) => (
                <span key={capability} className="text-[8px] font-mono bg-indigo-500/10 text-indigo-400 px-1.5 py-0.5 rounded">
                  {CAPABILITY_LABELS[capability] || capability}
                </span>
              ))}
            </div>
            <div className="text-[9px] text-zinc-600 font-mono">
              Auth: {selectedConnectProvider.authMethods.map((method) => method === 'api_key' ? 'API Key' : 'OAuth').join(' / ')}
            </div>
            {selectedConnectProvider.docsUrl && (
              <a href={selectedConnectProvider.docsUrl} target="_blank" rel="noopener noreferrer" className="text-[9px] text-indigo-400 hover:text-indigo-300 underline">
                Provider Docs →
              </a>
            )}
          </div>
        )}

        {availableAuthMethods.length > 1 && (
          <select value={connectAuthMethod} onChange={(event) => onConnectAuthMethodChange(event.target.value as 'api_key' | 'oauth')} className="w-full bg-zinc-950 border border-zinc-800 rounded-2xl p-3 text-sm text-zinc-200 focus:outline-none focus:border-indigo-500">
            {availableAuthMethods.map((method) => (
              <option key={method} value={method}>
                {method === 'api_key' ? '🔑 API Key' : '🔒 OAuth (Browser Login)'}
              </option>
            ))}
          </select>
        )}

        {availableAuthMethods.length === 1 && (
          <div className="text-[10px] text-zinc-500 font-mono bg-zinc-950 border border-zinc-800 rounded-xl p-2">
            Verfahren: {availableAuthMethods[0] === 'api_key' ? '🔑 API Key' : '🔒 OAuth'}
          </div>
        )}

        <input value={connectLabel} onChange={(event) => onConnectLabelChange(event.target.value)} placeholder="Account Label" className="w-full bg-zinc-950 border border-zinc-800 rounded-2xl p-3 text-sm text-zinc-200 focus:outline-none focus:border-indigo-500" />

        {connectAuthMethod === 'api_key' && (
          <input value={connectSecret} onChange={(event) => onConnectSecretChange(event.target.value)} type="password" placeholder="API Key" className="w-full bg-zinc-950 border border-zinc-800 rounded-2xl p-3 text-sm text-zinc-200 focus:outline-none focus:border-indigo-500" />
        )}

        <button onClick={onConnectProviderAccount} disabled={isConnecting} className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-[10px] font-black uppercase tracking-widest disabled:opacity-50 transition-all">
          {connectAuthMethod === 'oauth' ? '🔒 OAuth starten' : isConnecting ? 'Verbinde...' : '🔑 Provider verbinden'}
        </button>

        {connectMessage && (
          <div className={`text-[10px] font-mono rounded-xl p-2 ${connectMessage.ok ? 'text-emerald-400 bg-emerald-500/5 border border-emerald-500/20' : 'text-rose-400 bg-rose-500/5 border border-rose-500/20'}`}>
            {connectMessage.text}
          </div>
        )}
        {accountsError && (
          <div className="text-[10px] text-rose-400 font-mono bg-zinc-950 border border-rose-500/30 rounded-xl p-2">
            {accountsError}
          </div>
        )}
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 shadow-xl">
        <h4 className="text-[10px] font-black text-zinc-500 uppercase tracking-widest mb-6">System Status</h4>
        <div className="space-y-4 font-mono text-[9px] text-zinc-600">
          <div className="flex justify-between">
            <span>PIPELINE_STATUS</span>
            <span className={pipeline.length > 0 ? 'text-emerald-500' : 'text-amber-400'}>
              {pipeline.length > 0 ? 'ACTIVE' : 'EMPTY'}
            </span>
          </div>
          <div className="flex justify-between">
            <span>CONNECTED_ACCOUNTS</span>
            <span className="text-indigo-400">{isLoadingAccounts ? '...' : providerAccounts.length}</span>
          </div>
          <div className="flex justify-between">
            <span>PIPELINE_MODELS</span>
            <span className="text-indigo-400">{pipeline.length}</span>
          </div>
          <div className="flex justify-between">
            <span>ACTIVE_MODELS</span>
            <span className="text-emerald-500">{pipeline.filter((model) => model.status === 'active').length}</span>
          </div>
          <div className="flex justify-between">
            <span>CATALOG_PROVIDERS</span>
            <span className="text-indigo-400">{providerCatalog.length}</span>
          </div>
          <div className="flex justify-between">
            <span>AUTH_METHODS</span>
            <span className="text-indigo-400">API Key + OAuth</span>
          </div>
          <div className="flex justify-between">
            <span>LAST_PROBE</span>
            <span className={sessionStats.lastProbeOk === true ? 'text-emerald-500' : sessionStats.lastProbeOk === false ? 'text-rose-400' : 'text-zinc-500'}>
              {sessionStats.lastProbeOk === null ? 'N/A' : sessionStats.lastProbeOk ? 'OK' : 'FAILED'}
            </span>
          </div>
          <div className="flex justify-between">
            <span>SESSION_REQUESTS</span>
            <span className="text-indigo-400">{sessionStats.requests}</span>
          </div>
        </div>
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 shadow-xl">
        <h4 className="text-[10px] font-black text-zinc-500 uppercase tracking-widest mb-4">Provider Katalog</h4>
        <div className="space-y-2 max-h-80 overflow-y-auto">
          {providerCatalog.map((provider) => {
            const connected = providerAccounts.filter((account) => account.providerId === provider.id).length;
            return (
              <div key={provider.id} className="flex items-center justify-between text-[10px] py-1.5 border-b border-zinc-800/50 last:border-0">
                <div className="flex items-center space-x-2">
                  <span className="text-base">{provider.icon}</span>
                  <span className="text-zinc-300 font-medium">{provider.name}</span>
                </div>
                <div className="flex items-center space-x-2">
                  <span className="text-zinc-600 font-mono">
                    {provider.authMethods.map((method) => method === 'api_key' ? 'Key' : 'OAuth').join('+')}
                  </span>
                  {connected > 0 && (
                    <span className="bg-emerald-500/10 text-emerald-500 text-[8px] font-black px-1.5 py-0.5 rounded">
                      {connected}×
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default SidebarSection;
