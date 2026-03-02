'use client';

import React, { useState, useCallback } from 'react';
import { useConfig } from '@/components/config/hooks/useConfig';
import { ConfigHeader } from '@/components/config/components/ConfigHeader';
import { ConfigTabs } from '@/components/config/components/ConfigTabs';
import { ConfigInfoBar } from '@/components/config/components/ConfigInfoBar';
import { StatusMessage } from '@/components/config/components/StatusMessage';
import { ConflictWarning } from '@/components/config/components/ConflictWarning';
import { DiffPreview } from '@/components/config/components/DiffPreview';
import { ValidationPanel } from '@/components/config/components/ValidationPanel';
import { OverviewTab } from '@/components/config/components/tabs/OverviewTab';
import { NetworkTab } from '@/components/config/components/tabs/NetworkTab';
import { RuntimeTab } from '@/components/config/components/tabs/RuntimeTab';
import { UITab } from '@/components/config/components/tabs/UITab';
import { AdvancedTab } from '@/components/config/components/tabs/AdvancedTab';
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
    <div className="flex h-full flex-col gap-4 overflow-hidden bg-zinc-950 px-1 py-1">
      {/* ── Page Header ─────────────────────────────────────────────────── */}
      <ConfigHeader
        hasChanges={hasChanges}
        isSaving={isSaving}
        isLoading={isLoading}
        canApply={canApply}
        onReload={() => void loadConfig()}
        onOpenDiffPreview={openDiffPreview}
      />

      {/* ── Status / Conflict / Diff banners ────────────────────────────── */}
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

      {/* ── Main content card ────────────────────────────────────────────── */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900">
        {/* Info bar */}
        <ConfigInfoBar
          configPath={configPath}
          configSource={configSource}
          baselineRevision={baselineRevision}
        />

        {/* Tab navigation */}
        <div className="px-4 pt-3">
          <ConfigTabs activeTab={activeTab} onTabChange={setActiveTab} />
        </div>

        {/* Tab content */}
        <div
          id={`config-tab-panel-${activeTab}`}
          role="tabpanel"
          aria-labelledby={`config-tab-${activeTab}`}
          className="flex-1 overflow-auto p-5"
        >
          {/* Simple mode disabled notice */}
          {simpleModeDisabled && (
            <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-amber-800/40 bg-amber-950/20 px-4 py-3 text-xs text-amber-300">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 20 20"
                fill="currentColor"
                className="mt-px h-4 w-4 shrink-0 text-amber-400"
                aria-hidden="true"
              >
                <path
                  fillRule="evenodd"
                  d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
                  clipRule="evenodd"
                />
              </svg>
              <span>
                Simple tab editing is disabled until the JSON in{' '}
                <button
                  type="button"
                  onClick={() => setActiveTab('advanced')}
                  className="underline hover:text-amber-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-400"
                >
                  Advanced JSON
                </button>{' '}
                is valid.
              </span>
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

      {/* ── Validation panel ─────────────────────────────────────────────── */}
      <ValidationPanel
        validationError={validationError}
        validationFieldPath={validationFieldPath}
      />
    </div>
  );
};

export default ConfigEditor;
