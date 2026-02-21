'use client';

import React, { useEffect, useState } from 'react';
import { usePersona } from '@/modules/personas/PersonaContext';
import type { PersonaSummary } from '@/server/personas/personaTypes';
import { KnowledgeGraphPanel } from '@/components/knowledge/graph';
import { useKnowledgeGraph } from '@/components/knowledge/hooks';

const KnowledgeView: React.FC = () => {
  const { personas, activePersonaId, refreshPersonas } = usePersona();
  const [selectedPersonaId, setSelectedPersonaId] = useState<string | null>(null);

  useEffect(() => {
    void refreshPersonas();
  }, [refreshPersonas]);

  useEffect(() => {
    if (personas.length === 0) {
      setSelectedPersonaId(null);
      return;
    }
    if (
      selectedPersonaId &&
      personas.some((persona: PersonaSummary) => persona.id === selectedPersonaId)
    ) {
      return;
    }
    if (
      activePersonaId &&
      personas.some((persona: PersonaSummary) => persona.id === activePersonaId)
    ) {
      setSelectedPersonaId(activePersonaId);
      return;
    }
    setSelectedPersonaId(personas[0].id);
  }, [activePersonaId, personas, selectedPersonaId]);

  const { payload, loading, error, reload } = useKnowledgeGraph(selectedPersonaId);

  return (
    <div className="animate-in fade-in flex h-full min-h-[70vh] overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950/40 duration-300">
      <aside className="w-72 border-r border-zinc-800 bg-zinc-900/40 p-4">
        <div className="mb-4">
          <h2 className="text-sm font-black tracking-widest text-zinc-100 uppercase">Knowledge</h2>
          <p className="mt-1 text-xs text-zinc-500">
            Persona wählen, um den Entity-Graph zu visualisieren.
          </p>
        </div>
        <div className="space-y-2">
          {personas.map((persona) => (
            <button
              key={persona.id}
              onClick={() => setSelectedPersonaId(persona.id)}
              className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left transition ${
                selectedPersonaId === persona.id
                  ? 'border-cyan-500/50 bg-cyan-500/10 text-zinc-100'
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

      <div className="min-w-0 flex-1 p-4">
        {!selectedPersonaId ? (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-500">
            Erstelle zuerst eine Persona oder wähle eine bestehende aus.
          </div>
        ) : (
          <KnowledgeGraphPanel
            payload={payload}
            loading={loading}
            error={error}
            onReload={reload}
          />
        )}
      </div>
    </div>
  );
};

export default KnowledgeView;
