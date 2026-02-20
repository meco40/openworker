import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Skill } from '@/shared/domain/types';
import { emitClawHubChanged as dispatchClawHubChanged } from '@/skills/clawhub-events';
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
import {
  type SkillRuntimeConfigStatus,
  clearSkillRuntimeConfig,
  listSkillRuntimeConfigs,
  setSkillRuntimeConfig,
} from '@/skills/runtime-config-client';
import { buildSkillConfigHints } from '@/skills/runtime-config-hints';
import { getToolGuide } from '@/skills/tool-guides';

interface SkillsRegistryProps {
  skills: Skill[];
  setSkills: React.Dispatch<React.SetStateAction<Skill[]>>;
}

type InstallTab = 'github' | 'npm' | 'manifest' | 'clawhub';
type RegistryTab = 'skills' | 'tool-configuration';

const SOURCE_LABELS: Record<string, { label: string; color: string }> = {
  'built-in': { label: 'Built-in', color: 'text-zinc-500 bg-zinc-800 border-zinc-700' },
  github: { label: 'GitHub', color: 'text-purple-400 bg-purple-500/10 border-purple-500/20' },
  npm: { label: 'npm', color: 'text-red-400 bg-red-500/10 border-red-500/20' },
  manual: { label: 'Manual', color: 'text-blue-400 bg-blue-500/10 border-blue-500/20' },
};

function normalizeInstalledSkills(skills: ClawHubInstalledSkill[]): ClawHubInstalledSkill[] {
  return skills.map((skill) => ({
    ...skill,
    enabled: Boolean(skill.enabled),
  }));
}

const SkillsRegistry: React.FC<SkillsRegistryProps> = ({ skills, setSkills }) => {
  const [showInstallModal, setShowInstallModal] = useState(false);
  const [installTab, setInstallTab] = useState<InstallTab>('github');
  const [activeRegistryTab, setActiveRegistryTab] = useState<RegistryTab>('skills');
  const [installValue, setInstallValue] = useState('');
  const [installLoading, setInstallLoading] = useState(false);
  const [installError, setInstallError] = useState('');
  const [clawHubQuery, setClawHubQuery] = useState('');
  const [clawHubSearchResults, setClawHubSearchResults] = useState<ClawHubSearchItem[]>([]);
  const [clawHubSearchWarnings, setClawHubSearchWarnings] = useState<string[]>([]);
  const [clawHubInstalled, setClawHubInstalled] = useState<ClawHubInstalledSkill[]>([]);
  const [clawHubLoading, setClawHubLoading] = useState(false);
  const [clawHubError, setClawHubError] = useState('');
  const [runtimeConfigs, setRuntimeConfigs] = useState<SkillRuntimeConfigStatus[]>([]);
  const [runtimeConfigDrafts, setRuntimeConfigDrafts] = useState<Record<string, string>>({});
  const [runtimeConfigLoading, setRuntimeConfigLoading] = useState(false);
  const [runtimeConfigSavingId, setRuntimeConfigSavingId] = useState<string | null>(null);
  const [runtimeConfigError, setRuntimeConfigError] = useState('');
  const [skillActionError, setSkillActionError] = useState('');
  const [toolInfoSkillId, setToolInfoSkillId] = useState<string | null>(null);
  const clawHubBusyRef = useRef(false);

  const notifyClawHubChanged = useCallback(() => {
    dispatchClawHubChanged();
  }, []);

  const beginClawHubAction = useCallback((): boolean => {
    if (clawHubBusyRef.current) {
      return false;
    }
    clawHubBusyRef.current = true;
    setClawHubLoading(true);
    setClawHubError('');
    return true;
  }, []);

  const endClawHubAction = useCallback(() => {
    clawHubBusyRef.current = false;
    setClawHubLoading(false);
  }, []);

  const loadRuntimeConfigs = useCallback(async () => {
    setRuntimeConfigLoading(true);
    setRuntimeConfigError('');
    try {
      const response = await listSkillRuntimeConfigs();
      if (!response.ok || !response.configs) {
        setRuntimeConfigError(response.error || 'Failed to load tool configuration.');
        setRuntimeConfigs([]);
        return;
      }
      setRuntimeConfigs(response.configs);
    } catch (error) {
      setRuntimeConfigError(
        error instanceof Error ? error.message : 'Failed to load tool configuration.',
      );
      setRuntimeConfigs([]);
    } finally {
      setRuntimeConfigLoading(false);
    }
  }, []);

  const getMissingRequiredConfigs = useCallback(
    (skillId: string): SkillRuntimeConfigStatus[] =>
      runtimeConfigs.filter(
        (config) => config.skillId === skillId && config.required && !config.configured,
      ),
    [runtimeConfigs],
  );

  const handleToggleInstall = useCallback(
    async (id: string) => {
      const skill = skills.find((s) => s.id === id);
      if (!skill) return;

      const newInstalled = !skill.installed;
      if (newInstalled) {
        const missingConfigs = getMissingRequiredConfigs(id);
        if (missingConfigs.length > 0) {
          setSkillActionError(
            `Cannot activate "${skill.name}" yet. Missing: ${missingConfigs
              .map((item) => item.label)
              .join(', ')}.`,
          );
          return;
        }
      }

      setSkillActionError('');
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
    [getMissingRequiredConfigs, setSkills, skills],
  );

  const handleInstall = useCallback(async () => {
    setInstallLoading(true);
    setInstallError('');

    try {
      if (installTab === 'clawhub') {
        if (!beginClawHubAction()) {
          return;
        }
        try {
          const response = await installClawHubSkill({ slug: installValue.trim() });
          if (!response.ok) {
            setInstallError(response.error || 'ClawHub install failed.');
            return;
          }
          setShowInstallModal(false);
          setInstallValue('');
          const refreshed = await listInstalledClawHubSkills();
          if (refreshed.ok) {
            setClawHubInstalled(normalizeInstalledSkills(refreshed.skills));
            notifyClawHubChanged();
          }
        } finally {
          endClawHubAction();
        }
        return;
      }

      let body: { source: string; value: unknown };

      if (installTab === 'manifest') {
        body = { source: 'manual', value: JSON.parse(installValue) };
      } else {
        body = { source: installTab, value: installValue.trim() };
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
        setShowInstallModal(false);
        setInstallValue('');
      } else {
        setInstallError(data.error || 'Installation failed.');
      }
    } catch (err) {
      setInstallError(
        err instanceof SyntaxError ? 'Invalid JSON. Please check your manifest.' : String(err),
      );
    } finally {
      setInstallLoading(false);
    }
  }, [
    beginClawHubAction,
    notifyClawHubChanged,
    endClawHubAction,
    installTab,
    installValue,
    setSkills,
  ]);

  const handleRemoveSkill = useCallback(
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

  const handleSyncRefresh = useCallback(async () => {
    if (!beginClawHubAction()) {
      return;
    }
    try {
      const res = await fetch('/api/skills');
      const data = await res.json();
      if (data.ok && Array.isArray(data.skills)) {
        setSkills(
          data.skills.map((s: Record<string, unknown>) => ({
            id: s.id,
            name: s.name,
            description: s.description,
            category: s.category,
            installed: s.installed,
            version: s.version,
            functionName: s.functionName,
            source: s.source,
            sourceUrl: s.sourceUrl ?? undefined,
          })),
        );
      }

      const installed = await listInstalledClawHubSkills();
      if (installed.ok) {
        setClawHubInstalled(normalizeInstalledSkills(installed.skills));
        notifyClawHubChanged();
      }

      await loadRuntimeConfigs();
    } catch {
      // silently fail
    } finally {
      endClawHubAction();
    }
  }, [beginClawHubAction, loadRuntimeConfigs, notifyClawHubChanged, endClawHubAction, setSkills]);

  const handleRuntimeConfigDraft = useCallback((id: string, value: string) => {
    setRuntimeConfigDrafts((previous) => ({
      ...previous,
      [id]: value,
    }));
  }, []);

  const handleRuntimeConfigSave = useCallback(
    async (id: string) => {
      const value = String(runtimeConfigDrafts[id] || '').trim();
      if (!value) {
        setRuntimeConfigError('Please enter a value before saving.');
        return;
      }

      setRuntimeConfigSavingId(id);
      setRuntimeConfigError('');
      try {
        const response = await setSkillRuntimeConfig(id, value);
        if (!response.ok) {
          setRuntimeConfigError(response.error || 'Failed to save tool configuration.');
          return;
        }
        setRuntimeConfigDrafts((previous) => ({
          ...previous,
          [id]: '',
        }));
        await loadRuntimeConfigs();
      } catch (error) {
        setRuntimeConfigError(
          error instanceof Error ? error.message : 'Failed to save tool configuration.',
        );
      } finally {
        setRuntimeConfigSavingId(null);
      }
    },
    [loadRuntimeConfigs, runtimeConfigDrafts],
  );

  const handleRuntimeConfigClear = useCallback(
    async (id: string) => {
      setRuntimeConfigSavingId(id);
      setRuntimeConfigError('');
      try {
        const response = await clearSkillRuntimeConfig(id);
        if (!response.ok) {
          setRuntimeConfigError(response.error || 'Failed to clear tool configuration.');
          return;
        }
        setRuntimeConfigDrafts((previous) => ({
          ...previous,
          [id]: '',
        }));
        await loadRuntimeConfigs();
      } catch (error) {
        setRuntimeConfigError(
          error instanceof Error ? error.message : 'Failed to clear tool configuration.',
        );
      } finally {
        setRuntimeConfigSavingId(null);
      }
    },
    [loadRuntimeConfigs],
  );

  const refreshClawHubInstalled = useCallback(async () => {
    if (!beginClawHubAction()) {
      return;
    }
    try {
      const data = await listInstalledClawHubSkills();
      if (!data.ok) {
        setClawHubError(data.error || 'Failed to load installed ClawHub skills.');
        return;
      }
      setClawHubInstalled(normalizeInstalledSkills(data.skills));
      notifyClawHubChanged();
    } catch (error) {
      setClawHubError(error instanceof Error ? error.message : 'Failed to load ClawHub skills.');
    } finally {
      endClawHubAction();
    }
  }, [beginClawHubAction, notifyClawHubChanged, endClawHubAction]);

  const handleClawHubSearch = useCallback(async () => {
    const query = clawHubQuery.trim();
    if (!query) {
      setClawHubError('');
      setClawHubSearchResults([]);
      setClawHubSearchWarnings([]);
      return;
    }

    if (!beginClawHubAction()) {
      return;
    }
    try {
      const data = await searchClawHubSkills(query, 25);
      if (!data.ok) {
        setClawHubError(data.error || 'ClawHub search failed.');
        setClawHubSearchResults([]);
        setClawHubSearchWarnings([]);
        return;
      }
      setClawHubSearchResults(data.items || []);
      setClawHubSearchWarnings(data.parseWarnings || []);
    } catch (error) {
      setClawHubError(error instanceof Error ? error.message : 'ClawHub search failed.');
      setClawHubSearchResults([]);
      setClawHubSearchWarnings([]);
    } finally {
      endClawHubAction();
    }
  }, [beginClawHubAction, clawHubQuery, endClawHubAction]);

  const handleClawHubSearchReset = useCallback(() => {
    setClawHubQuery('');
    setClawHubSearchResults([]);
    setClawHubSearchWarnings([]);
    setClawHubError('');
  }, []);

  const handleClawHubInstall = useCallback(
    async (slug: string) => {
      if (!beginClawHubAction()) {
        return;
      }
      try {
        const response = await installClawHubSkill({ slug });
        if (!response.ok) {
          setClawHubError(response.error || 'ClawHub install failed.');
          return;
        }
        const refreshed = await listInstalledClawHubSkills();
        if (refreshed.ok) {
          setClawHubInstalled(normalizeInstalledSkills(refreshed.skills));
          notifyClawHubChanged();
        }
      } catch (error) {
        setClawHubError(error instanceof Error ? error.message : 'ClawHub install failed.');
      } finally {
        endClawHubAction();
      }
    },
    [beginClawHubAction, notifyClawHubChanged, endClawHubAction],
  );

  const handleClawHubUpdate = useCallback(
    async (slug?: string) => {
      if (!beginClawHubAction()) {
        return;
      }
      try {
        const response = await updateClawHubSkill(slug ? { slug } : { all: true });
        if (!response.ok) {
          setClawHubError(response.error || 'ClawHub update failed.');
          return;
        }
        const refreshed = await listInstalledClawHubSkills();
        if (refreshed.ok) {
          setClawHubInstalled(normalizeInstalledSkills(refreshed.skills));
          notifyClawHubChanged();
        }
      } catch (error) {
        setClawHubError(error instanceof Error ? error.message : 'ClawHub update failed.');
      } finally {
        endClawHubAction();
      }
    },
    [beginClawHubAction, notifyClawHubChanged, endClawHubAction],
  );

  const handleClawHubUninstall = useCallback(
    async (slug: string) => {
      if (!beginClawHubAction()) {
        return;
      }
      try {
        const response = await uninstallClawHubSkill(slug);
        if (!response.ok) {
          setClawHubError(response.error || 'ClawHub uninstall failed.');
          return;
        }
        setClawHubInstalled(normalizeInstalledSkills(response.skills));
        notifyClawHubChanged();
      } catch (error) {
        setClawHubError(error instanceof Error ? error.message : 'ClawHub uninstall failed.');
      } finally {
        endClawHubAction();
      }
    },
    [beginClawHubAction, notifyClawHubChanged, endClawHubAction],
  );

  const handleClawHubToggleEnabled = useCallback(
    async (slug: string, enabled: boolean) => {
      if (!beginClawHubAction()) {
        return;
      }
      try {
        const response = await setClawHubSkillEnabled(slug, enabled);
        if (!response.ok || !response.skill) {
          setClawHubError(response.error || 'Failed to update ClawHub skill state.');
          return;
        }
        setClawHubInstalled((previous) =>
          previous.map((item) =>
            item.slug === slug ? { ...item, enabled: response.skill!.enabled } : item,
          ),
        );
        notifyClawHubChanged();
      } catch (error) {
        setClawHubError(
          error instanceof Error ? error.message : 'Failed to update ClawHub skill state.',
        );
      } finally {
        endClawHubAction();
      }
    },
    [beginClawHubAction, notifyClawHubChanged, endClawHubAction],
  );

  useEffect(() => {
    void refreshClawHubInstalled();
  }, [refreshClawHubInstalled]);

  useEffect(() => {
    void loadRuntimeConfigs();
  }, [loadRuntimeConfigs]);

  const toolInfoSkill = toolInfoSkillId
    ? skills.find((skill) => skill.id === toolInfoSkillId) || null
    : null;
  const toolGuide = toolInfoSkill ? getToolGuide(toolInfoSkill, runtimeConfigs) : null;

  return (
    <div className="animate-in fade-in mx-auto max-w-6xl space-y-10 pb-20 duration-500">
      {/* Header */}
      <header className="group relative flex items-center justify-between overflow-hidden rounded-[2.5rem] border border-zinc-800 bg-zinc-900/40 p-10 shadow-2xl">
        <div className="absolute top-0 right-0 -mt-40 -mr-40 h-80 w-80 rounded-full bg-indigo-600/10 blur-[100px]" />
        <div className="relative z-10">
          <h2 className="text-3xl font-black tracking-tight text-white uppercase">
            Skill Registry
          </h2>
          <p className="mt-2 max-w-md text-sm text-zinc-500">
            Extend agent capabilities. Installed skills become active tools in the KI context.
          </p>
        </div>
        <div className="relative z-10 flex gap-3">
          <button
            onClick={handleSyncRefresh}
            disabled={clawHubLoading || installLoading}
            className="rounded-2xl border border-zinc-700 bg-zinc-800 px-6 py-4 text-[10px] font-black tracking-widest text-white uppercase transition-all hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            ↻ Sync
          </button>
          <button
            onClick={() => setShowInstallModal(true)}
            className="rounded-2xl border border-indigo-500 bg-indigo-600 px-6 py-4 text-[10px] font-black tracking-widest text-white uppercase shadow-lg shadow-indigo-500/20 transition-all hover:bg-indigo-500"
          >
            + Install Skill
          </button>
        </div>
      </header>

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-[2rem] border border-zinc-800 bg-zinc-900/60 p-6 shadow-lg">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h3 className="text-sm font-black tracking-widest text-white uppercase">
              ClawHub Search
            </h3>
            <button
              onClick={handleClawHubSearch}
              disabled={clawHubLoading || !clawHubQuery.trim()}
              className="rounded-xl bg-indigo-600 px-4 py-2 text-[10px] font-black tracking-widest uppercase hover:bg-indigo-500 disabled:opacity-50"
            >
              Search
            </button>
          </div>
          <div className="relative mb-4">
            <input
              value={clawHubQuery}
              onChange={(event) => setClawHubQuery(event.target.value)}
              placeholder="Search ClawHub skills..."
              className="w-full rounded-xl border border-zinc-700 bg-zinc-800 p-3 pr-10 font-mono text-xs text-zinc-300 focus:border-indigo-500 focus:outline-none"
            />
            <button
              type="button"
              aria-label="Clear ClawHub search"
              onClick={handleClawHubSearchReset}
              disabled={!clawHubQuery.trim()}
              className="absolute top-1/2 right-2 h-6 w-6 -translate-y-1/2 rounded-lg border border-zinc-700 bg-zinc-900 text-xs font-black text-zinc-400 uppercase hover:border-zinc-500 hover:text-white disabled:opacity-40 disabled:hover:border-zinc-700 disabled:hover:text-zinc-400"
            >
              x
            </button>
          </div>

          <div className="max-h-60 space-y-2 overflow-auto pr-1">
            {clawHubSearchResults.map((item) => (
              <div
                key={`${item.slug}:${item.version}`}
                className="flex items-center justify-between gap-3 rounded-xl border border-zinc-700 bg-zinc-800/60 px-3 py-2"
              >
                <div>
                  <p className="text-xs font-semibold text-white">{item.title}</p>
                  <p className="font-mono text-[10px] text-zinc-500">
                    {item.slug} · v{item.version}
                  </p>
                </div>
                <button
                  onClick={() => void handleClawHubInstall(item.slug)}
                  disabled={clawHubLoading}
                  className="text-[10px] font-black tracking-widest text-indigo-400 uppercase hover:text-indigo-300 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Install
                </button>
              </div>
            ))}
          </div>
          {clawHubSearchWarnings.length > 0 && (
            <p className="mt-3 text-[10px] text-amber-400">
              Parser warnings: {clawHubSearchWarnings.length}
            </p>
          )}
        </div>

        <div className="rounded-[2rem] border border-zinc-800 bg-zinc-900/60 p-6 shadow-lg">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h3 className="text-sm font-black tracking-widest text-white uppercase">
              ClawHub Installed
            </h3>
            <div className="flex items-center gap-2">
              <button
                onClick={() => void refreshClawHubInstalled()}
                disabled={clawHubLoading}
                className="rounded-xl border border-zinc-700 bg-zinc-800 px-3 py-2 text-[10px] font-black tracking-widest uppercase hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Refresh
              </button>
              <button
                onClick={() => void handleClawHubUpdate()}
                disabled={clawHubLoading}
                className="rounded-xl bg-emerald-600/80 px-3 py-2 text-[10px] font-black tracking-widest uppercase hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Update All
              </button>
            </div>
          </div>

          <div className="max-h-60 space-y-2 overflow-auto pr-1">
            {clawHubInstalled.map((item) => (
              <div
                key={`${item.slug}:${item.version}`}
                className="flex items-center justify-between gap-3 rounded-xl border border-zinc-700 bg-zinc-800/60 px-3 py-2"
              >
                <div>
                  <p className="text-xs font-semibold text-white">{item.title || item.slug}</p>
                  <p className="mb-1 font-mono text-[10px] text-zinc-500">
                    {item.slug} · v{item.version}
                  </p>
                  <span
                    className={`inline-flex items-center rounded border px-2 py-0.5 text-[9px] font-black uppercase ${
                      item.enabled
                        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                        : 'border-zinc-600 bg-zinc-700/30 text-zinc-400'
                    }`}
                  >
                    {item.enabled ? 'Enabled in Prompt' : 'Disabled'}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => void handleClawHubToggleEnabled(item.slug, !item.enabled)}
                    disabled={clawHubLoading}
                    className={`text-[10px] font-black tracking-widest uppercase ${
                      item.enabled
                        ? 'text-amber-400 hover:text-amber-300'
                        : 'text-indigo-400 hover:text-indigo-300'
                    } disabled:cursor-not-allowed disabled:opacity-50`}
                  >
                    {item.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    onClick={() => void handleClawHubUpdate(item.slug)}
                    disabled={clawHubLoading}
                    className="text-[10px] font-black tracking-widest text-emerald-400 uppercase hover:text-emerald-300 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Update
                  </button>
                  <button
                    onClick={() => void handleClawHubUninstall(item.slug)}
                    disabled={clawHubLoading}
                    className="text-[10px] font-black tracking-widest text-rose-400 uppercase hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Uninstall
                  </button>
                </div>
              </div>
            ))}
          </div>

          <p className="mt-3 text-[10px] text-zinc-500">
            ClawHub skills are managed as instruction skills (`SKILL.md`) and do not replace
            executable tool skills.
          </p>
        </div>
      </section>

      <section className="rounded-[2rem] border border-zinc-800 bg-zinc-900/60 p-4 shadow-lg">
        <div className="flex flex-wrap gap-2">
          {(
            [
              ['skills', 'Skills'],
              ['tool-configuration', 'Tool Configuration'],
            ] as [RegistryTab, string][]
          ).map(([tabId, label]) => (
            <button
              key={tabId}
              type="button"
              onClick={() => setActiveRegistryTab(tabId)}
              className={`rounded-xl border px-4 py-2 text-[10px] font-black tracking-widest uppercase transition-all ${
                activeRegistryTab === tabId
                  ? 'border-indigo-500 bg-indigo-600 text-white shadow-lg shadow-indigo-500/20'
                  : 'border-zinc-700 bg-zinc-800 text-zinc-300 hover:border-zinc-500 hover:bg-zinc-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      {activeRegistryTab === 'tool-configuration' && (
        <section className="rounded-[2rem] border border-zinc-800 bg-zinc-900/60 p-6 shadow-lg">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h3 className="text-sm font-black tracking-widest text-white uppercase">
              Tool Configuration
            </h3>
            <button
              onClick={() => void loadRuntimeConfigs()}
              disabled={runtimeConfigLoading}
              className="rounded-xl border border-zinc-700 bg-zinc-800 px-3 py-2 text-[10px] font-black tracking-widest uppercase hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Refresh
            </button>
          </div>
          <p className="mb-4 text-xs text-zinc-500">
            Configure required credentials once. Skills can only be activated when required fields
            are configured.
          </p>

          <div className="space-y-3">
            {runtimeConfigs.map((config) => (
              <div
                key={config.id}
                className="flex flex-col gap-4 rounded-2xl border border-zinc-700 bg-zinc-800/60 p-4 lg:flex-row lg:items-center lg:justify-between"
              >
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-white">
                    {config.label}
                    {config.required ? (
                      <span className="ml-1 text-rose-400" title="Required">
                        *
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-1 text-[10px] text-zinc-500">{config.description}</p>
                  <p className="mt-1 font-mono text-[10px] text-zinc-600">
                    Env fallback: {config.envVars.join(' / ')}
                  </p>
                </div>

                <div className="flex-1 lg:max-w-xl">
                  <div className="mb-2 flex items-center gap-2">
                    <span
                      className={`rounded border px-2 py-0.5 text-[9px] font-black uppercase ${
                        config.configured
                          ? config.source === 'store'
                            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                            : 'border-amber-500/30 bg-amber-500/10 text-amber-400'
                          : 'border-zinc-600 bg-zinc-700/30 text-zinc-400'
                      }`}
                    >
                      {config.configured
                        ? config.source === 'store'
                          ? 'Saved'
                          : 'Env Fallback'
                        : 'Missing'}
                    </span>
                    {config.maskedValue && (
                      <span className="truncate font-mono text-[10px] text-zinc-500">
                        {config.maskedValue}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <input
                      type={config.kind === 'secret' ? 'password' : 'text'}
                      value={runtimeConfigDrafts[config.id] || ''}
                      onChange={(event) => handleRuntimeConfigDraft(config.id, event.target.value)}
                      placeholder={
                        config.kind === 'secret'
                          ? `Enter ${config.label}`
                          : 'Enter value (workspace-relative path)'
                      }
                      className="w-full rounded-xl border border-zinc-700 bg-zinc-900 p-2.5 font-mono text-xs text-zinc-300 focus:border-indigo-500 focus:outline-none"
                    />
                    <button
                      onClick={() => void handleRuntimeConfigSave(config.id)}
                      disabled={
                        runtimeConfigSavingId === config.id ||
                        !String(runtimeConfigDrafts[config.id] || '').trim()
                      }
                      className="rounded-xl bg-indigo-600 px-3 py-2 text-[10px] font-black tracking-widest uppercase hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => void handleRuntimeConfigClear(config.id)}
                      disabled={runtimeConfigSavingId === config.id || !config.configured}
                      className="rounded-xl border border-zinc-700 bg-zinc-800 px-3 py-2 text-[10px] font-black tracking-widest uppercase hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Clear
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {clawHubError && (
        <p className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-400">
          {clawHubError}
        </p>
      )}

      {runtimeConfigError && (
        <p className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-400">
          {runtimeConfigError}
        </p>
      )}

      {skillActionError && (
        <p className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-300">
          {skillActionError}
        </p>
      )}

      {activeRegistryTab === 'skills' && (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {skills.map((skill) => {
            const sourceMeta = SOURCE_LABELS[skill.source] ?? SOURCE_LABELS['built-in'];
            const requiredConfigs = runtimeConfigs.filter(
              (config) => config.skillId === skill.id && config.required,
            );
            const missingRequiredConfigs = requiredConfigs.filter((config) => !config.configured);
            const setupRequired = missingRequiredConfigs.length > 0;
            const hints = buildSkillConfigHints(skill.id, runtimeConfigs);
            return (
              <div
                key={skill.id}
                className="group relative flex h-[300px] flex-col overflow-hidden rounded-[2rem] border border-zinc-800 bg-zinc-900/60 p-6 shadow-lg transition-all hover:border-indigo-500/50"
              >
                <div className="mb-3 flex items-center justify-between">
                  <span
                    className={`rounded border px-2 py-0.5 text-[8px] font-black uppercase ${
                      skill.installed
                        ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-500'
                        : setupRequired
                          ? 'border-amber-500/30 bg-amber-500/10 text-amber-400'
                          : 'border-zinc-700 bg-zinc-800 text-zinc-500'
                    }`}
                  >
                    {skill.installed
                      ? 'Runtime: Active'
                      : setupRequired
                        ? 'Setup Required'
                        : 'Available'}
                  </span>
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded border px-2 py-0.5 text-[8px] font-black uppercase ${sourceMeta.color}`}
                    >
                      {sourceMeta.label}
                    </span>
                    <span className="font-mono text-[9px] text-zinc-600">v{skill.version}</span>
                  </div>
                </div>

                <div className="mb-2 flex items-start gap-2">
                  <h3 className="text-lg leading-tight font-bold text-white transition-colors group-hover:text-indigo-400">
                    {skill.name}
                  </h3>
                  <button
                    type="button"
                    aria-label={`Open info for ${skill.name}`}
                    onClick={() => setToolInfoSkillId(skill.id)}
                    className="mt-0.5 h-5 w-5 shrink-0 rounded-full border border-zinc-700 text-[10px] font-black text-zinc-300 transition-colors hover:border-zinc-500 hover:text-white"
                    title={`Info: ${skill.name}`}
                  >
                    i
                  </button>
                </div>
                <p className="mb-4 line-clamp-3 flex-1 text-xs text-zinc-500">
                  {skill.description}
                </p>
                {hints.requiredHint && (
                  <p className="mb-1 line-clamp-2 text-[10px] text-amber-300">
                    {hints.requiredHint}
                  </p>
                )}
                {hints.optionalHint && (
                  <p className="mb-2 line-clamp-2 text-[10px] text-zinc-400">
                    {hints.optionalHint}
                  </p>
                )}

                {skill.sourceUrl && (
                  <p className="mb-3 truncate font-mono text-[9px] text-zinc-600">
                    {skill.sourceUrl}
                  </p>
                )}

                {setupRequired && (
                  <p className="mb-3 line-clamp-2 text-[10px] text-amber-400">
                    Missing: {missingRequiredConfigs.map((config) => config.label).join(', ')}
                  </p>
                )}

                <div className="mt-auto flex items-center justify-between border-t border-zinc-800/50 pt-4">
                  <span className="text-[10px] font-black tracking-tighter text-zinc-600 uppercase">
                    {skill.category}
                  </span>
                  <div className="flex items-center gap-3">
                    {skill.source !== 'built-in' && (
                      <button
                        onClick={() => handleRemoveSkill(skill.id)}
                        className="text-[10px] font-black tracking-widest text-zinc-600 uppercase transition-colors hover:text-red-400"
                      >
                        Remove
                      </button>
                    )}
                    <button
                      onClick={() => handleToggleInstall(skill.id)}
                      disabled={!skill.installed && setupRequired}
                      className={`text-[10px] font-black tracking-widest uppercase transition-all ${
                        skill.installed
                          ? 'text-rose-500 hover:text-rose-400'
                          : 'text-indigo-500 hover:text-indigo-400'
                      } disabled:cursor-not-allowed disabled:text-zinc-500`}
                    >
                      {skill.installed ? 'Deactivate' : 'Activate'}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Tool Info Modal */}
      {toolGuide && toolInfoSkill && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setToolInfoSkillId(null)}
        >
          <div
            className="max-h-[85vh] w-full max-w-2xl overflow-auto rounded-3xl border border-zinc-700 bg-zinc-900 p-8 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-6 flex items-center justify-between">
              <div>
                <h3 className="text-xl font-black tracking-tight text-white uppercase">
                  {toolGuide.title}
                </h3>
                <p className="mt-1 font-mono text-[11px] text-zinc-500">
                  Function: {toolInfoSkill.functionName}
                </p>
              </div>
              <button
                onClick={() => setToolInfoSkillId(null)}
                className="text-xl text-zinc-500 hover:text-white"
                aria-label="Close tool info"
              >
                ✕
              </button>
            </div>

            <section className="mb-5">
              <h4 className="mb-2 text-[11px] font-black tracking-widest text-zinc-300 uppercase">
                What It Is
              </h4>
              <p className="text-sm leading-relaxed text-zinc-400">{toolGuide.whatItIs}</p>
            </section>

            <section className="mb-5">
              <h4 className="mb-2 text-[11px] font-black tracking-widest text-zinc-300 uppercase">
                What It Can Do
              </h4>
              <ul className="list-disc space-y-1 pl-5">
                {toolGuide.whatItCanDo.map((item) => (
                  <li key={item} className="text-sm text-zinc-400">
                    {item}
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <h4 className="mb-2 text-[11px] font-black tracking-widest text-zinc-300 uppercase">
                How To Use
              </h4>
              <ul className="list-disc space-y-1 pl-5">
                {toolGuide.howToUse.map((item) => (
                  <li key={item} className="text-sm text-zinc-400">
                    {item}
                  </li>
                ))}
              </ul>
            </section>

            <div className="mt-8 flex justify-end">
              <button
                onClick={() => setToolInfoSkillId(null)}
                className="rounded-xl bg-zinc-800 px-5 py-2.5 text-xs font-bold text-zinc-300 uppercase transition-all hover:bg-zinc-700"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Install Modal */}
      {showInstallModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-xl rounded-3xl border border-zinc-700 bg-zinc-900 p-8 shadow-2xl">
            <div className="mb-6 flex items-center justify-between">
              <h3 className="text-xl font-black tracking-tight text-white uppercase">
                Install Skill
              </h3>
              <button
                onClick={() => {
                  setShowInstallModal(false);
                  setInstallError('');
                }}
                className="text-xl text-zinc-500 hover:text-white"
              >
                ✕
              </button>
            </div>

            {/* Tabs */}
            <div className="mb-6 flex gap-2">
              {(
                [
                  ['github', 'GitHub URL'],
                  ['npm', 'npm Package'],
                  ['manifest', 'Paste Manifest'],
                  ['clawhub', 'ClawHub'],
                ] as [InstallTab, string][]
              ).map(([tab, label]) => (
                <button
                  key={tab}
                  onClick={() => {
                    setInstallTab(tab);
                    setInstallError('');
                  }}
                  className={`rounded-xl px-4 py-2 text-xs font-bold tracking-wider uppercase transition-all ${
                    installTab === tab
                      ? 'bg-indigo-600 text-white'
                      : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Input */}
            {installTab === 'manifest' ? (
              <textarea
                value={installValue}
                onChange={(e) => setInstallValue(e.target.value)}
                placeholder={'{\n  "id": "my-skill",\n  "name": "My Skill",\n  ...skill.json\n}'}
                className="h-40 w-full resize-none rounded-xl border border-zinc-700 bg-zinc-800 p-4 font-mono text-xs text-zinc-300 focus:border-indigo-500 focus:outline-none"
              />
            ) : (
              <input
                value={installValue}
                onChange={(e) => setInstallValue(e.target.value)}
                placeholder={
                  installTab === 'github'
                    ? 'https://github.com/user/skill-repo'
                    : installTab === 'npm'
                      ? '@openclaw/skill-weather'
                      : 'calendar'
                }
                className="w-full rounded-xl border border-zinc-700 bg-zinc-800 p-4 font-mono text-sm text-zinc-300 focus:border-indigo-500 focus:outline-none"
              />
            )}

            {/* Security notice */}
            <p className="mt-3 text-[10px] text-amber-500/70">
              ⚠ External skills can affect runtime behavior. Only install from trusted sources.
            </p>

            {installError && (
              <p className="mt-3 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-400">
                {installError}
              </p>
            )}

            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => {
                  setShowInstallModal(false);
                  setInstallError('');
                }}
                className="rounded-xl bg-zinc-800 px-6 py-3 text-xs font-bold text-zinc-400 uppercase transition-all hover:bg-zinc-700"
              >
                Cancel
              </button>
              <button
                onClick={handleInstall}
                disabled={installLoading || !installValue.trim()}
                className="rounded-xl bg-indigo-600 px-6 py-3 text-xs font-bold text-white uppercase shadow-lg shadow-indigo-500/20 transition-all hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {installLoading ? 'Installing…' : 'Install'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SkillsRegistry;
