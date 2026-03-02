'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { toJsonString, isObject } from '@/components/config/utils/configHelpers';
import type { StatusMessage, ConfigWarning } from '@/components/config/types';
import { DEFAULT_CONFIG } from '@/components/config/types';
import { loadConfigFromApi, saveConfigToApi } from '@/components/config/apiClient';
import { mapValidationMessageToFieldPath } from '@/shared/config/fieldMetadata';
import { summarizeConfigDiff, type DiffItem } from '@/shared/config/diffSummary';

export function useConfig() {
  const [config, setConfig] = useState(() => toJsonString(DEFAULT_CONFIG));
  const [baselineConfig, setBaselineConfig] = useState<Record<string, unknown>>(DEFAULT_CONFIG);
  const [baselineRevision, setBaselineRevision] = useState('');
  const [hasChanges, setHasChanges] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [validationFieldPath, setValidationFieldPath] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<StatusMessage | null>(null);
  const [compatibilityWarnings, setCompatibilityWarnings] = useState<ConfigWarning[]>([]);
  const [configPath, setConfigPath] = useState('~/.openclaw/openclaw.json');
  const [configSource, setConfigSource] = useState<'default' | 'file' | 'unknown'>('unknown');
  const [showDiffPreview, setShowDiffPreview] = useState(false);
  const [pendingParsedConfig, setPendingParsedConfig] = useState<Record<string, unknown> | null>(
    null,
  );
  const [diffItems, setDiffItems] = useState<DiffItem[]>([]);
  const [conflictRevision, setConflictRevision] = useState<string | null>(null);

  const parsedConfig = useMemo(() => {
    try {
      const parsed = JSON.parse(config) as unknown;
      return isObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }, [config]);

  const loadConfig = useCallback(async () => {
    setIsLoading(true);
    setStatusMessage(null);
    setConflictRevision(null);
    try {
      const { response, payload } = await loadConfigFromApi();
      if (!response.ok || !payload.ok || !payload.config) {
        throw new Error(payload.error || 'Failed to load config.');
      }
      setConfig(toJsonString(payload.config));
      setBaselineConfig(payload.config);
      setBaselineRevision(String(payload.revision || ''));
      setConfigPath(payload.displayPath || '~/.openclaw/openclaw.json');
      setConfigSource(payload.source || 'unknown');
      setCompatibilityWarnings(payload.warnings || []);
      setValidationError(null);
      setValidationFieldPath(null);
      setHasChanges(false);
      setShowDiffPreview(false);
      setPendingParsedConfig(null);
      setDiffItems([]);
      if (payload.source === 'default') {
        setStatusMessage({ tone: 'info', text: 'No config file found. Loaded default config.' });
      } else if ((payload.warnings || []).length > 0) {
        setStatusMessage({
          tone: 'info',
          text: `Config loaded with ${(payload.warnings || []).length} compatibility warning(s).`,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load config.';
      setCompatibilityWarnings([]);
      setStatusMessage({ tone: 'error', text: message });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  // Prevent unload with unsaved changes
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (event: BeforeUnloadEvent) => {
      if (!hasChanges) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasChanges]);

  const updateConfigDraft = useCallback((mutate: (draft: Record<string, unknown>) => void) => {
    setConfig((previous) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(previous) as unknown;
      } catch (error) {
        setValidationError(error instanceof Error ? error.message : 'Invalid JSON.');
        setValidationFieldPath(null);
        return previous;
      }
      if (!isObject(parsed)) {
        setValidationError('Config root must be an object.');
        setValidationFieldPath(null);
        return previous;
      }
      const draft = JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>;
      mutate(draft);
      setValidationError(null);
      setValidationFieldPath(null);
      setHasChanges(true);
      setConflictRevision(null);
      return toJsonString(draft);
    });
  }, []);

  const parseCurrentConfig = useCallback((): Record<string, unknown> | null => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(config) as unknown;
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : 'Invalid JSON.');
      setValidationFieldPath(null);
      setStatusMessage({ tone: 'error', text: 'Apply failed. Invalid JSON.' });
      return null;
    }

    if (!isObject(parsed)) {
      setValidationError('Config root must be an object.');
      setValidationFieldPath(null);
      setStatusMessage({ tone: 'error', text: 'Apply failed. Config root must be an object.' });
      return null;
    }

    return parsed;
  }, [config]);

  const executeApply = useCallback(async (parsed: Record<string, unknown>, revision: string) => {
    setIsSaving(true);
    setStatusMessage(null);
    try {
      const { response, payload } = await saveConfigToApi(parsed, revision);

      if (!response.ok || !payload.ok || !payload.config) {
        const message = payload.error || 'Failed to save config.';
        if (payload.code === 'CONFIG_STALE_REVISION') {
          setConflictRevision(payload.currentRevision || null);
          setStatusMessage({
            tone: 'error',
            text: 'Config changed in another session. Reload latest config or review diff before retry.',
          });
        } else {
          setStatusMessage({ tone: 'error', text: message });
        }
        setValidationError(message);
        setValidationFieldPath(mapValidationMessageToFieldPath(message));
        return;
      }

      setConfig(toJsonString(payload.config));
      setBaselineConfig(payload.config);
      setBaselineRevision(String(payload.revision || ''));
      setConfigPath(payload.displayPath || '~/.openclaw/openclaw.json');
      setConfigSource(payload.source || 'file');
      setCompatibilityWarnings(payload.warnings || []);
      setValidationError(null);
      setValidationFieldPath(null);
      setHasChanges(false);
      setShowDiffPreview(false);
      setPendingParsedConfig(null);
      setDiffItems([]);
      setConflictRevision(null);

      if ((payload.warnings || []).length > 0) {
        setStatusMessage({
          tone: 'info',
          text: `Config saved with ${(payload.warnings || []).length} compatibility warning(s).`,
        });
      } else {
        setStatusMessage({ tone: 'success', text: 'Config saved successfully.' });
      }
    } catch (error) {
      setStatusMessage({
        tone: 'error',
        text: error instanceof Error ? error.message : 'Failed to save config.',
      });
    } finally {
      setIsSaving(false);
    }
  }, []);

  const openDiffPreview = useCallback(() => {
    const parsed = parseCurrentConfig();
    if (!parsed) return;
    setDiffItems(summarizeConfigDiff(baselineConfig, parsed));
    setPendingParsedConfig(parsed);
    setShowDiffPreview(true);
  }, [baselineConfig, parseCurrentConfig]);

  const handleConfirmApply = useCallback(
    async (revisionOverride?: string) => {
      if (!pendingParsedConfig) return;
      const revisionToUse = revisionOverride || baselineRevision;
      if (!revisionToUse) {
        setStatusMessage({
          tone: 'error',
          text: 'Missing config revision. Reload config before applying changes.',
        });
        return;
      }
      await executeApply(pendingParsedConfig, revisionToUse);
    },
    [baselineRevision, executeApply, pendingParsedConfig],
  );

  const updateRawConfig = useCallback((value: string) => {
    setConfig(value);
    setHasChanges(true);
    setConflictRevision(null);
    try {
      const parsed = JSON.parse(value) as unknown;
      if (!isObject(parsed)) {
        setValidationError('Config root must be an object.');
        setValidationFieldPath(null);
        return;
      }
      setValidationError(null);
      setValidationFieldPath(null);
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : 'Invalid JSON.');
      setValidationFieldPath(null);
    }
  }, []);

  return {
    config,
    setConfig,
    baselineConfig,
    baselineRevision,
    hasChanges,
    isLoading,
    isSaving,
    validationError,
    validationFieldPath,
    statusMessage,
    setStatusMessage,
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
    parseCurrentConfig,
    executeApply,
    openDiffPreview,
    handleConfirmApply,
    updateRawConfig,
  };
}
