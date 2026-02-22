'use client';

import { useState, useCallback } from 'react';
import {
  type SkillRuntimeConfigStatus,
  clearSkillRuntimeConfig,
  listSkillRuntimeConfigs,
  setSkillRuntimeConfig,
} from '@/skills/runtime-config-client';

export function useRuntimeConfigs(): import('@/skills/components/registry/types').UseRuntimeConfigsReturn {
  const [configs, setConfigs] = useState<SkillRuntimeConfigStatus[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const loadConfigs = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await listSkillRuntimeConfigs();
      if (!response.ok || !response.configs) {
        setError(response.error || 'Failed to load tool configuration.');
        setConfigs([]);
        return;
      }
      setConfigs(response.configs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tool configuration.');
      setConfigs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleDraft = useCallback((id: string, value: string) => {
    setDrafts((prev) => ({ ...prev, [id]: value }));
  }, []);

  const handleSave = useCallback(
    async (id: string) => {
      const value = String(drafts[id] || '').trim();
      if (!value) {
        setError('Please enter a value before saving.');
        return;
      }

      setSavingId(id);
      setError('');
      try {
        const response = await setSkillRuntimeConfig(id, value);
        if (!response.ok) {
          setError(response.error || 'Failed to save tool configuration.');
          return;
        }
        setDrafts((prev) => ({ ...prev, [id]: '' }));
        await loadConfigs();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save tool configuration.');
      } finally {
        setSavingId(null);
      }
    },
    [drafts, loadConfigs],
  );

  const handleClear = useCallback(
    async (id: string) => {
      setSavingId(id);
      setError('');
      try {
        const response = await clearSkillRuntimeConfig(id);
        if (!response.ok) {
          setError(response.error || 'Failed to clear tool configuration.');
          return;
        }
        setDrafts((prev) => ({ ...prev, [id]: '' }));
        await loadConfigs();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to clear tool configuration.');
      } finally {
        setSavingId(null);
      }
    },
    [loadConfigs],
  );

  const getMissingRequired = useCallback(
    (skillId: string): SkillRuntimeConfigStatus[] =>
      configs.filter(
        (config) => config.skillId === skillId && config.required && !config.configured,
      ),
    [configs],
  );

  return {
    configs,
    drafts,
    loading,
    savingId,
    error,
    loadConfigs,
    handleDraft,
    handleSave,
    handleClear,
    getMissingRequired,
  };
}
