'use client';

import React, { useMemo, useState } from 'react';
import type { PersonaSummary } from '@/server/personas/personaTypes';
import type { SwarmUnit } from '@/modules/agent-room/swarmTypes';

interface NewSwarmModalProps {
  open: boolean;
  personas: PersonaSummary[];
  creating: boolean;
  onClose: () => void;
  onCreate: (input: {
    title: string;
    task: string;
    leadPersonaId: string;
    units: SwarmUnit[];
    searchEnabled?: boolean;
    pauseBetweenPhases: boolean;
    swarmTemplate: string | null;
  }) => Promise<{ id: string } | null | void>;
}

interface SuggestedRole {
  role: string;
  description: string;
}

const SWARM_TEMPLATES: Array<{
  id: string;
  label: string;
  icon: string;
  title: string;
  task: string;
  suggestedRoles: SuggestedRole[];
}> = [
  {
    id: 'product_discovery',
    label: 'Product Discovery',
    icon: '🔍',
    title: 'Product Discovery Sprint',
    task: 'Conduct a comprehensive product discovery session. Define the problem space, identify user pain points, map the competitive landscape, and propose 3 prioritised solution directions with success metrics.',
    suggestedRoles: [
      { role: 'lead', description: 'Facilitates the discovery session and synthesises findings' },
      { role: 'user-researcher', description: 'Identifies pain points and user needs' },
      { role: 'market-analyst', description: 'Maps the competitive landscape' },
      { role: 'strategist', description: 'Proposes solution directions and metrics' },
    ],
  },
  {
    id: 'code_review',
    label: 'Code Review',
    icon: '🔧',
    title: 'In-Depth Code Review',
    task: 'Perform a thorough architectural and code quality review. Identify security vulnerabilities, performance bottlenecks, test coverage gaps, and maintainability issues. Produce a prioritised remediation plan.',
    suggestedRoles: [
      { role: 'lead', description: 'Coordinates the review and produces the remediation plan' },
      { role: 'security-auditor', description: 'Focuses on vulnerabilities and threat vectors' },
      { role: 'performance-engineer', description: 'Analyses bottlenecks and resource usage' },
      { role: 'test-engineer', description: 'Evaluates test coverage and quality' },
    ],
  },
  {
    id: 'research_deep_dive',
    label: 'Research Deep-Dive',
    icon: '📚',
    title: 'Research Deep-Dive',
    task: 'Conduct an exhaustive research analysis. Synthesise primary and secondary sources, map the evidence landscape, identify knowledge gaps, and formulate evidence-backed conclusions with confidence ratings.',
    suggestedRoles: [
      { role: 'lead', description: 'Directs research scope and synthesises conclusions' },
      { role: 'domain-expert', description: 'Provides deep subject-matter knowledge' },
      { role: 'critic', description: 'Challenges assumptions and identifies gaps' },
    ],
  },
  {
    id: 'risk_analysis',
    label: 'Risk Analysis',
    icon: '⚠️',
    title: 'Risk & Impact Analysis',
    task: 'Perform a structured risk assessment. Categorise risks by likelihood and impact, propose mitigation strategies for each, and output a risk register with recommended controls and contingency triggers.',
    suggestedRoles: [
      { role: 'lead', description: 'Structures the risk register and final output' },
      { role: 'risk-assessor', description: 'Categorises risks by likelihood and impact' },
      { role: 'mitigation-planner', description: 'Designs controls and contingency triggers' },
      { role: 'devil-advocate', description: 'Challenges risk ratings and finds blind spots' },
    ],
  },
  {
    id: 'creative_writing',
    label: 'Creative Writing',
    icon: '✍️',
    title: 'Creative Writing Project',
    task: 'Collaborate on a creative writing project. Establish tone, voice, narrative arc and character motivations. Draft the opening, develop key scenes, refine prose style, and produce a final cohesive piece.',
    suggestedRoles: [
      { role: 'lead', description: 'Establishes vision, narrative arc, and cohesion' },
      { role: 'storyteller', description: 'Drafts scenes and develops characters' },
      { role: 'editor', description: 'Refines prose style, voice, and pacing' },
    ],
  },
];

function defaultUnitsFromPersona(leadPersonaId: string): SwarmUnit[] {
  if (!leadPersonaId) return [];
  return [{ personaId: leadPersonaId, role: 'lead' }];
}

export default function NewSwarmModal({
  open,
  personas,
  creating,
  onClose,
  onCreate,
}: NewSwarmModalProps) {
  const [title, setTitle] = useState('');
  const [task, setTask] = useState('');
  const [leadPersonaId, setLeadPersonaId] = useState('');
  const [selectedUnitIds, setSelectedUnitIds] = useState<string[]>([]);
  const [pauseBetweenPhases, setPauseBetweenPhases] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const availablePersonas = useMemo(
    () => personas.filter((persona) => persona.systemPersonaKey !== 'master'),
    [personas],
  );

  const personaMap = useMemo(
    () => new Map(availablePersonas.map((persona) => [persona.id, persona])),
    [availablePersonas],
  );

  if (!open) return null;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!leadPersonaId || !personaMap.has(leadPersonaId)) {
      setError('Lead persona ist erforderlich.');
      return;
    }
    if (!task.trim()) {
      setError('Task ist erforderlich.');
      return;
    }

    const unitIds = Array.from(new Set([leadPersonaId, ...selectedUnitIds])).filter((id) =>
      personaMap.has(id),
    );
    const units = unitIds.map((personaId) => ({
      personaId,
      role: personaId === leadPersonaId ? 'lead' : 'specialist',
    }));
    if (units.length === 0) {
      setError('Mindestens eine Persona-Einheit wird benötigt.');
      return;
    }
    if (units.length < 2) {
      setError('Für Multi-Persona benötigt der Swarm mindestens 2 Personas.');
      return;
    }

    await onCreate({
      title: title.trim() || 'New Swarm',
      task: task.trim(),
      leadPersonaId,
      units,
      searchEnabled: true,
      pauseBetweenPhases,
      swarmTemplate: selectedTemplate,
    });
    setTitle('');
    setTask('');
    setLeadPersonaId('');
    setSelectedUnitIds([]);
    setPauseBetweenPhases(false);
    setSelectedTemplate(null);
    onClose();
  }

  function toggleUnit(personaId: string) {
    setSelectedUnitIds((previous) => {
      if (previous.includes(personaId)) {
        return previous.filter((id) => id !== personaId);
      }
      return [...previous, personaId];
    });
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-xl rounded-xl border border-zinc-800 bg-[#0c111f] p-5 text-zinc-200"
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-base font-semibold text-white">New Swarm</h2>
            <p className="mt-1 text-xs text-zinc-400">
              Create a new agent swarm from existing personas.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-zinc-400 hover:text-zinc-200"
          >
            ✕
          </button>
        </div>

        {/* Template picker */}
        <div className="mb-4">
          <div className="mb-2 text-xs font-semibold text-zinc-400 uppercase">Quick Template</div>
          <div className="flex flex-wrap gap-2">
            {SWARM_TEMPLATES.map((tpl) => (
              <button
                key={tpl.id}
                type="button"
                onClick={() => {
                  setSelectedTemplate(tpl.id);
                  setTitle(tpl.title);
                  setTask(tpl.task);
                }}
                className={`flex items-center gap-1.5 rounded border px-2.5 py-1 text-xs transition-colors ${
                  selectedTemplate === tpl.id
                    ? 'border-cyan-500/70 bg-cyan-500/20 text-cyan-100'
                    : 'border-zinc-700 text-zinc-300 hover:border-zinc-500'
                }`}
              >
                <span>{tpl.icon}</span>
                <span>{tpl.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Suggested roles for selected template */}
        {selectedTemplate &&
          (() => {
            const tpl = SWARM_TEMPLATES.find((t) => t.id === selectedTemplate);
            if (!tpl?.suggestedRoles.length) return null;
            return (
              <div className="mb-4 rounded border border-cyan-900/40 bg-cyan-950/20 p-3">
                <div className="mb-1.5 text-[10px] font-semibold text-cyan-400/80 uppercase">
                  Suggested Roles for {tpl.label}
                </div>
                <div className="space-y-1">
                  {tpl.suggestedRoles.map((sr) => (
                    <div key={sr.role} className="flex items-baseline gap-2 text-[11px]">
                      <span className="shrink-0 rounded bg-cyan-500/15 px-1.5 py-0.5 font-mono text-cyan-300">
                        {sr.role}
                      </span>
                      <span className="text-zinc-400">{sr.description}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

        <label className="mb-3 block text-xs font-semibold text-zinc-400 uppercase">
          Title
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
            placeholder="Research Mission"
          />
        </label>

        <label className="mb-3 block text-xs font-semibold text-zinc-400 uppercase">
          Task
          <textarea
            value={task}
            onChange={(event) => setTask(event.target.value)}
            className="mt-1 min-h-24 w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
            placeholder="Beschreibe die Aufgabe für den Schwarm."
          />
        </label>

        <label className="mb-3 block text-xs font-semibold text-zinc-400 uppercase">
          Lead Persona
          <select
            value={leadPersonaId}
            onChange={(event) => {
              const nextLead = event.target.value;
              setLeadPersonaId(nextLead);
              setSelectedUnitIds((previous) => {
                const defaults = availablePersonas
                  .map((persona) => persona.id)
                  .filter((personaId) => personaId !== nextLead);
                const filtered = previous.filter((id) => id !== nextLead);
                return Array.from(
                  new Set([
                    ...defaults,
                    ...defaultUnitsFromPersona(nextLead).map((unit) => unit.personaId),
                    ...filtered,
                  ]),
                );
              });
            }}
            className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
          >
            <option value="">Select Persona</option>
            {availablePersonas.map((persona) => (
              <option key={persona.id} value={persona.id}>
                {persona.emoji} {persona.name}
              </option>
            ))}
          </select>
        </label>

        <div className="mb-4 rounded border border-zinc-800 bg-zinc-950/50 p-3">
          <div className="mb-2 text-xs font-semibold text-zinc-400 uppercase">Swarm Units</div>
          {availablePersonas.length === 0 && (
            <div className="text-xs text-amber-300">
              Keine Personas verfügbar. Bitte zuerst Personas anlegen.
            </div>
          )}
          {availablePersonas.length > 0 && (
            <div className="grid max-h-40 grid-cols-1 gap-2 overflow-auto pr-1">
              {availablePersonas.map((persona) => {
                const checked =
                  selectedUnitIds.includes(persona.id) || persona.id === leadPersonaId;
                return (
                  <label
                    key={persona.id}
                    className="flex cursor-pointer items-center gap-2 rounded border border-zinc-800 px-2 py-1.5 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleUnit(persona.id)}
                      disabled={persona.id === leadPersonaId}
                    />
                    <span>
                      {persona.emoji} {persona.name}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        {/* Options toggles */}
        <div className="mb-4 flex flex-wrap gap-4">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
            <input
              type="checkbox"
              checked={pauseBetweenPhases}
              onChange={(e) => setPauseBetweenPhases(e.target.checked)}
              className="rounded"
            />
            <span>⏸ Pause Between Phases</span>
          </label>
        </div>

        {error && <div className="mb-3 text-xs text-rose-300">{error}</div>}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-900"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={creating || availablePersonas.length === 0}
            className="rounded border border-cyan-500/50 bg-cyan-500/15 px-3 py-1.5 text-xs font-semibold text-cyan-200 disabled:opacity-50"
          >
            {creating ? 'Deploying...' : 'Deploy Agents'}
          </button>
        </div>
      </form>
    </div>
  );
}
