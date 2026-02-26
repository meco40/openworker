import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ApiResponse,
  ConnectMessage,
  ProviderAccount,
  ProviderCatalogEntry,
  RateLimitSnapshot,
} from '@/components/model-hub/types';

function normalizeLoopbackOrigin(origin: string): string {
  try {
    const parsed = new URL(origin);
    if (
      parsed.hostname === '0.0.0.0' ||
      parsed.hostname === '::' ||
      parsed.hostname === '[::]' ||
      parsed.hostname === '127.0.0.1'
    ) {
      parsed.hostname = 'localhost';
      return parsed.origin;
    }
    return parsed.origin;
  } catch {
    return origin;
  }
}

export interface UseProvidersReturn {
  // Provider catalog
  providerCatalog: ProviderCatalogEntry[];
  providerLookup: Map<string, ProviderCatalogEntry>;
  loadProviders: () => Promise<void>;

  // Provider accounts
  providerAccounts: ProviderAccount[];
  isLoadingAccounts: boolean;
  accountsError: string | null;
  loadAccounts: () => Promise<void>;
  deleteAccount: (accountId: string) => Promise<void>;
  deletingAccountId: string | null;
  setDeletingAccountId: (id: string | null) => void;

  // Connection state
  connectProviderId: string;
  setConnectProviderId: (id: string) => void;
  connectAuthMethod: 'none' | 'api_key' | 'oauth';
  setConnectAuthMethod: (method: 'none' | 'api_key' | 'oauth') => void;
  connectLabel: string;
  setConnectLabel: (label: string) => void;
  connectSecret: string;
  setConnectSecret: (secret: string) => void;
  isConnecting: boolean;
  connectMessage: ConnectMessage | null;
  setConnectMessage: (message: ConnectMessage | null) => void;
  selectedConnectProvider: ProviderCatalogEntry | null;
  availableAuthMethods: Array<'none' | 'api_key' | 'oauth'>;
  connectProviderAccount: () => Promise<void>;

  // Probing
  isProbing: boolean;
  probeResult: string | null;
  setProbeResult: (result: string | null) => void;
  isTestingAll: boolean;
  bulkProbeSummary: string | null;
  probeRateLimitsByAccountId: Record<string, RateLimitSnapshot | null>;
  runConnectionProbe: (
    defaultModel?: { accountId: string; modelName: string } | null,
  ) => Promise<void>;
  runAllConnectionProbes: (pipeline: { accountId: string; modelName: string }[]) => Promise<void>;
}

export function useProviders(): UseProvidersReturn {
  const [providerCatalog, setProviderCatalog] = useState<ProviderCatalogEntry[]>([]);

  const [providerAccounts, setProviderAccounts] = useState<ProviderAccount[]>([]);
  const [isLoadingAccounts, setIsLoadingAccounts] = useState(true);
  const [accountsError, setAccountsError] = useState<string | null>(null);

  const [connectProviderId, setConnectProviderId] = useState('');
  const [connectAuthMethod, setConnectAuthMethod] = useState<'none' | 'api_key' | 'oauth'>(
    'api_key',
  );
  const [connectLabel, setConnectLabel] = useState('');
  const [connectSecret, setConnectSecret] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectMessage, setConnectMessage] = useState<ConnectMessage | null>(null);

  const [isProbing, setIsProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<string | null>(null);
  const [isTestingAll, setIsTestingAll] = useState(false);
  const [bulkProbeSummary, setBulkProbeSummary] = useState<string | null>(null);
  const [probeRateLimitsByAccountId, setProbeRateLimitsByAccountId] = useState<
    Record<string, RateLimitSnapshot | null>
  >({});

  const [deletingAccountId, setDeletingAccountId] = useState<string | null>(null);

  const providerLookup = useMemo(
    () =>
      new Map<string, ProviderCatalogEntry>(
        providerCatalog.map((provider) => [provider.id, provider]),
      ),
    [providerCatalog],
  );

  const selectedConnectProvider = useMemo(
    () => providerLookup.get(connectProviderId) ?? null,
    [connectProviderId, providerLookup],
  );

  const availableAuthMethods = useMemo(
    () =>
      selectedConnectProvider?.authMethods ?? (['api_key'] as Array<'none' | 'api_key' | 'oauth'>),
    [selectedConnectProvider],
  );

  const loadProviders = useCallback(async () => {
    try {
      const response = await fetch('/api/model-hub/providers');
      const data = (await response.json()) as ApiResponse & { providers?: ProviderCatalogEntry[] };
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      const providers = data.providers ?? [];
      setProviderCatalog(providers);
      if (providers.length > 0 && !connectProviderId) {
        setConnectProviderId(providers[0].id);
      }
    } catch {
      // fallback: leave empty, user will see loading error
    }
  }, [connectProviderId]);

  const loadAccounts = useCallback(async () => {
    setIsLoadingAccounts(true);
    setAccountsError(null);
    try {
      const response = await fetch('/api/model-hub/accounts');
      const data = (await response.json()) as ApiResponse & { accounts?: ProviderAccount[] };
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setProviderAccounts(data.accounts ?? []);
    } catch (error) {
      setAccountsError(error instanceof Error ? error.message : 'Failed to load accounts');
    } finally {
      setIsLoadingAccounts(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedConnectProvider) return;
    if (!availableAuthMethods.includes(connectAuthMethod)) {
      setConnectAuthMethod((availableAuthMethods[0] ?? 'api_key') as 'none' | 'api_key' | 'oauth');
    }
    if (!connectLabel.trim()) {
      setConnectLabel(`${selectedConnectProvider.name} Account`);
    }
  }, [availableAuthMethods, connectAuthMethod, connectLabel, selectedConnectProvider]);

  async function connectProviderAccount() {
    if (!selectedConnectProvider) return;

    if (connectAuthMethod === 'oauth') {
      if (!connectLabel.trim()) {
        setConnectMessage({ text: 'Bitte ein Account-Label angeben.', ok: false });
        return;
      }
      if (selectedConnectProvider.oauthConfigured === false) {
        setConnectMessage({
          text:
            selectedConnectProvider.id === 'openai-codex'
              ? 'OpenAI Codex OAuth ist aktuell nicht verfügbar. Bitte zuerst lokal mit `codex login` authentifizieren oder OAuth-Konfiguration prüfen.'
              : `OAuth für ${selectedConnectProvider.name} ist nicht konfiguriert. Bitte OAuth-ENV konfigurieren und Seite neu laden.`,
          ok: false,
        });
        return;
      }
      const startUrl = new URL('/api/model-hub/oauth/start', window.location.origin);
      startUrl.searchParams.set('providerId', selectedConnectProvider.id);
      startUrl.searchParams.set('label', connectLabel.trim());
      const popup = window.open(
        startUrl.toString(),
        'model-hub-oauth',
        'popup=yes,width=620,height=760',
      );
      if (!popup) {
        setConnectMessage({
          text: 'Popup blockiert. Bitte Popup-Blocker deaktivieren.',
          ok: false,
        });
        return;
      }
      setConnectMessage({
        text: `OAuth gestartet für ${selectedConnectProvider.name}...`,
        ok: true,
      });
      return;
    }

    if (!connectLabel.trim()) {
      setConnectMessage({ text: 'Bitte mindestens ein Account-Label ausfüllen.', ok: false });
      return;
    }
    if (connectAuthMethod === 'api_key' && !connectSecret.trim()) {
      setConnectMessage({ text: 'Bitte Label und API Key ausfüllen.', ok: false });
      return;
    }

    setIsConnecting(true);
    setConnectMessage(null);
    try {
      const response = await fetch('/api/model-hub/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: selectedConnectProvider.id,
          label: connectLabel.trim(),
          authMethod: connectAuthMethod,
          secret: connectAuthMethod === 'none' ? '' : connectSecret.trim(),
        }),
      });
      const data = (await response.json()) as ApiResponse;
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setConnectSecret('');
      setConnectLabel('');
      setConnectMessage({ text: `${selectedConnectProvider.name} Account verbunden!`, ok: true });
      await loadAccounts();
    } catch (error) {
      setConnectMessage({
        text: error instanceof Error ? error.message : 'Verbindung fehlgeschlagen',
        ok: false,
      });
    } finally {
      setIsConnecting(false);
    }
  }

  useEffect(() => {
    function onOAuthMessage(event: MessageEvent) {
      const currentOrigin = normalizeLoopbackOrigin(window.location.origin);
      const incomingOrigin = normalizeLoopbackOrigin(event.origin);
      if (incomingOrigin !== currentOrigin) return;
      const payload = event.data as { type?: string; ok?: boolean; message?: string } | undefined;
      if (!payload || payload.type !== 'MODEL_HUB_OAUTH_RESULT') return;
      setConnectMessage({
        text: payload.message || 'OAuth abgeschlossen.',
        ok: Boolean(payload.ok),
      });
      if (payload.ok) {
        setConnectSecret('');
        void loadAccounts();
      }
    }
    window.addEventListener('message', onOAuthMessage);
    return () => window.removeEventListener('message', onOAuthMessage);
  }, [loadAccounts]);

  async function deleteAccount(accountId: string) {
    try {
      const response = await fetch(`/api/model-hub/accounts/${accountId}`, { method: 'DELETE' });
      const data = (await response.json()) as ApiResponse;
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setDeletingAccountId(null);
      await loadAccounts();
    } catch (error) {
      setAccountsError(error instanceof Error ? error.message : 'Delete failed');
    }
  }

  async function runConnectionProbe(
    defaultModel?: { accountId: string; modelName: string } | null,
  ) {
    if (!defaultModel?.accountId) {
      setProbeResult('Kein primäres Modell mit Provider-Account konfiguriert.');
      return;
    }
    setIsProbing(true);
    setProbeResult(null);
    try {
      const response = await fetch(`/api/model-hub/accounts/${defaultModel.accountId}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: defaultModel.modelName }),
      });
      const data = (await response.json()) as ApiResponse & {
        connectivity?: { ok: boolean; message: string; rateLimits?: RateLimitSnapshot };
      };
      if (!response.ok || !data.ok || !data.connectivity)
        throw new Error(data.error || `HTTP ${response.status}`);
      setProbeResult(data.connectivity.message);
      if (data.connectivity.rateLimits) {
        setProbeRateLimitsByAccountId((prev) => ({
          ...prev,
          [defaultModel.accountId]: data.connectivity?.rateLimits ?? null,
        }));
      }
    } catch (error) {
      setProbeResult(`FEHLER: ${error instanceof Error ? error.message : 'Probe fehlgeschlagen'}`);
    } finally {
      setIsProbing(false);
    }
  }

  async function runAllConnectionProbes(pipeline: { accountId: string; modelName: string }[]) {
    if (providerAccounts.length === 0) {
      setBulkProbeSummary('Keine Provider-Accounts vorhanden.');
      setProbeRateLimitsByAccountId({});
      return;
    }
    const modelByAccountId: Record<string, string> = {};
    for (const account of providerAccounts) {
      const assigned = pipeline.find((model) => model.accountId === account.id)?.modelName;
      if (assigned) modelByAccountId[account.id] = assigned;
    }
    setIsTestingAll(true);
    setBulkProbeSummary(null);
    try {
      const response = await fetch('/api/model-hub/accounts/test-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelByAccountId }),
      });
      const data = (await response.json()) as ApiResponse & {
        successCount?: number;
        failureCount?: number;
        total?: number;
        results?: Array<{
          accountId: string;
          providerId: string;
          label: string;
          ok: boolean;
          message: string;
          rateLimits?: RateLimitSnapshot;
        }>;
      };
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setBulkProbeSummary(`${data.successCount}/${data.total} OK, ${data.failureCount} FAILED`);
      const nextRateLimitsByAccountId: Record<string, RateLimitSnapshot | null> = {};
      for (const result of data.results ?? []) {
        if (result.rateLimits && result.rateLimits.windows.length > 0) {
          nextRateLimitsByAccountId[result.accountId] = result.rateLimits;
        }
      }
      setProbeRateLimitsByAccountId(nextRateLimitsByAccountId);
    } catch (error) {
      setBulkProbeSummary(
        `FEHLER: ${error instanceof Error ? error.message : 'Bulk probe failed'}`,
      );
      setProbeRateLimitsByAccountId({});
    } finally {
      setIsTestingAll(false);
    }
  }

  return {
    providerCatalog,
    providerLookup,
    loadProviders,
    providerAccounts,
    isLoadingAccounts,
    accountsError,
    loadAccounts,
    deleteAccount,
    deletingAccountId,
    setDeletingAccountId,
    connectProviderId,
    setConnectProviderId,
    connectAuthMethod,
    setConnectAuthMethod,
    connectLabel,
    setConnectLabel,
    connectSecret,
    setConnectSecret,
    isConnecting,
    connectMessage,
    setConnectMessage,
    selectedConnectProvider,
    availableAuthMethods,
    connectProviderAccount,
    isProbing,
    probeResult,
    setProbeResult,
    isTestingAll,
    bulkProbeSummary,
    probeRateLimitsByAccountId,
    runConnectionProbe,
    runAllConnectionProbes,
  };
}
