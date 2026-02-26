import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { EMBEDDING_PROFILE_ID, PROFILE_ID } from '@/components/model-hub/constants';
import AddModelModal from '@/components/model-hub/modals/AddModelModal';
import HeaderSection from '@/components/model-hub/sections/HeaderSection';
import PipelineSection from '@/components/model-hub/sections/PipelineSection';
import SidebarSection from '@/components/model-hub/sections/SidebarSection';
import type {
  ApiResponse,
  CodexThinkingLevel,
  ConnectMessage,
  FetchedModel,
  PipelineModel,
  ProviderAccount,
  ProviderCatalogEntry,
  RateLimitSnapshot,
  SessionStats,
} from '@/components/model-hub/types';
import { filterLiveModels, getDefaultActiveModel } from '@/components/model-hub/utils';

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

const ModelHub: React.FC = () => {
  const [providerCatalog, setProviderCatalog] = useState<ProviderCatalogEntry[]>([]);

  const [providerAccounts, setProviderAccounts] = useState<ProviderAccount[]>([]);
  const [isLoadingAccounts, setIsLoadingAccounts] = useState(true);
  const [accountsError, setAccountsError] = useState<string | null>(null);

  const [pipeline, setPipeline] = useState<PipelineModel[]>([]);
  const [isLoadingPipeline, setIsLoadingPipeline] = useState(true);
  const [embeddingPipeline, setEmbeddingPipeline] = useState<PipelineModel[]>([]);
  const [isLoadingEmbeddingPipeline, setIsLoadingEmbeddingPipeline] = useState(true);

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

  const [isAddModelOpen, setIsAddModelOpen] = useState(false);
  const [addModelMode, setAddModelMode] = useState<'pipeline' | 'embedding'>('pipeline');
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [selectedModelId, setSelectedModelId] = useState('');
  const [selectedReasoningEffort, setSelectedReasoningEffort] =
    useState<CodexThinkingLevel>('high');
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
    () =>
      selectedConnectProvider?.authMethods ?? (['api_key'] as Array<'none' | 'api_key' | 'oauth'>),
    [selectedConnectProvider],
  );

  const defaultModel = useMemo(() => getDefaultActiveModel(pipeline), [pipeline]);

  const filteredLiveModels = useMemo(
    () => filterLiveModels(liveModels, modelSearchQuery),
    [liveModels, modelSearchQuery],
  );

  const embeddingCapableAccounts = useMemo(
    () =>
      providerAccounts.filter((account) =>
        providerLookup.get(account.providerId)?.capabilities.includes('embeddings'),
      ),
    [providerAccounts, providerLookup],
  );

  const selectableAccounts = useMemo(
    () => (addModelMode === 'embedding' ? embeddingCapableAccounts : providerAccounts),
    [addModelMode, embeddingCapableAccounts, providerAccounts],
  );

  const selectedAccount = useMemo(
    () => selectableAccounts.find((account) => account.id === selectedAccountId) ?? null,
    [selectableAccounts, selectedAccountId],
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

  const loadPipelineByProfile = useCallback(
    async (
      profileId: string,
      setModels: React.Dispatch<React.SetStateAction<PipelineModel[]>>,
      setLoading: React.Dispatch<React.SetStateAction<boolean>>,
    ) => {
      setLoading(true);
      try {
        const response = await fetch(`/api/model-hub/pipeline?profileId=${profileId}`);
        const data = (await response.json()) as ApiResponse & { models?: PipelineModel[] };
        if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
        setModels(data.models ?? []);
      } catch {
        setModels([]);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const loadPipeline = useCallback(async () => {
    await loadPipelineByProfile(PROFILE_ID, setPipeline, setIsLoadingPipeline);
  }, [loadPipelineByProfile]);

  const loadEmbeddingPipeline = useCallback(async () => {
    await loadPipelineByProfile(
      EMBEDDING_PROFILE_ID,
      setEmbeddingPipeline,
      setIsLoadingEmbeddingPipeline,
    );
  }, [loadPipelineByProfile]);

  useEffect(() => {
    void loadProviders();
    void loadAccounts();
    void loadPipeline();
    void loadEmbeddingPipeline();
  }, [loadProviders, loadAccounts, loadPipeline, loadEmbeddingPipeline]);

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
      await Promise.all([loadAccounts(), loadPipeline(), loadEmbeddingPipeline()]);
    } catch (error) {
      setAccountsError(error instanceof Error ? error.message : 'Delete failed');
    }
  }

  async function fetchLiveModelsForAccount(
    accountId: string,
    mode: 'pipeline' | 'embedding' = addModelMode,
  ) {
    setIsLoadingModels(true);
    setLiveModels([]);
    setModelSearchQuery('');
    try {
      const purpose = mode === 'embedding' ? 'embedding' : 'general';
      const response = await fetch(
        `/api/model-hub/accounts/${accountId}/models?purpose=${purpose}`,
      );
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
      setSessionStats((prev) => ({ ...prev, requests: prev.requests + (data.total ?? 0) }));
      await loadAccounts();
    } catch (error) {
      setBulkProbeSummary(
        `FEHLER: ${error instanceof Error ? error.message : 'Bulk probe failed'}`,
      );
      setProbeRateLimitsByAccountId({});
    } finally {
      setIsTestingAll(false);
    }
  }

  function openAddModelModal(mode: 'pipeline' | 'embedding') {
    const accountsForMode = mode === 'embedding' ? embeddingCapableAccounts : providerAccounts;
    if (accountsForMode.length === 0) {
      setProbeResult(
        mode === 'embedding'
          ? 'Bitte zuerst einen Embeddings-fähigen Provider-Account verbinden.'
          : 'Bitte zuerst einen Provider-Account verbinden.',
      );
      return;
    }
    setAddModelMode(mode);
    const initial = accountsForMode[0];
    setSelectedAccountId(initial.id);
    setSelectedModelId('');
    setSelectedReasoningEffort('high');
    setSelectedPriority((mode === 'embedding' ? embeddingPipeline.length : pipeline.length) + 1);
    setIsAddModelOpen(true);
    void fetchLiveModelsForAccount(initial.id, mode);
  }

  async function saveAddedModel() {
    if (!selectedAccount || !selectedModelId) return;
    const profileId = addModelMode === 'embedding' ? EMBEDDING_PROFILE_ID : PROFILE_ID;
    try {
      const response = await fetch('/api/model-hub/pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'add',
          profileId,
          accountId: selectedAccount.id,
          providerId: selectedAccount.providerId,
          modelName: selectedModelId,
          reasoningEffort:
            addModelMode === 'pipeline' && selectedAccount.providerId === 'openai-codex'
              ? selectedReasoningEffort
              : undefined,
          priority: selectedPriority,
        }),
      });
      const data = (await response.json()) as ApiResponse;
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setIsAddModelOpen(false);
      setSelectedModelId('');
      if (addModelMode === 'embedding') {
        await loadEmbeddingPipeline();
      } else {
        await loadPipeline();
      }
    } catch (error) {
      setProbeResult(error instanceof Error ? error.message : 'Model hinzufügen fehlgeschlagen');
    }
  }

  async function removeModelFromPipeline(
    modelId: string,
    mode: 'pipeline' | 'embedding' = 'pipeline',
  ) {
    try {
      const response = await fetch('/api/model-hub/pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'remove', modelId }),
      });
      const data = (await response.json()) as ApiResponse;
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (mode === 'embedding') {
        await loadEmbeddingPipeline();
      } else {
        await loadPipeline();
      }
    } catch (error) {
      setProbeResult(error instanceof Error ? error.message : 'Entfernen fehlgeschlagen');
    }
  }

  async function toggleModelStatus(
    modelId: string,
    currentStatus: string,
    mode: 'pipeline' | 'embedding' = 'pipeline',
  ) {
    const newStatus = currentStatus === 'active' ? 'offline' : 'active';
    try {
      const response = await fetch('/api/model-hub/pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'status', modelId, status: newStatus }),
      });
      const data = (await response.json()) as ApiResponse;
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (mode === 'embedding') {
        await loadEmbeddingPipeline();
      } else {
        await loadPipeline();
      }
    } catch (error) {
      setProbeResult(error instanceof Error ? error.message : 'Status-Update fehlgeschlagen');
    }
  }

  async function moveModelInPipeline(
    modelId: string,
    direction: 'up' | 'down',
    mode: 'pipeline' | 'embedding' = 'pipeline',
  ) {
    try {
      const profileId = mode === 'embedding' ? EMBEDDING_PROFILE_ID : PROFILE_ID;
      const response = await fetch('/api/model-hub/pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reorder', profileId, modelId, direction }),
      });
      const data = (await response.json()) as ApiResponse;
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (mode === 'embedding') {
        await loadEmbeddingPipeline();
      } else {
        await loadPipeline();
      }
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
        lastProbeOk={sessionStats.lastProbeOk}
        bulkProbeSummary={bulkProbeSummary}
        onRunConnectionProbe={runConnectionProbe}
        onRunAllConnectionProbes={runAllConnectionProbes}
      />

      <div className="grid grid-cols-1 gap-10 lg:grid-cols-3">
        <PipelineSection
          isLoadingPipeline={isLoadingPipeline}
          pipeline={pipeline}
          isLoadingEmbeddingPipeline={isLoadingEmbeddingPipeline}
          embeddingPipeline={embeddingPipeline}
          providerLookup={providerLookup}
          providerAccounts={providerAccounts}
          onOpenAddModelModal={() => openAddModelModal('pipeline')}
          onOpenAddEmbeddingModelModal={() => openAddModelModal('embedding')}
          onToggleModelStatus={(modelId, currentStatus) =>
            void toggleModelStatus(modelId, currentStatus, 'pipeline')
          }
          onMoveModel={(modelId, direction) =>
            void moveModelInPipeline(modelId, direction, 'pipeline')
          }
          onRemoveModelFromPipeline={(modelId) => void removeModelFromPipeline(modelId, 'pipeline')}
          onToggleEmbeddingModelStatus={(modelId, currentStatus) =>
            void toggleModelStatus(modelId, currentStatus, 'embedding')
          }
          onMoveEmbeddingModel={(modelId, direction) =>
            void moveModelInPipeline(modelId, direction, 'embedding')
          }
          onRemoveEmbeddingModelFromPipeline={(modelId) =>
            void removeModelFromPipeline(modelId, 'embedding')
          }
          isLoadingAccounts={isLoadingAccounts}
          deletingAccountId={deletingAccountId}
          onSetDeletingAccountId={setDeletingAccountId}
          onDeleteAccount={deleteAccount}
          probeRateLimitsByAccountId={probeRateLimitsByAccountId}
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
        mode={addModelMode}
        providerAccounts={selectableAccounts}
        providerLookup={providerLookup}
        selectedAccountId={selectedAccountId}
        onSelectedAccountIdChange={(accountId) => {
          setSelectedAccountId(accountId);
          const nextAccount = selectableAccounts.find((account) => account.id === accountId);
          if (addModelMode === 'pipeline' && nextAccount?.providerId === 'openai-codex') {
            setSelectedReasoningEffort('high');
          }
        }}
        selectedAccount={selectedAccount}
        onFetchLiveModelsForAccount={(accountId) => {
          void fetchLiveModelsForAccount(accountId, addModelMode);
        }}
        onClose={() => {
          setIsAddModelOpen(false);
          setAddModelMode('pipeline');
        }}
        isLoadingModels={isLoadingModels}
        liveModels={liveModels}
        filteredLiveModels={filteredLiveModels}
        modelSearchQuery={modelSearchQuery}
        onModelSearchQueryChange={setModelSearchQuery}
        selectedModelId={selectedModelId}
        onSelectedModelIdChange={setSelectedModelId}
        selectedReasoningEffort={selectedReasoningEffort}
        onSelectedReasoningEffortChange={setSelectedReasoningEffort}
        selectedPriority={selectedPriority}
        onSelectedPriorityChange={setSelectedPriority}
        pipelineLength={addModelMode === 'embedding' ? embeddingPipeline.length : pipeline.length}
        onSave={() => {
          void saveAddedModel();
        }}
      />
    </div>
  );
};

export default ModelHub;
