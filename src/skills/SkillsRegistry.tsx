'use client';

import React, { useEffect, useState } from 'react';
import { useClawHub } from '@/skills/hooks/useClawHub';
import { useRuntimeConfigs } from '@/skills/hooks/useRuntimeConfigs';
import { useSkillActions } from '@/skills/hooks/useSkillActions';
import {
  ClawHubSearch,
  ClawHubInstalled,
  ToolConfiguration,
  SkillCard,
  ToolInfoModal,
  InstallModal,
  type SkillsRegistryProps,
  type InstallTab,
  type RegistryTab,
} from '@/skills/components/registry';

const SkillsRegistry: React.FC<SkillsRegistryProps> = ({ skills, setSkills }) => {
  // Local UI state
  const [showInstallModal, setShowInstallModal] = useState(false);
  const [installTab, setInstallTab] = useState<InstallTab>('github');
  const [installValue, setInstallValue] = useState('');
  const [activeRegistryTab, setActiveRegistryTab] = useState<RegistryTab>('skills');
  const [toolInfoSkillId, setToolInfoSkillId] = useState<string | null>(null);

  // Custom hooks
  const clawHub = useClawHub();
  const runtimeConfigs = useRuntimeConfigs();
  const skillActions = useSkillActions(skills, setSkills, runtimeConfigs.getMissingRequired);
  const refreshInstalled = clawHub.refreshInstalled;
  const loadConfigs = runtimeConfigs.loadConfigs;

  // Effects
  useEffect(() => {
    void refreshInstalled();
  }, [refreshInstalled]);

  useEffect(() => {
    void loadConfigs();
  }, [loadConfigs]);

  // Derived values
  const toolInfoSkill = toolInfoSkillId
    ? skills.find((skill) => skill.id === toolInfoSkillId) || null
    : null;

  // Handlers
  const handleSyncRefresh = async () => {
    await skillActions.handleSyncRefresh(
      clawHub.beginAction,
      clawHub.endAction,
      runtimeConfigs.loadConfigs,
    );
  };

  const handleInstall = async () => {
    await skillActions.handleInstall({
      tab: installTab,
      value: installValue,
      beginClawHubAction: clawHub.beginAction,
      endClawHubAction: clawHub.endAction,
      refreshClawHubInstalled: clawHub.refreshInstalled,
      setShowModal: setShowInstallModal,
      setInstallValue,
    });
  };

  return (
    <div className="animate-in fade-in mx-auto max-w-6xl space-y-10 pb-20 duration-500">
      {/* Header */}
      <header className="group relative flex items-center justify-between overflow-hidden rounded-[2.5rem] border border-zinc-800 bg-zinc-900/40 p-10 shadow-2xl">
        <div className="absolute top-0 right-0 -mt-40 -mr-40 h-80 w-80 rounded-full bg-indigo-600/10 blur-[100px]" />
        <div className="relative z-10">
          <h2 className="text-3xl font-black tracking-tight text-white uppercase">Skill Registry</h2>
          <p className="mt-2 max-w-md text-sm text-zinc-500">
            Extend agent capabilities. Installed skills become active tools in the KI context.
          </p>
        </div>
        <div className="relative z-10 flex gap-3">
          <button
            onClick={handleSyncRefresh}
            disabled={clawHub.loading || skillActions.actionError !== ''}
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

      {/* ClawHub Section */}
      <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ClawHubSearch
          query={clawHub.query}
          onQueryChange={clawHub.setQuery}
          onSearch={clawHub.handleSearch}
          onReset={clawHub.handleSearchReset}
          results={clawHub.searchResults}
          warnings={clawHub.searchWarnings}
          loading={clawHub.loading}
          onInstall={clawHub.handleInstall}
        />
        <ClawHubInstalled
          skills={clawHub.installed}
          loading={clawHub.loading}
          onRefresh={clawHub.refreshInstalled}
          onUpdate={clawHub.handleUpdate}
          onUninstall={clawHub.handleUninstall}
          onToggleEnabled={clawHub.handleToggleEnabled}
        />
      </section>

      {/* Tabs */}
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

      {/* Tool Configuration Tab */}
      {activeRegistryTab === 'tool-configuration' && (
        <ToolConfiguration
          configs={runtimeConfigs.configs}
          drafts={runtimeConfigs.drafts}
          loading={runtimeConfigs.loading}
          savingId={runtimeConfigs.savingId}
          onRefresh={runtimeConfigs.loadConfigs}
          onDraftChange={runtimeConfigs.handleDraft}
          onSave={runtimeConfigs.handleSave}
          onClear={runtimeConfigs.handleClear}
        />
      )}

      {/* Error Messages */}
      {clawHub.error && (
        <p className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-400">
          {clawHub.error}
        </p>
      )}

      {runtimeConfigs.error && (
        <p className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-400">
          {runtimeConfigs.error}
        </p>
      )}

      {skillActions.actionError && (
        <p className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-300">
          {skillActions.actionError}
        </p>
      )}

      {/* Skills Grid */}
      {activeRegistryTab === 'skills' && (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {skills.map((skill) => (
            <SkillCard
              key={skill.id}
              skill={skill}
              runtimeConfigs={runtimeConfigs.configs}
              onToggleInstall={skillActions.handleToggleInstall}
              onRemove={skillActions.handleRemove}
              onInfo={setToolInfoSkillId}
            />
          ))}
        </div>
      )}

      {/* Tool Info Modal */}
      <ToolInfoModal
        skill={toolInfoSkill}
        runtimeConfigs={runtimeConfigs.configs}
        onClose={() => setToolInfoSkillId(null)}
      />

      {/* Install Modal */}
      <InstallModal
        show={showInstallModal}
        tab={installTab}
        value={installValue}
        loading={clawHub.loading}
        error={clawHub.error}
        onClose={() => {
          setShowInstallModal(false);
          setInstallValue('');
        }}
        onTabChange={(tab) => {
          setInstallTab(tab);
        }}
        onValueChange={setInstallValue}
        onInstall={handleInstall}
      />
    </div>
  );
};

export default SkillsRegistry;
