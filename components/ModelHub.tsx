import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { PROFILE_ID } from './model-hub/constants';
import AddModelModal from './model-hub/modals/AddModelModal';
import HeaderSection from './model-hub/sections/HeaderSection';
import PipelineSection from './model-hub/sections/PipelineSection';
import SidebarSection from './model-hub/sections/SidebarSection';
import type {
  ApiResponse,
  ConnectMessage,
  FetchedModel,
  PipelineModel,
  ProviderAccount,
  ProviderCatalogEntry,
  SessionStats,
} from './model-hub/types';
import { filterLiveModels, getDefaultActiveModel } from './model-hub/utils';

const ModelHub: React.FC = () => {
  const [providerCatalog, setProviderCatalog] = useState<ProviderCatalogEntry[]>([]);

  const [providerAccounts, setProviderAccounts] = useState<ProviderAccount[]>([]);
  const [isLoadingAccounts, setIsLoadingAccounts] = useState(true);
  const [accountsError, setAccountsError] = useState<string | null>(null);

  const [pipeline, setPipeline] = useState<PipelineModel[]>([]);
  const [isLoadingPipeline, setIsLoadingPipeline] = useState(true);

  const [connectProviderId, setConnectProviderId] = useState('');
  const [connectAuthMethod, setConnectAuthMethod] = useState<'api_key' | 'oauth'>('api_key');
  const [connectLabel, setConnectLabel] = useState('');
  const [connectSecret, setConnectSecret] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectMessage, setConnectMessage] = useState<ConnectMessage | null>(null);

  const [isProbing, setIsProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<string | null>(null);
  const [isTestingAll, setIsTestingAll] = useState(false);
  const [bulkProbeSummary, setBulkProbeSummary] = useState<string | null>(null);

  const [isAddModelOpen, setIsAddModelOpen] = useState(false);
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [selectedModelId, setSelectedModelId] = useState('');
  const [selectedPriority, setSelectedPriority] = useState(1);
  const [liveModels, setLiveModels] = useState<FetchedModel[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [modelSearchQuery, setModelSearchQuery] = useState('');

  const [deletingAccountId, setDeletingAccountId] = useState<string | null>(null);

  const [sessionStats, setSessionStats] = useState<SessionStats>({
    requests: 0,
    lastProbeOk: null,
  });

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
    () => selectedConnectProvider?.authMethods ?? (['api_key'] as Array<'api_key' | 'oauth'>),
    [selectedConnectProvider],
  );

  const defaultModel = useMemo(() => getDefaultActiveModel(pipeline), [pipeline]);

  const filteredLiveModels = useMemo(
    () => filterLiveModels(liveModels, modelSearchQuery),
    [liveModels, modelSearchQuery],
  );

  const selectedAccount = useMemo(
    () => providerAccounts.find((account) => account.id === selectedAccountId) ?? null,
    [providerAccounts, selectedAccountId],
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

  const loadPipeline = useCallback(async () => {
    setIsLoadingPipeline(true);
    try {
      const response = await fetch(`/api/model-hub/pipeline?profileId=${PROFILE_ID}`);
      const data = (await response.json()) as ApiResponse & { models?: PipelineModel[] };
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setPipeline(data.models ?? []);
    } catch {
      setPipeline([]);
    } finally {
      setIsLoadingPipeline(false);
    }
  }, []);

  useEffect(() => {
    void loadProviders();
    void loadAccounts();
    void loadPipeline();
  }, [loadProviders, loadAccounts, loadPipeline]);

  useEffect(() => {
    if (!selectedConnectProvider) return;
    if (!availableAuthMethods.includes(connectAuthMethod)) {
      setConnectAuthMethod((availableAuthMethods[0] ?? 'api_key') as 'api_key' | 'oauth');
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

    if (!connectLabel.trim() || !connectSecret.trim()) {
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
          secret: connectSecret.trim(),
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
      if (event.origin !== window.location.origin) return;
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
      await Promise.all([loadAccounts(), loadPipeline()]);
    } catch (error) {
      setAccountsError(error instanceof Error ? error.message : 'Delete failed');
    }
  }

  async function fetchLiveModelsForAccount(accountId: string) {
    setIsLoadingModels(true);
    setLiveModels([]);
    setModelSearchQuery('');
    try {
      const response = await fetch(`/api/model-hub/accounts/${accountId}/models`);
      const data = (await response.json()) as ApiResponse & { models?: FetchedModel[] };
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      const models = data.models ?? [];
      setLiveModels(models);
      if (models.length > 0 && !selectedModelId) {
        setSelectedModelId(models[0].id);
      }
    } catch {
      const account = providerAccounts.find((entry) => entry.id === accountId);
      const provider = account ? providerLookup.get(account.providerId) : null;
      if (provider) {
        setLiveModels(
          provider.defaultModels.map((id) => ({ id, name: id, provider: provider.id })),
        );
      }
    } finally {
      setIsLoadingModels(false);
    }
  }

  async function runConnectionProbe() {
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
        connectivity?: { ok: boolean; message: string };
      };
      if (!response.ok || !data.ok || !data.connectivity)
        throw new Error(data.error || `HTTP ${response.status}`);
      setProbeResult(data.connectivity.message);
      setSessionStats((prev) => ({
        ...prev,
        requests: prev.requests + 1,
        lastProbeOk: data.connectivity?.ok ?? false,
      }));
      await loadAccounts();
    } catch (error) {
      setProbeResult(`FEHLER: ${error instanceof Error ? error.message : 'Probe fehlgeschlagen'}`);
      setSessionStats((prev) => ({ ...prev, lastProbeOk: false }));
    } finally {
      setIsProbing(false);
    }
  }

  async function runAllConnectionProbes() {
    if (providerAccounts.length === 0) {
      setBulkProbeSummary('Keine Provider-Accounts vorhanden.');
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
      };
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setBulkProbeSummary(`${data.successCount}/${data.total} OK, ${data.failureCount} FAILED`);
      setSessionStats((prev) => ({ ...prev, requests: prev.requests + (data.total ?? 0) }));
      await loadAccounts();
    } catch (error) {
      setBulkProbeSummary(
        `FEHLER: ${error instanceof Error ? error.message : 'Bulk probe failed'}`,
      );
    } finally {
      setIsTestingAll(false);
    }
  }

  function openAddModelModal() {
    if (providerAccounts.length === 0) {
      setProbeResult('Bitte zuerst einen Provider-Account verbinden.');
      return;
    }
    const initial = providerAccounts[0];
    setSelectedAccountId(initial.id);
    setSelectedModelId('');
    setSelectedPriority(pipeline.length + 1);
    setIsAddModelOpen(true);
    void fetchLiveModelsForAccount(initial.id);
  }

  async function saveAddedModel() {
    if (!selectedAccount || !selectedModelId) return;
    try {
      const response = await fetch('/api/model-hub/pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'add',
          profileId: PROFILE_ID,
          accountId: selectedAccount.id,
          providerId: selectedAccount.providerId,
          modelName: selectedModelId,
          priority: selectedPriority,
        }),
      });
      const data = (await response.json()) as ApiResponse;
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setIsAddModelOpen(false);
      setSelectedModelId('');
      await loadPipeline();
    } catch (error) {
      setProbeResult(error instanceof Error ? error.message : 'Model hinzufügen fehlgeschlagen');
    }
  }

  async function removeModelFromPipeline(modelId: string) {
    try {
      const response = await fetch('/api/model-hub/pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'remove', modelId }),
      });
      const data = (await response.json()) as ApiResponse;
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      await loadPipeline();
    } catch (error) {
      setProbeResult(error instanceof Error ? error.message : 'Entfernen fehlgeschlagen');
    }
  }

  async function toggleModelStatus(modelId: string, currentStatus: string) {
    const newStatus = currentStatus === 'active' ? 'offline' : 'active';
    try {
      const response = await fetch('/api/model-hub/pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'status', modelId, status: newStatus }),
      });
      const data = (await response.json()) as ApiResponse;
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      await loadPipeline();
    } catch (error) {
      setProbeResult(error instanceof Error ? error.message : 'Status-Update fehlgeschlagen');
    }
  }

  async function moveModelInPipeline(modelId: string, direction: 'up' | 'down') {
    try {
      const response = await fetch('/api/model-hub/pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reorder', profileId: PROFILE_ID, modelId, direction }),
      });
      const data = (await response.json()) as ApiResponse;
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      await loadPipeline();
    } catch (error) {
      setProbeResult(error instanceof Error ? error.message : 'Reorder fehlgeschlagen');
    }
  }

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 mx-auto max-w-6xl space-y-10 pb-20 duration-700">
      <HeaderSection
        pipelineLength={pipeline.length}
        providerCatalogLength={providerCatalog.length}
        isProbing={isProbing}
        isTestingAll={isTestingAll}
        probeResult={probeResult}
        bulkProbeSummary={bulkProbeSummary}
        onRunConnectionProbe={runConnectionProbe}
        onRunAllConnectionProbes={runAllConnectionProbes}
      />

      <div className="grid grid-cols-1 gap-10 lg:grid-cols-3">
        <PipelineSection
          isLoadingPipeline={isLoadingPipeline}
          pipeline={pipeline}
          providerLookup={providerLookup}
          providerAccounts={providerAccounts}
          onOpenAddModelModal={openAddModelModal}
          onToggleModelStatus={toggleModelStatus}
          onMoveModel={moveModelInPipeline}
          onRemoveModelFromPipeline={removeModelFromPipeline}
          isLoadingAccounts={isLoadingAccounts}
          deletingAccountId={deletingAccountId}
          onSetDeletingAccountId={setDeletingAccountId}
          onDeleteAccount={deleteAccount}
        />

        <SidebarSection
          providerCatalog={providerCatalog}
          connectProviderId={connectProviderId}
          onConnectProviderIdChange={(providerId) => {
            setConnectProviderId(providerId);
            setConnectLabel('');
            setConnectMessage(null);
          }}
          selectedConnectProvider={selectedConnectProvider}
          availableAuthMethods={availableAuthMethods}
          connectAuthMethod={connectAuthMethod}
          onConnectAuthMethodChange={setConnectAuthMethod}
          connectLabel={connectLabel}
          onConnectLabelChange={setConnectLabel}
          connectSecret={connectSecret}
          onConnectSecretChange={setConnectSecret}
          isConnecting={isConnecting}
          connectMessage={connectMessage}
          accountsError={accountsError}
          onConnectProviderAccount={connectProviderAccount}
          pipeline={pipeline}
          providerAccounts={providerAccounts}
          isLoadingAccounts={isLoadingAccounts}
          sessionStats={sessionStats}
        />
      </div>

      <AddModelModal
        isOpen={isAddModelOpen}
        providerAccounts={providerAccounts}
        providerLookup={providerLookup}
        selectedAccountId={selectedAccountId}
        onSelectedAccountIdChange={setSelectedAccountId}
        selectedAccount={selectedAccount}
        onFetchLiveModelsForAccount={(accountId) => {
          void fetchLiveModelsForAccount(accountId);
        }}
        onClose={() => setIsAddModelOpen(false)}
        isLoadingModels={isLoadingModels}
        liveModels={liveModels}
        filteredLiveModels={filteredLiveModels}
        modelSearchQuery={modelSearchQuery}
        onModelSearchQueryChange={setModelSearchQuery}
        selectedModelId={selectedModelId}
        onSelectedModelIdChange={setSelectedModelId}
        selectedPriority={selectedPriority}
        onSelectedPriorityChange={setSelectedPriority}
        pipelineLength={pipeline.length}
        onSave={() => {
          void saveAddedModel();
        }}
      />
    </div>
  );
};

export default ModelHub;
