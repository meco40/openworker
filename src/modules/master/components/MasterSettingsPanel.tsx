import React, { useEffect, useState } from 'react';
import type { MasterSettingsSnapshot, SaveMasterSettingsInput } from '@/modules/master/types';

interface MasterSettingsPanelProps {
  settings: MasterSettingsSnapshot | null;
  loading: boolean;
  onSave: (input: SaveMasterSettingsInput) => void;
}

type InstructionField = {
  label: keyof MasterSettingsSnapshot['instructionFiles'];
  value: string;
  setValue: React.Dispatch<React.SetStateAction<string>>;
};

function parseToolList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ].sort();
}

export default function MasterSettingsPanel({
  settings,
  loading,
  onSave,
}: MasterSettingsPanelProps) {
  const [preferredModelId, setPreferredModelId] = useState('');
  const [modelHubProfileId, setModelHubProfileId] = useState('');
  const [isAutonomous, setIsAutonomous] = useState(true);
  const [maxToolCalls, setMaxToolCalls] = useState('120');
  const [toolList, setToolList] = useState('');
  const [soul, setSoul] = useState('');
  const [agents, setAgents] = useState('');
  const [user, setUser] = useState('');

  useEffect(() => {
    if (!settings) return;
    setPreferredModelId(settings.runtimeSettings.preferredModelId ?? '');
    setModelHubProfileId(settings.runtimeSettings.modelHubProfileId ?? '');
    setIsAutonomous(settings.runtimeSettings.isAutonomous);
    setMaxToolCalls(String(settings.runtimeSettings.maxToolCalls));
    setToolList(settings.allowedToolFunctionNames.join(', '));
    setSoul(settings.instructionFiles['SOUL.md']);
    setAgents(settings.instructionFiles['AGENTS.md']);
    setUser(settings.instructionFiles['USER.md']);
  }, [settings]);

  if (!settings) {
    return (
      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6 shadow-xl">
        <p className="text-sm text-zinc-500">Loading Master settings…</p>
      </section>
    );
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/40 shadow-xl">
      <div className="border-b border-zinc-800/80 bg-zinc-950/40 px-6 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-[10px] font-bold tracking-widest text-zinc-400 uppercase">
              Master Settings
            </h3>
            <p className="mt-1 text-sm text-zinc-500">
              Manage the fixed Master persona, runtime defaults, and instruction files.
            </p>
          </div>
          <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[10px] font-bold tracking-widest text-amber-300 uppercase">
            System Persona
          </span>
        </div>
      </div>

      <div className="space-y-6 p-6">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
            <p className="text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
              Identity
            </p>
            <div className="mt-3 flex items-center gap-3">
              <span className="text-xl">{settings.persona.emoji ?? '🧭'}</span>
              <div>
                <p className="font-semibold text-white">{settings.persona.name}</p>
                <p className="text-xs text-zinc-500">Slug: {settings.persona.slug}</p>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
            <p className="text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
              Runtime Policy
            </p>
            <label className="mt-3 flex items-center gap-2 text-sm text-zinc-200">
              <input
                type="checkbox"
                checked={isAutonomous}
                onChange={(event) => setIsAutonomous(event.target.checked)}
                className="rounded border-zinc-700 bg-zinc-950 text-indigo-500"
              />
              Autonomous mode enabled
            </label>
            <label className="mt-3 block text-xs font-semibold tracking-wide text-zinc-500 uppercase">
              Max tool calls
              <input
                type="number"
                min={3}
                max={500}
                value={maxToolCalls}
                onChange={(event) => setMaxToolCalls(event.target.value)}
                className="mt-2 w-full rounded-xl border border-zinc-700/80 bg-zinc-950/80 px-3 py-2.5 text-sm text-zinc-100 focus:border-indigo-500/80 focus:ring-1 focus:ring-indigo-500/30 focus:outline-none"
              />
            </label>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <label className="block text-xs font-semibold tracking-wide text-zinc-500 uppercase">
            Preferred model
            <input
              value={preferredModelId}
              onChange={(event) => setPreferredModelId(event.target.value)}
              placeholder="gpt-4o-mini"
              className="mt-2 w-full rounded-xl border border-zinc-700/80 bg-zinc-950/80 px-3 py-2.5 text-sm text-zinc-100 focus:border-indigo-500/80 focus:ring-1 focus:ring-indigo-500/30 focus:outline-none"
            />
          </label>
          <label className="block text-xs font-semibold tracking-wide text-zinc-500 uppercase">
            Model Hub profile
            <input
              value={modelHubProfileId}
              onChange={(event) => setModelHubProfileId(event.target.value)}
              placeholder="ops-team"
              className="mt-2 w-full rounded-xl border border-zinc-700/80 bg-zinc-950/80 px-3 py-2.5 text-sm text-zinc-100 focus:border-indigo-500/80 focus:ring-1 focus:ring-indigo-500/30 focus:outline-none"
            />
          </label>
        </div>

        <label className="block text-xs font-semibold tracking-wide text-zinc-500 uppercase">
          Allowed tools
          <input
            value={toolList}
            onChange={(event) => setToolList(event.target.value)}
            placeholder="shell_execute, web_search"
            className="mt-2 w-full rounded-xl border border-zinc-700/80 bg-zinc-950/80 px-3 py-2.5 text-sm text-zinc-100 focus:border-indigo-500/80 focus:ring-1 focus:ring-indigo-500/30 focus:outline-none"
          />
        </label>

        <div className="grid gap-4 xl:grid-cols-3">
          {(
            [
              { label: 'SOUL.md', value: soul, setValue: setSoul },
              { label: 'AGENTS.md', value: agents, setValue: setAgents },
              { label: 'USER.md', value: user, setValue: setUser },
            ] satisfies InstructionField[]
          ).map(({ label, value, setValue }) => (
            <label
              key={label}
              className="block text-xs font-semibold tracking-wide text-zinc-500 uppercase"
            >
              {label}
              <textarea
                value={value}
                onChange={(event) => setValue(event.target.value)}
                rows={10}
                className="mt-2 w-full resize-y rounded-xl border border-zinc-700/80 bg-zinc-950/80 px-3 py-2.5 text-sm leading-relaxed text-zinc-100 focus:border-indigo-500/80 focus:ring-1 focus:ring-indigo-500/30 focus:outline-none"
              />
            </label>
          ))}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-3">
          <button
            type="button"
            disabled={loading}
            onClick={() =>
              onSave({
                preferredModelId: preferredModelId.trim() || null,
                modelHubProfileId: modelHubProfileId.trim() || null,
                isAutonomous,
                maxToolCalls: Number(maxToolCalls),
                allowedToolFunctionNames: parseToolList(toolList),
                files: {
                  'SOUL.md': soul,
                  'AGENTS.md': agents,
                  'USER.md': user,
                },
              })
            }
            className="rounded-2xl bg-indigo-600 px-5 py-2.5 text-xs font-black tracking-widest text-white uppercase shadow-lg shadow-indigo-600/25 transition-all hover:bg-indigo-500 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? 'Saving…' : 'Save Settings'}
          </button>
        </div>
      </div>
    </section>
  );
}
