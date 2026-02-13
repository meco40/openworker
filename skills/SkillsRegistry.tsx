import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Skill } from '../types';
import { emitClawHubChanged as dispatchClawHubChanged } from './clawhub-events';
import {
  type ClawHubInstalledSkill,
  type ClawHubSearchItem,
  installClawHubSkill,
  listInstalledClawHubSkills,
  searchClawHubSkills,
  setClawHubSkillEnabled,
  uninstallClawHubSkill,
  updateClawHubSkill,
} from './clawhub-client';
import {
  type SkillRuntimeConfigStatus,
  clearSkillRuntimeConfig,
  listSkillRuntimeConfigs,
  setSkillRuntimeConfig,
} from './runtime-config-client';
import { buildSkillConfigHints } from './runtime-config-hints';
import { getToolGuide } from './tool-guides';

interface SkillsRegistryProps {
  skills: Skill[];
  setSkills: React.Dispatch<React.SetStateAction<Skill[]>>;
}

type InstallTab = 'github' | 'npm' | 'manifest' | 'clawhub';

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
      runtimeConfigs.filter((config) => config.skillId === skillId && config.required && !config.configured),
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
      setSkills((prev) =>
        prev.map((s) => (s.id === id ? { ...s, installed: newInstalled } : s)),
      );

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
        err instanceof SyntaxError
          ? 'Invalid JSON. Please check your manifest.'
          : String(err),
      );
    } finally {
      setInstallLoading(false);
    }
  }, [beginClawHubAction, notifyClawHubChanged, endClawHubAction, installTab, installValue, setSkills]);

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

  const handleClawHubUninstall = useCallback(async (slug: string) => {
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
  }, [beginClawHubAction, notifyClawHubChanged, endClawHubAction]);

  const handleClawHubToggleEnabled = useCallback(async (slug: string, enabled: boolean) => {
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
      setClawHubError(error instanceof Error ? error.message : 'Failed to update ClawHub skill state.');
    } finally {
      endClawHubAction();
    }
  }, [beginClawHubAction, notifyClawHubChanged, endClawHubAction]);

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
    <div className="space-y-10 animate-in fade-in duration-500 pb-20 max-w-6xl mx-auto">
      {/* Header */}
      <header className="flex items-center justify-between bg-zinc-900/40 p-10 rounded-[2.5rem] border border-zinc-800 shadow-2xl relative overflow-hidden group">
        <div className="absolute top-0 right-0 w-80 h-80 bg-indigo-600/10 rounded-full blur-[100px] -mr-40 -mt-40" />
        <div className="relative z-10">
          <h2 className="text-3xl font-black text-white tracking-tight uppercase">Skill Registry</h2>
          <p className="text-sm text-zinc-500 mt-2 max-w-md">
            Extend agent capabilities. Installed skills become active tools in the KI context.
          </p>
        </div>
        <div className="relative z-10 flex gap-3">
          <button
            onClick={handleSyncRefresh}
            disabled={clawHubLoading || installLoading}
            className="px-6 py-4 bg-zinc-800 hover:bg-zinc-700 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all border border-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            ↻ Sync
          </button>
          <button
            onClick={() => setShowInstallModal(true)}
            className="px-6 py-4 bg-indigo-600 hover:bg-indigo-500 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all border border-indigo-500 shadow-lg shadow-indigo-500/20"
          >
            + Install Skill
          </button>
        </div>
      </header>

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-[2rem] p-6 shadow-lg">
          <div className="flex items-center justify-between gap-3 mb-4">
            <h3 className="text-sm font-black uppercase tracking-widest text-white">
              ClawHub Search
            </h3>
            <button
              onClick={handleClawHubSearch}
              disabled={clawHubLoading || !clawHubQuery.trim()}
              className="px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50"
            >
              Search
            </button>
          </div>
          <div className="relative mb-4">
            <input
              value={clawHubQuery}
              onChange={(event) => setClawHubQuery(event.target.value)}
              placeholder="Search ClawHub skills..."
              className="w-full p-3 pr-10 bg-zinc-800 text-zinc-300 rounded-xl font-mono text-xs border border-zinc-700 focus:border-indigo-500 focus:outline-none"
            />
            <button
              type="button"
              aria-label="Clear ClawHub search"
              onClick={handleClawHubSearchReset}
              disabled={!clawHubQuery.trim()}
              className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-400 text-xs font-black uppercase hover:text-white hover:border-zinc-500 disabled:opacity-40 disabled:hover:text-zinc-400 disabled:hover:border-zinc-700"
            >
              x
            </button>
          </div>

          <div className="space-y-2 max-h-60 overflow-auto pr-1">
            {clawHubSearchResults.map((item) => (
              <div
                key={`${item.slug}:${item.version}`}
                className="flex items-center justify-between gap-3 bg-zinc-800/60 border border-zinc-700 rounded-xl px-3 py-2"
              >
                <div>
                  <p className="text-xs text-white font-semibold">{item.title}</p>
                  <p className="text-[10px] text-zinc-500 font-mono">
                    {item.slug} · v{item.version}
                  </p>
                </div>
                <button
                  onClick={() => void handleClawHubInstall(item.slug)}
                  disabled={clawHubLoading}
                  className="text-[10px] font-black uppercase tracking-widest text-indigo-400 hover:text-indigo-300 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Install
                </button>
              </div>
            ))}
          </div>
          {clawHubSearchWarnings.length > 0 && (
            <p className="text-[10px] text-amber-400 mt-3">
              Parser warnings: {clawHubSearchWarnings.length}
            </p>
          )}
        </div>

        <div className="bg-zinc-900/60 border border-zinc-800 rounded-[2rem] p-6 shadow-lg">
          <div className="flex items-center justify-between gap-3 mb-4">
            <h3 className="text-sm font-black uppercase tracking-widest text-white">
              ClawHub Installed
            </h3>
            <div className="flex items-center gap-2">
              <button
                onClick={() => void refreshClawHubInstalled()}
                disabled={clawHubLoading}
                className="px-3 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Refresh
              </button>
              <button
                onClick={() => void handleClawHubUpdate()}
                disabled={clawHubLoading}
                className="px-3 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest bg-emerald-600/80 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Update All
              </button>
            </div>
          </div>

          <div className="space-y-2 max-h-60 overflow-auto pr-1">
            {clawHubInstalled.map((item) => (
              <div
                key={`${item.slug}:${item.version}`}
                className="flex items-center justify-between gap-3 bg-zinc-800/60 border border-zinc-700 rounded-xl px-3 py-2"
              >
                <div>
                  <p className="text-xs text-white font-semibold">{item.title || item.slug}</p>
                  <p className="text-[10px] text-zinc-500 font-mono mb-1">
                    {item.slug} · v{item.version}
                  </p>
                  <span
                    className={`inline-flex items-center text-[9px] font-black uppercase px-2 py-0.5 rounded border ${
                      item.enabled
                        ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30'
                        : 'text-zinc-400 bg-zinc-700/30 border-zinc-600'
                    }`}
                  >
                    {item.enabled ? 'Enabled in Prompt' : 'Disabled'}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => void handleClawHubToggleEnabled(item.slug, !item.enabled)}
                    disabled={clawHubLoading}
                    className={`text-[10px] font-black uppercase tracking-widest ${
                      item.enabled
                        ? 'text-amber-400 hover:text-amber-300'
                        : 'text-indigo-400 hover:text-indigo-300'
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    {item.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    onClick={() => void handleClawHubUpdate(item.slug)}
                    disabled={clawHubLoading}
                    className="text-[10px] font-black uppercase tracking-widest text-emerald-400 hover:text-emerald-300 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Update
                  </button>
                  <button
                    onClick={() => void handleClawHubUninstall(item.slug)}
                    disabled={clawHubLoading}
                    className="text-[10px] font-black uppercase tracking-widest text-rose-400 hover:text-rose-300 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Uninstall
                  </button>
                </div>
              </div>
            ))}
          </div>

          <p className="text-[10px] text-zinc-500 mt-3">
            ClawHub skills are managed as instruction skills (`SKILL.md`) and do not replace
            executable tool skills.
          </p>
        </div>
      </section>

      <section className="bg-zinc-900/60 border border-zinc-800 rounded-[2rem] p-6 shadow-lg">
        <div className="flex items-center justify-between gap-3 mb-4">
          <h3 className="text-sm font-black uppercase tracking-widest text-white">
            Tool Configuration
          </h3>
          <button
            onClick={() => void loadRuntimeConfigs()}
            disabled={runtimeConfigLoading}
            className="px-3 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Refresh
          </button>
        </div>
        <p className="text-xs text-zinc-500 mb-4">
          Configure required credentials once. Skills can only be activated when required fields are configured.
        </p>

        <div className="space-y-3">
          {runtimeConfigs.map((config) => (
            <div
              key={config.id}
              className="bg-zinc-800/60 border border-zinc-700 rounded-2xl p-4 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4"
            >
              <div className="min-w-0">
                <p className="text-xs text-white font-semibold">
                  {config.label}
                  {config.required ? (
                    <span className="text-rose-400 ml-1" title="Required">
                      *
                    </span>
                  ) : null}
                </p>
                <p className="text-[10px] text-zinc-500 mt-1">{config.description}</p>
                <p className="text-[10px] text-zinc-600 mt-1 font-mono">
                  Env fallback: {config.envVars.join(' / ')}
                </p>
              </div>

              <div className="flex-1 lg:max-w-xl">
                <div className="flex items-center gap-2 mb-2">
                  <span
                    className={`text-[9px] font-black uppercase px-2 py-0.5 rounded border ${
                      config.configured
                        ? config.source === 'store'
                          ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30'
                          : 'text-amber-400 bg-amber-500/10 border-amber-500/30'
                        : 'text-zinc-400 bg-zinc-700/30 border-zinc-600'
                    }`}
                  >
                    {config.configured
                      ? config.source === 'store'
                        ? 'Saved'
                        : 'Env Fallback'
                      : 'Missing'}
                  </span>
                  {config.maskedValue && (
                    <span className="text-[10px] text-zinc-500 font-mono truncate">
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
                    className="w-full p-2.5 bg-zinc-900 text-zinc-300 rounded-xl font-mono text-xs border border-zinc-700 focus:border-indigo-500 focus:outline-none"
                  />
                  <button
                    onClick={() => void handleRuntimeConfigSave(config.id)}
                    disabled={runtimeConfigSavingId === config.id || !String(runtimeConfigDrafts[config.id] || '').trim()}
                    className="px-3 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => void handleRuntimeConfigClear(config.id)}
                    disabled={runtimeConfigSavingId === config.id || !config.configured}
                    className="px-3 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Clear
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {clawHubError && (
        <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg p-3">
          {clawHubError}
        </p>
      )}

      {runtimeConfigError && (
        <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg p-3">
          {runtimeConfigError}
        </p>
      )}

      {skillActionError && (
        <p className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg p-3">
          {skillActionError}
        </p>
      )}

      {/* Skill Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
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
              className="bg-zinc-900/60 border border-zinc-800 rounded-[2rem] p-6 flex flex-col h-[300px] relative overflow-hidden group hover:border-indigo-500/50 transition-all shadow-lg"
            >
              <div className="flex items-center justify-between mb-3">
                <span
                  className={`text-[8px] font-black uppercase px-2 py-0.5 rounded border ${
                    skill.installed
                      ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20'
                      : setupRequired
                        ? 'bg-amber-500/10 text-amber-400 border-amber-500/30'
                      : 'bg-zinc-800 text-zinc-500 border-zinc-700'
                  }`}
                >
                  {skill.installed
                    ? 'Runtime: Active'
                    : setupRequired
                      ? 'Setup Required'
                      : 'Available'}
                </span>
                <div className="flex items-center gap-2">
                  <span className={`text-[8px] font-black uppercase px-2 py-0.5 rounded border ${sourceMeta.color}`}>
                    {sourceMeta.label}
                  </span>
                  <span className="text-[9px] font-mono text-zinc-600">v{skill.version}</span>
                </div>
              </div>

              <div className="flex items-start gap-2 mb-2">
                <h3 className="font-bold text-white text-lg group-hover:text-indigo-400 transition-colors leading-tight">
                  {skill.name}
                </h3>
                <button
                  type="button"
                  aria-label={`Open info for ${skill.name}`}
                  onClick={() => setToolInfoSkillId(skill.id)}
                  className="w-5 h-5 rounded-full border border-zinc-700 text-zinc-300 text-[10px] font-black hover:text-white hover:border-zinc-500 transition-colors shrink-0 mt-0.5"
                  title={`Info: ${skill.name}`}
                >
                  i
                </button>
              </div>
              <p className="text-xs text-zinc-500 line-clamp-3 mb-4 flex-1">{skill.description}</p>
              {hints.requiredHint && (
                <p className="text-[10px] text-amber-300 mb-1 line-clamp-2">{hints.requiredHint}</p>
              )}
              {hints.optionalHint && (
                <p className="text-[10px] text-zinc-400 mb-2 line-clamp-2">{hints.optionalHint}</p>
              )}

              {skill.sourceUrl && (
                <p className="text-[9px] text-zinc-600 font-mono truncate mb-3">{skill.sourceUrl}</p>
              )}

              {setupRequired && (
                <p className="text-[10px] text-amber-400 mb-3 line-clamp-2">
                  Missing: {missingRequiredConfigs.map((config) => config.label).join(', ')}
                </p>
              )}

              <div className="mt-auto pt-4 border-t border-zinc-800/50 flex items-center justify-between">
                <span className="text-[10px] font-black text-zinc-600 uppercase tracking-tighter">
                  {skill.category}
                </span>
                <div className="flex items-center gap-3">
                  {skill.source !== 'built-in' && (
                    <button
                      onClick={() => handleRemoveSkill(skill.id)}
                      className="text-[10px] font-black uppercase tracking-widest text-zinc-600 hover:text-red-400 transition-colors"
                    >
                      Remove
                    </button>
                  )}
                  <button
                    onClick={() => handleToggleInstall(skill.id)}
                    disabled={!skill.installed && setupRequired}
                    className={`text-[10px] font-black uppercase tracking-widest transition-all ${
                      skill.installed
                        ? 'text-rose-500 hover:text-rose-400'
                        : 'text-indigo-500 hover:text-indigo-400'
                    } disabled:text-zinc-500 disabled:cursor-not-allowed`}
                  >
                    {skill.installed ? 'Deactivate' : 'Activate'}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Tool Info Modal */}
      {toolGuide && toolInfoSkill && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setToolInfoSkillId(null)}
        >
          <div
            className="bg-zinc-900 border border-zinc-700 rounded-3xl p-8 w-full max-w-2xl shadow-2xl max-h-[85vh] overflow-auto"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-6">
              <div>
                <h3 className="text-xl font-black text-white uppercase tracking-tight">
                  {toolGuide.title}
                </h3>
                <p className="text-[11px] text-zinc-500 font-mono mt-1">
                  Function: {toolInfoSkill.functionName}
                </p>
              </div>
              <button
                onClick={() => setToolInfoSkillId(null)}
                className="text-zinc-500 hover:text-white text-xl"
                aria-label="Close tool info"
              >
                ✕
              </button>
            </div>

            <section className="mb-5">
              <h4 className="text-[11px] font-black uppercase tracking-widest text-zinc-300 mb-2">
                What It Is
              </h4>
              <p className="text-sm text-zinc-400 leading-relaxed">{toolGuide.whatItIs}</p>
            </section>

            <section className="mb-5">
              <h4 className="text-[11px] font-black uppercase tracking-widest text-zinc-300 mb-2">
                What It Can Do
              </h4>
              <ul className="list-disc pl-5 space-y-1">
                {toolGuide.whatItCanDo.map((item) => (
                  <li key={item} className="text-sm text-zinc-400">
                    {item}
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <h4 className="text-[11px] font-black uppercase tracking-widest text-zinc-300 mb-2">
                How To Use
              </h4>
              <ul className="list-disc pl-5 space-y-1">
                {toolGuide.howToUse.map((item) => (
                  <li key={item} className="text-sm text-zinc-400">
                    {item}
                  </li>
                ))}
              </ul>
            </section>

            <div className="flex justify-end mt-8">
              <button
                onClick={() => setToolInfoSkillId(null)}
                className="px-5 py-2.5 bg-zinc-800 text-zinc-300 rounded-xl text-xs font-bold uppercase hover:bg-zinc-700 transition-all"
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
          <div className="bg-zinc-900 border border-zinc-700 rounded-3xl p-8 w-full max-w-xl shadow-2xl">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-xl font-black text-white uppercase tracking-tight">Install Skill</h3>
              <button
                onClick={() => {
                  setShowInstallModal(false);
                  setInstallError('');
                }}
                className="text-zinc-500 hover:text-white text-xl"
              >
                ✕
              </button>
            </div>

            {/* Tabs */}
            <div className="flex gap-2 mb-6">
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
                  className={`px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-wider transition-all ${
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
                className="w-full h-40 p-4 bg-zinc-800 text-zinc-300 rounded-xl font-mono text-xs border border-zinc-700 focus:border-indigo-500 focus:outline-none resize-none"
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
                className="w-full p-4 bg-zinc-800 text-zinc-300 rounded-xl font-mono text-sm border border-zinc-700 focus:border-indigo-500 focus:outline-none"
              />
            )}

            {/* Security notice */}
            <p className="text-[10px] text-amber-500/70 mt-3">
              ⚠ External skills can affect runtime behavior. Only install from trusted sources.
            </p>

            {installError && (
              <p className="text-xs text-red-400 mt-3 bg-red-500/10 border border-red-500/20 rounded-lg p-3">
                {installError}
              </p>
            )}

            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => {
                  setShowInstallModal(false);
                  setInstallError('');
                }}
                className="px-6 py-3 bg-zinc-800 text-zinc-400 rounded-xl text-xs font-bold uppercase hover:bg-zinc-700 transition-all"
              >
                Cancel
              </button>
              <button
                onClick={handleInstall}
                disabled={installLoading || !installValue.trim()}
                className="px-6 py-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-bold uppercase transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-indigo-500/20"
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
