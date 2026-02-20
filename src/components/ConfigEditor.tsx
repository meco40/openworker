'use client';

import React, { useState, useCallback } from 'react';
import { useConfig } from '@/components/config/hooks';
import {
  ConfigHeader,
  ConfigTabs,
  ConfigInfoBar,
  StatusMessage,
  ConflictWarning,
  DiffPreview,
  ValidationPanel,
  OverviewTab,
  NetworkTab,
  RuntimeTab,
  UITab,
  AdvancedTab,
} from '@/components/config/components';
import type { ConfigTab } from '@/components/config/types';

// Re-exports for backward compatibility
export { hasHighRiskDiff, summarizeConfigDiff, type DiffItem } from '@/shared/config/diffSummary';

const ConfigEditor: React.FC = () => {
  const [activeTab, setActiveTab] = useState<ConfigTab>('overview');

  const {
    config,
    baselineRevision,
    hasChanges,
    isLoading,
    isSaving,
    validationError,
    validationFieldPath,
    statusMessage,
    compatibilityWarnings,
    configPath,
    configSource,
    showDiffPreview,
    setShowDiffPreview,
    pendingParsedConfig,
    diffItems,
    conflictRevision,
    parsedConfig,
    loadConfig,
    updateConfigDraft,
    openDiffPreview,
    handleConfirmApply,
    updateRawConfig,
  } = useConfig();

  const fieldErrorFor = useCallback(
    (path: string) => (validationError && validationFieldPath === path ? validationError : null),
    [validationError, validationFieldPath],
  );

  const canApply = hasChanges && !isSaving && !isLoading && !validationError;
  const simpleModeDisabled = activeTab !== 'advanced' && parsedConfig === null;

  return (
    <div className="flex h-full flex-col space-y-4">
      <ConfigHeader
        hasChanges={hasChanges}
        isSaving={isSaving}
        isLoading={isLoading}
        canApply={canApply}
        onReload={() => void loadConfig()}
        onOpenDiffPreview={openDiffPreview}
      />

      <ConfigTabs activeTab={activeTab} onTabChange={setActiveTab} />

      {statusMessage && <StatusMessage message={statusMessage} />}

      {conflictRevision && (
        <ConflictWarning
          onReload={() => void loadConfig()}
          onRetry={() => {
            if (pendingParsedConfig) {
              void handleConfirmApply(conflictRevision);
            }
          }}
        />
      )}

      {showDiffPreview && (
        <DiffPreview
          diffItems={diffItems}
          onCancel={() => setShowDiffPreview(false)}
          onConfirm={() => void handleConfirmApply()}
        />
      )}

      <div className="flex flex-1 flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950">
        <ConfigInfoBar
          configPath={configPath}
          configSource={configSource}
          baselineRevision={baselineRevision}
        />

        <div className="space-y-4 overflow-auto p-5">
          {simpleModeDisabled && (
            <div className="rounded border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">
              Simple tab editing is disabled until the JSON in Advanced mode is valid.
            </div>
          )}

          {activeTab === 'overview' && (
            <OverviewTab
              configSource={configSource}
              hasChanges={hasChanges}
              compatibilityWarnings={compatibilityWarnings}
            />
          )}

          {activeTab === 'network' && (
            <NetworkTab
              parsedConfig={parsedConfig}
              simpleModeDisabled={simpleModeDisabled}
              fieldErrorFor={fieldErrorFor}
              updateConfigDraft={updateConfigDraft}
            />
          )}

          {activeTab === 'runtime' && (
            <RuntimeTab
              parsedConfig={parsedConfig}
              simpleModeDisabled={simpleModeDisabled}
              fieldErrorFor={fieldErrorFor}
              updateConfigDraft={updateConfigDraft}
            />
          )}

          {activeTab === 'ui' && (
            <UITab
              parsedConfig={parsedConfig}
              simpleModeDisabled={simpleModeDisabled}
              fieldErrorFor={fieldErrorFor}
              updateConfigDraft={updateConfigDraft}
            />
          )}

          {activeTab === 'advanced' && (
            <AdvancedTab config={config} isLoading={isLoading} onChange={updateRawConfig} />
          )}
        </div>
      </div>

      <ValidationPanel
        validationError={validationError}
        validationFieldPath={validationFieldPath}
      />
    </div>
  );
};

export default ConfigEditor;
