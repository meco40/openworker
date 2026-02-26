import React, { useEffect } from 'react';
import AddModelModal from '@/components/model-hub/modals/AddModelModal';
import HeaderSection from '@/components/model-hub/sections/HeaderSection';
import PipelineSection from '@/components/model-hub/sections/PipelineSection';
import SidebarSection from '@/components/model-hub/sections/SidebarSection';
import { useModelHub } from './hooks';

const ModelHub: React.FC = () => {
  const {
    // Provider data
    providerCatalog,
    providerLookup,
    providerAccounts,
    isLoadingAccounts,
    accountsError,

    // Connection state
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

    // Pipeline data
    pipeline,
    isLoadingPipeline,
    embeddingPipeline,
    isLoadingEmbeddingPipeline,
    removeModelFromPipeline,
    toggleModelStatus,
    moveModelInPipeline,

    // Add model modal
    isAddModelOpen,
    setIsAddModelOpen,
    addModelMode,
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
    deletingAccountId,
    setDeletingAccountId,
    deleteAccount,

    // Probing
    isProbing,
    probeResult,
    setProbeResult,
    isTestingAll,
    bulkProbeSummary,
    probeRateLimitsByAccountId,
    runConnectionProbe,
    runAllConnectionProbes,

    // Session
    sessionStats,
  } = useModelHub();

  // Clear probe result when component unmounts
  useEffect(() => {
    return () => {
      setProbeResult(null);
    };
  }, [setProbeResult]);

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
