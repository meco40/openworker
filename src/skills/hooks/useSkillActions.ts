'use client';

import { useState, useCallback } from 'react';
import type { Skill } from '@/shared/domain/types';
import { installClawHubSkill, listInstalledClawHubSkills } from '@/skills/clawhub-client';
import { emitClawHubChanged } from '@/skills/clawhub-events';
import type { InstallTab } from '@/skills/components/registry/types';

export function useSkillActions(
  skills: Skill[],
  setSkills: React.Dispatch<React.SetStateAction<Skill[]>>,
  getMissingRequiredConfigs: (
    skillId: string,
  ) => import('@/skills/runtime-config-client').SkillRuntimeConfigStatus[],
): import('@/skills/components/registry/types').UseSkillActionsReturn {
  const [actionError, setActionError] = useState('');

  const handleToggleInstall = useCallback(
    async (id: string) => {
      const skill = skills.find((s) => s.id === id);
      if (!skill) return;

      const newInstalled = !skill.installed;
      if (newInstalled) {
        const missingConfigs = getMissingRequiredConfigs(id);
        if (missingConfigs.length > 0) {
          setActionError(
            `Cannot activate "${skill.name}" yet. Missing: ${missingConfigs
              .map((item) => item.label)
              .join(', ')}.`,
          );
          return;
        }
      }

      setActionError('');
      // Optimistic update
      setSkills((prev) => prev.map((s) => (s.id === id ? { ...s, installed: newInstalled } : s)));

      try {
        const res = await fetch(`/api/skills/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ installed: newInstalled }),
        });
        const data = await res.json();
        if (!data.ok) {
          // Revert on failure
          setSkills((prev) =>
            prev.map((s) => (s.id === id ? { ...s, installed: !newInstalled } : s)),
          );
        }
      } catch {
        // Revert on error
        setSkills((prev) =>
          prev.map((s) => (s.id === id ? { ...s, installed: !newInstalled } : s)),
        );
      }
    },
    [skills, setSkills, getMissingRequiredConfigs],
  );

  const handleRemove = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/skills/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.ok) {
          setSkills((prev) => prev.filter((s) => s.id !== id));
        }
      } catch {
        // silently fail
      }
    },
    [setSkills],
  );

  const handleSyncRefresh = useCallback(
    async (
      beginClawHubAction: () => boolean,
      endClawHubAction: () => void,
      loadRuntimeConfigs: () => Promise<void>,
    ) => {
      if (!beginClawHubAction()) return;
      try {
        const res = await fetch('/api/skills');
        const data = await res.json();
        if (data.ok && Array.isArray(data.skills)) {
          setSkills(
            data.skills.map((s: Record<string, unknown>) => ({
              id: s.id as string,
              name: s.name as string,
              description: s.description as string,
              category: s.category as string,
              installed: s.installed as boolean,
              version: s.version as string,
              functionName: s.functionName as string,
              source: s.source as string,
              sourceUrl: s.sourceUrl as string | undefined,
            })),
          );
        }

        const installed = await listInstalledClawHubSkills();
        if (installed.ok) {
          emitClawHubChanged();
        }

        await loadRuntimeConfigs();
      } catch {
        // silently fail
      } finally {
        endClawHubAction();
      }
    },
    [setSkills],
  );

  const handleInstall = useCallback(
    async (params: {
      tab: InstallTab;
      value: string;
      beginClawHubAction: () => boolean;
      endClawHubAction: () => void;
      refreshClawHubInstalled: () => Promise<void>;
      setShowModal: (show: boolean) => void;
      setInstallValue: (value: string) => void;
    }) => {
      const {
        tab,
        value,
        beginClawHubAction,
        endClawHubAction,
        refreshClawHubInstalled,
        setShowModal,
        setInstallValue,
      } = params;

      if (tab === 'clawhub') {
        if (!beginClawHubAction()) return;
        try {
          const response = await installClawHubSkill({ slug: value.trim() });
          if (!response.ok) {
            throw new Error(response.error || 'ClawHub install failed.');
          }
          setShowModal(false);
          setInstallValue('');
          await refreshClawHubInstalled();
        } finally {
          endClawHubAction();
        }
        return;
      }

      let body: { source: string; value: unknown };

      if (tab === 'manifest') {
        body = { source: 'manual', value: JSON.parse(value) };
      } else {
        body = { source: tab, value: value.trim() };
      }

      const res = await fetch('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      if (data.ok && data.skill) {
        const s = data.skill;
        setSkills((prev) => [
          ...prev,
          {
            id: s.id,
            name: s.name,
            description: s.description,
            category: s.category,
            installed: s.installed,
            version: s.version,
            functionName: s.functionName,
            source: s.source,
            sourceUrl: s.sourceUrl ?? undefined,
          },
        ]);
        setShowModal(false);
        setInstallValue('');
      } else {
        throw new Error(data.error || 'Installation failed.');
      }
    },
    [setSkills],
  );

  return {
    actionError,
    setActionError,
    handleToggleInstall,
    handleRemove,
    handleSyncRefresh,
    handleInstall,
  };
}
