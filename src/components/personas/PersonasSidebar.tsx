'use client';

import React from 'react';
import type { PersonaSummary } from '@/server/personas/personaTypes';
import type { PersonaTemplate } from '@/lib/persona-templates';

interface PersonasSidebarProps {
  personas: PersonaSummary[];
  activePersonaId: string | null;
  loading: boolean;
  selectedId: string | null;
  onSelectPersona: (id: string) => void;
  showTemplates: boolean;
  setShowTemplates: (open: boolean) => void;
  creating: boolean;
  templates: PersonaTemplate[];
  onCreatePersona: (
    name: string,
    emoji: string,
    vibe: string,
    files?: Record<string, string>,
  ) => void | Promise<void>;
}

export function PersonasSidebar({
  personas,
  activePersonaId,
  loading,
  selectedId,
  onSelectPersona,
  showTemplates,
  setShowTemplates,
  creating,
  templates,
  onCreatePersona,
}: PersonasSidebarProps) {
  return (
    <div className="flex w-72 shrink-0 flex-col border-r border-zinc-800">
      <div className="border-b border-zinc-800 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-black tracking-widest text-white uppercase">Personas</h2>
          <button
            onClick={() => setShowTemplates(!showTemplates)}
            className="rounded-lg bg-indigo-600 p-1.5 text-white transition-colors hover:bg-indigo-500"
            title="Neue Persona"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
          </button>
        </div>

        {showTemplates && (
          <div className="mb-3 space-y-2 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
            <button
              onClick={() => onCreatePersona('Neue Persona', '🤖', '')}
              disabled={creating}
              className="w-full rounded-lg bg-zinc-800 px-3 py-2 text-left text-sm text-white transition-colors hover:bg-zinc-700"
            >
              ✨ Leere Persona erstellen
            </button>
            <div className="mt-2 mb-1 text-[9px] font-black tracking-widest text-zinc-500 uppercase">
              Vorlagen
            </div>
            {templates.map((template) => (
              <button
                key={template.id}
                onClick={async () => {
                  const { PERSONA_TEMPLATES } = await import('@/lib/persona-templates');
                  const full = PERSONA_TEMPLATES.find((candidate) => candidate.id === template.id);
                  await onCreatePersona(template.name, template.emoji, template.vibe, full?.files);
                }}
                disabled={creating}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-zinc-300 transition-colors hover:bg-zinc-800"
              >
                <span>{template.emoji}</span>
                <span>{template.name}</span>
                <span className="ml-auto text-[10px] text-zinc-600">{template.vibe}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
        {loading && personas.length === 0 && (
          <div className="py-8 text-center text-sm text-zinc-600">Laden...</div>
        )}
        {!loading && personas.length === 0 && (
          <div className="py-8 text-center text-sm text-zinc-600">
            Keine Personas erstellt.
            <br />
            <button
              onClick={() => setShowTemplates(true)}
              className="mt-2 inline-block text-indigo-500 hover:text-indigo-400"
            >
              Erste Persona erstellen
            </button>
          </div>
        )}
        {personas.map((persona) => (
          <button
            key={persona.id}
            onClick={() => onSelectPersona(persona.id)}
            className={`group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-all ${
              selectedId === persona.id
                ? 'border border-indigo-500/30 bg-indigo-600/20 text-white'
                : 'border border-transparent text-zinc-400 hover:bg-zinc-800/60 hover:text-white'
            }`}
          >
            <span className="text-lg">{persona.emoji}</span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">{persona.name}</div>
              {persona.vibe && (
                <div className="truncate text-[10px] text-zinc-500">{persona.vibe}</div>
              )}
            </div>
            {activePersonaId === persona.id && (
              <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" title="Aktiv" />
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
