'use client';

import { useState, useRef, useCallback } from 'react';
import {
  type ClawHubInstalledSkill,
  type ClawHubSearchItem,
  installClawHubSkill,
  listInstalledClawHubSkills,
  searchClawHubSkills,
  setClawHubSkillEnabled,
  uninstallClawHubSkill,
  updateClawHubSkill,
} from '@/skills/clawhub-client';
import { emitClawHubChanged } from '@/skills/clawhub-events';
import { normalizeInstalledSkills } from '@/skills/components/registry/types';

export function useClawHub(): import('@/skills/components/registry/types').UseClawHubReturn {
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ClawHubSearchItem[]>([]);
  const [searchWarnings, setSearchWarnings] = useState<string[]>([]);
  const [installed, setInstalled] = useState<ClawHubInstalledSkill[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const busyRef = useRef(false);

  const notifyChanged = useCallback(() => {
    emitClawHubChanged();
  }, []);

  const beginAction = useCallback((): boolean => {
    if (busyRef.current) {
      return false;
    }
    busyRef.current = true;
    setLoading(true);
    setError('');
    return true;
  }, []);

  const endAction = useCallback(() => {
    busyRef.current = false;
    setLoading(false);
  }, []);

  const refreshInstalled = useCallback(async () => {
    if (!beginAction()) return;
    try {
      const data = await listInstalledClawHubSkills();
      if (!data.ok) {
        setError(data.error || 'Failed to load installed ClawHub skills.');
        return;
      }
      setInstalled(normalizeInstalledSkills(data.skills));
      notifyChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load ClawHub skills.');
    } finally {
      endAction();
    }
  }, [beginAction, endAction, notifyChanged]);

  const handleSearch = useCallback(async () => {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      setError('');
      setSearchResults([]);
      setSearchWarnings([]);
      return;
    }

    if (!beginAction()) return;
    try {
      const data = await searchClawHubSkills(trimmedQuery, 25);
      if (!data.ok) {
        setError(data.error || 'ClawHub search failed.');
        setSearchResults([]);
        setSearchWarnings([]);
        return;
      }
      setSearchResults(data.items || []);
      setSearchWarnings(data.parseWarnings || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ClawHub search failed.');
      setSearchResults([]);
      setSearchWarnings([]);
    } finally {
      endAction();
    }
  }, [query, beginAction, endAction]);

  const handleSearchReset = useCallback(() => {
    setQuery('');
    setSearchResults([]);
    setSearchWarnings([]);
    setError('');
  }, []);

  const handleInstall = useCallback(
    async (slug: string) => {
      if (!beginAction()) return;
      try {
        const response = await installClawHubSkill({ slug });
        if (!response.ok) {
          setError(response.error || 'ClawHub install failed.');
          return;
        }
        const refreshed = await listInstalledClawHubSkills();
        if (refreshed.ok) {
          setInstalled(normalizeInstalledSkills(refreshed.skills));
          notifyChanged();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'ClawHub install failed.');
      } finally {
        endAction();
      }
    },
    [beginAction, endAction, notifyChanged],
  );

  const handleUpdate = useCallback(
    async (slug?: string) => {
      if (!beginAction()) return;
      try {
        const response = await updateClawHubSkill(slug ? { slug } : { all: true });
        if (!response.ok) {
          setError(response.error || 'ClawHub update failed.');
          return;
        }
        const refreshed = await listInstalledClawHubSkills();
        if (refreshed.ok) {
          setInstalled(normalizeInstalledSkills(refreshed.skills));
          notifyChanged();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'ClawHub update failed.');
      } finally {
        endAction();
      }
    },
    [beginAction, endAction, notifyChanged],
  );

  const handleUninstall = useCallback(
    async (slug: string) => {
      if (!beginAction()) return;
      try {
        const response = await uninstallClawHubSkill(slug);
        if (!response.ok) {
          setError(response.error || 'ClawHub uninstall failed.');
          return;
        }
        setInstalled(normalizeInstalledSkills(response.skills));
        notifyChanged();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'ClawHub uninstall failed.');
      } finally {
        endAction();
      }
    },
    [beginAction, endAction, notifyChanged],
  );

  const handleToggleEnabled = useCallback(
    async (slug: string, enabled: boolean) => {
      if (!beginAction()) return;
      try {
        const response = await setClawHubSkillEnabled(slug, enabled);
        if (!response.ok || !response.skill) {
          setError(response.error || 'Failed to update ClawHub skill state.');
          return;
        }
        setInstalled((prev) =>
          prev.map((item) =>
            item.slug === slug ? { ...item, enabled: response.skill!.enabled } : item,
          ),
        );
        notifyChanged();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update ClawHub skill state.');
      } finally {
        endAction();
      }
    },
    [beginAction, endAction, notifyChanged],
  );

  return {
    query,
    setQuery,
    searchResults,
    searchWarnings,
    installed,
    loading,
    error,
    busyRef,
    beginAction,
    endAction,
    refreshInstalled,
    handleSearch,
    handleSearchReset,
    handleInstall,
    handleUpdate,
    handleUninstall,
    handleToggleEnabled,
  };
}
