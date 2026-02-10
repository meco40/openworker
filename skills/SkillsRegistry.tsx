
import React, { useState, useCallback } from 'react';
import { Skill } from '../types';

interface SkillsRegistryProps {
  skills: Skill[];
  setSkills: React.Dispatch<React.SetStateAction<Skill[]>>;
}

type InstallTab = 'github' | 'npm' | 'manifest';

const SOURCE_LABELS: Record<string, { label: string; color: string }> = {
  'built-in': { label: 'Built-in', color: 'text-zinc-500 bg-zinc-800 border-zinc-700' },
  github: { label: 'GitHub', color: 'text-purple-400 bg-purple-500/10 border-purple-500/20' },
  npm: { label: 'npm', color: 'text-red-400 bg-red-500/10 border-red-500/20' },
  manual: { label: 'Manual', color: 'text-blue-400 bg-blue-500/10 border-blue-500/20' },
};

const SkillsRegistry: React.FC<SkillsRegistryProps> = ({ skills, setSkills }) => {
  const [showInstallModal, setShowInstallModal] = useState(false);
  const [installTab, setInstallTab] = useState<InstallTab>('github');
  const [installValue, setInstallValue] = useState('');
  const [installLoading, setInstallLoading] = useState(false);
  const [installError, setInstallError] = useState('');

  const handleToggleInstall = useCallback(
    async (id: string) => {
      const skill = skills.find((s) => s.id === id);
      if (!skill) return;

      const newInstalled = !skill.installed;
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
    [skills, setSkills],
  );

  const handleInstall = useCallback(async () => {
    setInstallLoading(true);
    setInstallError('');

    try {
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
  }, [installTab, installValue, setSkills]);

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
    } catch {
      // silently fail
    }
  }, [setSkills]);

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
            className="px-6 py-4 bg-zinc-800 hover:bg-zinc-700 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all border border-zinc-700"
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

      {/* Skill Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
        {skills.map((skill) => {
          const sourceMeta = SOURCE_LABELS[skill.source] ?? SOURCE_LABELS['built-in'];
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
                      : 'bg-zinc-800 text-zinc-500 border-zinc-700'
                  }`}
                >
                  {skill.installed ? 'Runtime: Active' : 'Available'}
                </span>
                <div className="flex items-center gap-2">
                  <span className={`text-[8px] font-black uppercase px-2 py-0.5 rounded border ${sourceMeta.color}`}>
                    {sourceMeta.label}
                  </span>
                  <span className="text-[9px] font-mono text-zinc-600">v{skill.version}</span>
                </div>
              </div>

              <h3 className="font-bold text-white mb-2 text-lg group-hover:text-indigo-400 transition-colors">
                {skill.name}
              </h3>
              <p className="text-xs text-zinc-500 line-clamp-3 mb-4 flex-1">{skill.description}</p>

              {skill.sourceUrl && (
                <p className="text-[9px] text-zinc-600 font-mono truncate mb-3">{skill.sourceUrl}</p>
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
                    className={`text-[10px] font-black uppercase tracking-widest transition-all ${
                      skill.installed
                        ? 'text-rose-500 hover:text-rose-400'
                        : 'text-indigo-500 hover:text-indigo-400'
                    }`}
                  >
                    {skill.installed ? 'Deactivate' : 'Activate'}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

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
                    : '@openclaw/skill-weather'
                }
                className="w-full p-4 bg-zinc-800 text-zinc-300 rounded-xl font-mono text-sm border border-zinc-700 focus:border-indigo-500 focus:outline-none"
              />
            )}

            {/* Security notice */}
            <p className="text-[10px] text-amber-500/70 mt-3">
              ⚠ External skills run handler code on the server. Only install from trusted sources.
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
