'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import type { ControlPlaneMetricsState } from '@/shared/domain/types';
import {
  applyOperatorProfileToConfig,
  computeOperatorUsageSnapshot,
  parseOperatorProfileFromConfig,
  type OperatorProfileState,
} from '@/modules/profile/operatorProfileConfig';
import { loadConfigFromApi, saveConfigToApi } from '@/components/config/apiClient';
import { createLocalUuid, parsePositiveInt } from '@/components/profile/utils/profileHelpers';
import type { StatusMessage } from '@/components/profile/types';

interface UseProfileOptions {
  metricsState?: ControlPlaneMetricsState;
}

export function useProfile(options: UseProfileOptions = {}) {
  const { metricsState } = options;

  const [profile, setProfile] = useState<OperatorProfileState>(() =>
    parseOperatorProfileFromConfig({}),
  );
  const [baselineConfig, setBaselineConfig] = useState<Record<string, unknown> | null>(null);
  const [baselineRevision, setBaselineRevision] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<StatusMessage | null>(null);

  const loadProfile = useCallback(async () => {
    setIsLoading(true);
    setStatusMessage(null);

    try {
      const { response, payload } = await loadConfigFromApi();
      if (!response.ok || !payload.ok || !payload.config) {
        throw new Error(payload.error || 'Failed to load operator profile.');
      }

      const parsed = parseOperatorProfileFromConfig(payload.config);
      if (!parsed.localUuid) {
        parsed.localUuid = createLocalUuid();
      }

      setProfile(parsed);
      setBaselineConfig(payload.config);
      setBaselineRevision(String(payload.revision || ''));

      if ((payload.warnings || []).length > 0) {
        setStatusMessage({
          tone: 'info',
          text: `Profile loaded with ${(payload.warnings || []).length} compatibility warning(s).`,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load operator profile.';
      setStatusMessage({ tone: 'error', text: message });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  const usage = useMemo(
    () =>
      computeOperatorUsageSnapshot(
        {
          workspaceSlots: profile.workspaceSlots,
          dailyTokenBudget: profile.dailyTokenBudget,
        },
        metricsState?.metrics,
      ),
    [metricsState?.metrics, profile.dailyTokenBudget, profile.workspaceSlots],
  );

  const handleSave = useCallback(async () => {
    if (!baselineConfig || !baselineRevision) {
      setStatusMessage({
        tone: 'error',
        text: 'Missing config baseline. Reload profile before saving.',
      });
      return;
    }

    const displayName = profile.displayName.trim();
    if (!displayName) {
      setStatusMessage({ tone: 'error', text: 'Display Name is required.' });
      return;
    }

    const profileForSave = profile.localUuid.trim()
      ? profile
      : { ...profile, localUuid: createLocalUuid() };
    const nextConfig = applyOperatorProfileToConfig(baselineConfig, {
      ...profileForSave,
      displayName,
      primaryContact: profile.primaryContact.trim(),
    });

    setIsSaving(true);
    setStatusMessage(null);
    try {
      const { response, payload } = await saveConfigToApi(nextConfig, baselineRevision);

      if (!response.ok || !payload.ok || !payload.config) {
        if (payload.code === 'CONFIG_STALE_REVISION') {
          setStatusMessage({
            tone: 'error',
            text: 'Config changed in another session. Reload and retry save.',
          });
          if (typeof payload.currentRevision === 'string' && payload.currentRevision.length > 0) {
            setBaselineRevision(payload.currentRevision);
          }
          return;
        }
        throw new Error(payload.error || 'Failed to save operator profile.');
      }

      const savedProfile = parseOperatorProfileFromConfig(payload.config);
      setProfile(savedProfile);
      setBaselineConfig(payload.config);
      setBaselineRevision(String(payload.revision || ''));
      setStatusMessage({ tone: 'success', text: 'Operator profile saved.' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save operator profile.';
      setStatusMessage({ tone: 'error', text: message });
    } finally {
      setIsSaving(false);
    }
  }, [baselineConfig, baselineRevision, profile]);

  const updateDisplayName = useCallback((value: string) => {
    setProfile((previous) => ({ ...previous, displayName: value }));
  }, []);

  const updatePrimaryContact = useCallback((value: string) => {
    setProfile((previous) => ({ ...previous, primaryContact: value }));
  }, []);

  const updateWorkspaceSlots = useCallback((value: string) => {
    setProfile((previous) => ({
      ...previous,
      workspaceSlots: parsePositiveInt(value, previous.workspaceSlots),
    }));
  }, []);

  const updateDailyTokenBudget = useCallback((value: string) => {
    setProfile((previous) => ({
      ...previous,
      dailyTokenBudget: parsePositiveInt(value, previous.dailyTokenBudget),
    }));
  }, []);

  return {
    profile,
    setProfile,
    baselineConfig,
    baselineRevision,
    isLoading,
    isSaving,
    statusMessage,
    setStatusMessage,
    usage,
    loadProfile,
    handleSave,
    updateDisplayName,
    updatePrimaryContact,
    updateWorkspaceSlots,
    updateDailyTokenBudget,
  };
}
