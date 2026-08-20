import { useEffect, useMemo, useState } from 'react';
import { GRAPHITI_PROFILE_ID } from '@/components/model-hub/constants';
import type {
  CodexThinkingLevel,
  FetchedModel,
  ProviderCatalogEntry,
  ProviderAccount,
  SessionStats,
} from '@/components/model-hub/types';
import { filterLiveModels, getDefaultActiveModel } from '@/components/model-hub/utils';
import { usePipeline } from './usePipeline';
import { useProviders } from './useProviders';

export interface UseModelHubReturn {
  // Provider-related
  providerCatalog: ProviderCatalogEntry[];
  providerLookup: Map<string, ProviderCatalogEntry>;
  providerAccounts: ProviderAccount[];
  isLoadingAccounts: boolean;
  accountsError: string | null;

  // Connection-related
  connectProviderId: string;
  setConnectProviderId: (id: string) => void;
  connectAuthMethod: 'none' | 'api_key' | 'oauth';
  setConnectAuthMethod: (method: 'none' | 'api_key' | 'oauth') => void;
  connectLabel: string;
  setConnectLabel: (label: string) => void;
  connectSecret: string;
  setConnectSecret: (secret: string) => void;
  isConnecting: boolean;
  connectMessage: { text: string; ok: boolean } | null;
  setConnectMessage: (message: { text: string; ok: boolean } | null) => void;
  selectedConnectProvider: ProviderCatalogEntry | null;
  availableAuthMethods: Array<'none' | 'api_key' | 'oauth'>;
  connectProviderAccount: () => Promise<void>;

  // Pipeline-related
  pipeline: import('@/components/model-hub/types').PipelineModel[];
  isLoadingPipeline: boolean;
  embeddingPipeline: import('@/components/model-hub/types').PipelineModel[];
  isLoadingEmbeddingPipeline: boolean;
  graphitiPipeline: import('@/components/model-hub/types').PipelineModel[];
  isLoadingGraphitiPipeline: boolean;
  removeModelFromPipeline: (
    modelId: string,
    mode: 'pipeline' | 'embedding' | 'graphiti',
  ) => Promise<void>;
  toggleModelStatus: (
    modelId: string,
    currentStatus: string,
    mode: 'pipeline' | 'embedding' | 'graphiti',
  ) => Promise<void>;
  moveModelInPipeline: (
    modelId: string,
    direction: 'up' | 'down',
    mode: 'pipeline' | 'embedding' | 'graphiti',
  ) => Promise<void>;

  // Add model modal-related
  isAddModelOpen: boolean;
  setIsAddModelOpen: (open: boolean) => void;
  addModelMode: 'pipeline' | 'embedding' | 'graphiti';
  setAddModelMode: (mode: 'pipeline' | 'embedding' | 'graphiti') => void;
  selectedAccountId: string;
  setSelectedAccountId: (id: string) => void;
  selectedModelId: string;
  setSelectedModelId: (id: string) => void;
  selectedReasoningEffort: CodexThinkingLevel;
  setSelectedReasoningEffort: (level: CodexThinkingLevel) => void;
  selectedPriority: number;
  setSelectedPriority: (priority: number) => void;
  liveModels: FetchedModel[];
  isLoadingModels: boolean;
  modelSearchQuery: string;
  setModelSearchQuery: (query: string) => void;
  filteredLiveModels: FetchedModel[];
  selectableAccounts: ProviderAccount[];
  selectedAccount: ProviderAccount | null;
  openAddModelModal: (mode: 'pipeline' | 'embedding' | 'graphiti') => void;
  fetchLiveModelsForAccount: (
    accountId: string,
    mode?: 'pipeline' | 'embedding' | 'graphiti',
  ) => Promise<void>;
  saveAddedModel: () => Promise<void>;

  // Account management
  deletingAccountId: string | null;
  setDeletingAccountId: (id: string | null) => void;
  deleteAccount: (accountId: string) => Promise<void>;

  // Probing
  isProbing: boolean;
  probeResult: string | null;
  setProbeResult: (result: string | null) => void;
  isTestingAll: boolean;
  bulkProbeSummary: string | null;
  probeRateLimitsByAccountId: Record<
    string,
    import('@/components/model-hub/types').RateLimitSnapshot | null
  >;
  runConnectionProbe: () => Promise<void>;
  runAllConnectionProbes: () => Promise<void>;

  // Session
  sessionStats: SessionStats;
}

export function useModelHub(): UseModelHubReturn {
  const providers = useProviders();
  const pipeline = usePipeline();
  const { loadProviders, loadAccounts } = providers;
  const { reloadBoth } = pipeline;

  const [isAddModelOpen, setIsAddModelOpen] = useState(false);
  const [addModelMode, setAddModelMode] = useState<'pipeline' | 'embedding' | 'graphiti'>(
    'pipeline',
  );
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [selectedModelId, setSelectedModelId] = useState('');
  const [selectedReasoningEffort, setSelectedReasoningEffort] =
    useState<CodexThinkingLevel>('high');
  const [selectedPriority, setSelectedPriority] = useState(1);
  const [liveModels, setLiveModels] = useState<FetchedModel[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [modelSearchQuery, setModelSearchQuery] = useState('');

  const [sessionStats, setSessionStats] = useState<SessionStats>({
    requests: 0,
    lastProbeOk: null,
  });

  const defaultModel = useMemo(() => getDefaultActiveModel(pipeline.pipeline), [pipeline.pipeline]);

  const filteredLiveModels = useMemo(
    () => filterLiveModels(liveModels, modelSearchQuery),
    [liveModels, modelSearchQuery],
  );

  const embeddingCapableAccounts = useMemo(
    () =>
      providers.providerAccounts.filter((account) =>
        providers.providerLookup.get(account.providerId)?.capabilities.includes('embeddings'),
      ),
    [providers.providerAccounts, providers.providerLookup],
  );

  const graphitiCapableAccounts = useMemo(
    () =>
      providers.providerAccounts.filter((account) =>
        providers.providerLookup.get(account.providerId)?.capabilities.includes('chat'),
      ),
    [providers.providerAccounts, providers.providerLookup],
  );

  const selectableAccounts = useMemo(
    () =>
      addModelMode === 'embedding'
        ? embeddingCapableAccounts
        : addModelMode === 'graphiti'
          ? graphitiCapableAccounts
          : providers.providerAccounts,
    [addModelMode, embeddingCapableAccounts, graphitiCapableAccounts, providers.providerAccounts],
  );

  const selectedAccount = useMemo(
    () => selectableAccounts.find((account) => account.id === selectedAccountId) ?? null,
    [selectableAccounts, selectedAccountId],
  );

  // Load initial data
  useEffect(() => {
    void loadProviders();
    void loadAccounts();
    void reloadBoth();
  }, [loadProviders, loadAccounts, reloadBoth]);

  // Wrapper for removeModelFromPipeline with error handling
  const handleRemoveModelFromPipeline = async (
    modelId: string,
    mode: 'pipeline' | 'embedding' | 'graphiti' = 'pipeline',
  ) => {
    await pipeline.removeModelFromPipeline(modelId, mode, (errorMsg) => {
      providers.setProbeResult(errorMsg);
    });
  };

  // Wrapper for toggleModelStatus with error handling
  const handleToggleModelStatus = async (
    modelId: string,
    currentStatus: string,
    mode: 'pipeline' | 'embedding' | 'graphiti' = 'pipeline',
  ) => {
    await pipeline.toggleModelStatus(modelId, currentStatus, mode, (errorMsg) => {
      providers.setProbeResult(errorMsg);
    });
  };

  // Wrapper for moveModelInPipeline with error handling
  const handleMoveModelInPipeline = async (
    modelId: string,
    direction: 'up' | 'down',
    mode: 'pipeline' | 'embedding' | 'graphiti' = 'pipeline',
  ) => {
    await pipeline.moveModelInPipeline(modelId, direction, mode, (errorMsg) => {
      providers.setProbeResult(errorMsg);
    });
  };

  // Enhanced delete account that also reloads pipelines
  const handleDeleteAccount = async (accountId: string) => {
    await providers.deleteAccount(accountId);
    await pipeline.reloadBoth();
  };

  // Enhanced runConnectionProbe with session stats
  const handleRunConnectionProbe = async () => {
    const probe = await providers.runConnectionProbe(defaultModel);
    if (probe.message && !probe.message.startsWith('FEHLER:')) {
      setSessionStats((prev) => ({
        ...prev,
        requests: prev.requests + 1,
        lastProbeOk: true,
      }));
    } else if (probe.message.startsWith('FEHLER:')) {
      setSessionStats((prev) => ({ ...prev, lastProbeOk: false }));
    }
    await providers.loadAccounts();
  };

  // Enhanced runAllConnectionProbes with session stats
  const handleRunAllConnectionProbes = async () => {
    await providers.runAllConnectionProbes(pipeline.pipeline);
    setSessionStats((prev) => ({
      ...prev,
      requests: prev.requests + (providers.providerAccounts.length || 0),
    }));
    await providers.loadAccounts();
  };

  function openAddModelModal(mode: 'pipeline' | 'embedding' | 'graphiti') {
    const accountsForMode =
      mode === 'embedding'
        ? embeddingCapableAccounts
        : mode === 'graphiti'
          ? graphitiCapableAccounts
          : providers.providerAccounts;
    if (accountsForMode.length === 0) {
      providers.setProbeResult(
        mode === 'embedding'
          ? 'Bitte zuerst einen Embeddings-fähigen Provider-Account verbinden.'
          : mode === 'graphiti'
            ? 'Bitte zuerst einen Chat-fähigen Provider-Account verbinden.'
            : 'Bitte zuerst einen Provider-Account verbinden.',
      );
      return;
    }
    setAddModelMode(mode);
    const initial = accountsForMode[0];
    setSelectedAccountId(initial.id);
    setSelectedModelId('');
    setSelectedReasoningEffort(mode === 'graphiti' ? 'off' : 'high');
    setSelectedPriority(
      (mode === 'embedding'
        ? pipeline.embeddingPipeline.length
        : mode === 'graphiti'
          ? pipeline.graphitiPipeline.length
          : pipeline.pipeline.length) + 1,
    );
    setIsAddModelOpen(true);
    void fetchLiveModelsForAccount(initial.id, mode);
  }

  async function fetchLiveModelsForAccount(
    accountId: string,
    mode: 'pipeline' | 'embedding' | 'graphiti' = addModelMode,
  ) {
    setIsLoadingModels(true);
    setLiveModels([]);
    setModelSearchQuery('');
    try {
      const purpose = mode === 'embedding' ? 'embedding' : 'general';
      const response = await fetch(
        `/api/model-hub/accounts/${accountId}/models?purpose=${purpose}`,
      );
      const data = (await response.json()) as import('@/components/model-hub/types').ApiResponse & {
        models?: FetchedModel[];
      };
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      const models = data.models ?? [];
      setLiveModels(models);
      if (models.length > 0 && !selectedModelId) {
        setSelectedModelId(models[0].id);
      }
    } catch {
      const account = providers.providerAccounts.find((entry) => entry.id === accountId);
      const provider = account ? providers.providerLookup.get(account.providerId) : null;
      if (provider) {
        setLiveModels(
          provider.defaultModels.map((id) => ({ id, name: id, provider: provider.id })),
        );
      }
    } finally {
      setIsLoadingModels(false);
    }
  }

  async function saveAddedModel() {
    if (!selectedAccount || !selectedModelId) return;
    const profileId =
      addModelMode === 'embedding'
        ? 'p1-embeddings'
        : addModelMode === 'graphiti'
          ? GRAPHITI_PROFILE_ID
          : 'p1';
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
            (addModelMode === 'pipeline' || addModelMode === 'graphiti') &&
            selectedAccount.providerId === 'openai-codex'
              ? selectedReasoningEffort
              : undefined,
          priority: selectedPriority,
        }),
      });
      const data = (await response.json()) as import('@/components/model-hub/types').ApiResponse;
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setIsAddModelOpen(false);
      setSelectedModelId('');
      if (addModelMode === 'embedding') {
        await pipeline.loadEmbeddingPipeline();
      } else if (addModelMode === 'graphiti') {
        await pipeline.loadGraphitiPipeline();
      } else {
        await pipeline.loadPipeline();
      }
    } catch (error) {
      providers.setProbeResult(
        error instanceof Error ? error.message : 'Model hinzufügen fehlgeschlagen',
      );
    }
  }

  return {
    // Providers
    providerCatalog: providers.providerCatalog,
    providerLookup: providers.providerLookup,
    providerAccounts: providers.providerAccounts,
    isLoadingAccounts: providers.isLoadingAccounts,
    accountsError: providers.accountsError,

    // Connection
    connectProviderId: providers.connectProviderId,
    setConnectProviderId: providers.setConnectProviderId,
    connectAuthMethod: providers.connectAuthMethod,
    setConnectAuthMethod: providers.setConnectAuthMethod,
    connectLabel: providers.connectLabel,
    setConnectLabel: providers.setConnectLabel,
    connectSecret: providers.connectSecret,
    setConnectSecret: providers.setConnectSecret,
    isConnecting: providers.isConnecting,
    connectMessage: providers.connectMessage,
    setConnectMessage: providers.setConnectMessage,
    selectedConnectProvider: providers.selectedConnectProvider,
    availableAuthMethods: providers.availableAuthMethods,
    connectProviderAccount: providers.connectProviderAccount,

    // Pipeline
    pipeline: pipeline.pipeline,
    isLoadingPipeline: pipeline.isLoadingPipeline,
    embeddingPipeline: pipeline.embeddingPipeline,
    isLoadingEmbeddingPipeline: pipeline.isLoadingEmbeddingPipeline,
    graphitiPipeline: pipeline.graphitiPipeline,
    isLoadingGraphitiPipeline: pipeline.isLoadingGraphitiPipeline,
    removeModelFromPipeline: handleRemoveModelFromPipeline,
    toggleModelStatus: handleToggleModelStatus,
    moveModelInPipeline: handleMoveModelInPipeline,

    // Add model modal
    isAddModelOpen,
    setIsAddModelOpen,
    addModelMode,
    setAddModelMode,
    selectedAccountId,
    setSelectedAccountId,
    selectedModelId,
    setSelectedModelId,
    selectedReasoningEffort,
    setSelectedReasoningEffort,
    selectedPriority,
    setSelectedPriority,
    liveModels,
    isLoadingModels,
    modelSearchQuery,
    setModelSearchQuery,
    filteredLiveModels,
    selectableAccounts,
    selectedAccount,
    openAddModelModal,
    fetchLiveModelsForAccount,
    saveAddedModel,

    // Account management
    deletingAccountId: providers.deletingAccountId,
    setDeletingAccountId: providers.setDeletingAccountId,
    deleteAccount: handleDeleteAccount,

    // Probing
    isProbing: providers.isProbing,
    probeResult: providers.probeResult,
    setProbeResult: providers.setProbeResult,
    isTestingAll: providers.isTestingAll,
    bulkProbeSummary: providers.bulkProbeSummary,
    probeRateLimitsByAccountId: providers.probeRateLimitsByAccountId,
    runConnectionProbe: handleRunConnectionProbe,
    runAllConnectionProbes: handleRunAllConnectionProbes,

    // Session
    sessionStats,
  };
}
