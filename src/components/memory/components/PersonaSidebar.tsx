'use client';

import React from 'react';
import type { PersonaSummary } from '@/server/personas/personaTypes';

interface PersonaSidebarProps {
  personas: PersonaSummary[];
  selectedPersonaId: string | null;
  onSelectPersona: (personaId: string) => void;
  onCancelEdit: () => void;
}

export const PersonaSidebar: React.FC<PersonaSidebarProps> = ({
  personas,
  selectedPersonaId,
  onSelectPersona,
  onCancelEdit,
}) => {
  return (
    <aside className="w-80 border-r border-zinc-800 bg-zinc-900/40 p-4">
      <div className="mb-4">
        <h2 className="text-sm font-black tracking-widest text-white uppercase">Personas</h2>
        <p className="mt-1 text-xs text-zinc-500">Wähle eine Persona, um Memory zu verwalten.</p>
      </div>
      <div className="space-y-2">
        {personas.map((persona) => (
          <button
            key={persona.id}
            onClick={() => {
              onSelectPersona(persona.id);
              onCancelEdit();
            }}
            className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left transition ${
              selectedPersonaId === persona.id
                ? 'border-indigo-500/50 bg-indigo-500/10 text-white'
                : 'border-zinc-800 bg-zinc-900/40 text-zinc-300 hover:border-zinc-700'
            }`}
          >
            <span className="truncate text-sm">
              {persona.emoji} {persona.name}
            </span>
          </button>
        ))}
        {personas.length === 0 && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-xs text-zinc-500">
            Keine Personas vorhanden.
          </div>
        )}
      </div>
    </aside>
  );
};
