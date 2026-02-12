'use client';

import React from 'react';
import type { PersonaSummary } from '../../src/server/personas/personaTypes';
import type { PersonaTemplate } from '../../lib/persona-templates';
import type { RoomSummary } from '../../src/modules/rooms/types';

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
  roomsLoading: boolean;
  rooms: RoomSummary[];
  selectedRoomId: string | null;
  onSelectRoom: (roomId: string) => void;
  roomCreating: boolean;
  onCreateRoomFlow: () => void;
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
  roomsLoading,
  rooms,
  selectedRoomId,
  onSelectRoom,
  roomCreating,
  onCreateRoomFlow,
}: PersonasSidebarProps) {
  return (
    <div className="w-72 shrink-0 border-r border-zinc-800 flex flex-col">
      <div className="p-4 border-b border-zinc-800">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-black text-white uppercase tracking-widest">Personas</h2>
          <button
            onClick={() => setShowTemplates(!showTemplates)}
            className="p-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
            title="Neue Persona"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
          </button>
        </div>

        {showTemplates && (
          <div className="space-y-2 mb-3 p-3 bg-zinc-900/60 rounded-xl border border-zinc-800">
            <button
              onClick={() => onCreatePersona('Neue Persona', '🤖', '')}
              disabled={creating}
              className="w-full text-left px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-sm text-white transition-colors"
            >
              ✨ Leere Persona erstellen
            </button>
            <div className="text-[9px] font-black text-zinc-500 uppercase tracking-widest mt-2 mb-1">
              Vorlagen
            </div>
            {templates.map((template) => (
              <button
                key={template.id}
                onClick={async () => {
                  const { PERSONA_TEMPLATES } = await import('../../lib/persona-templates');
                  const full = PERSONA_TEMPLATES.find((candidate) => candidate.id === template.id);
                  await onCreatePersona(template.name, template.emoji, template.vibe, full?.files);
                }}
                disabled={creating}
                className="w-full text-left px-3 py-2 rounded-lg hover:bg-zinc-800 text-sm text-zinc-300 transition-colors flex items-center gap-2"
              >
                <span>{template.emoji}</span>
                <span>{template.name}</span>
                <span className="text-[10px] text-zinc-600 ml-auto">{template.vibe}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1 min-h-0">
        {loading && personas.length === 0 && (
          <div className="text-zinc-600 text-sm text-center py-8">Laden...</div>
        )}
        {!loading && personas.length === 0 && (
          <div className="text-zinc-600 text-sm text-center py-8">
            Keine Personas erstellt.
            <br />
            <button
              onClick={() => setShowTemplates(true)}
              className="text-indigo-500 hover:text-indigo-400 mt-2 inline-block"
            >
              Erste Persona erstellen
            </button>
          </div>
        )}
        {personas.map((persona) => (
          <button
            key={persona.id}
            onClick={() => onSelectPersona(persona.id)}
            className={`w-full text-left px-3 py-2.5 rounded-xl flex items-center gap-3 transition-all group ${
              selectedId === persona.id
                ? 'bg-indigo-600/20 border border-indigo-500/30 text-white'
                : 'hover:bg-zinc-800/60 text-zinc-400 hover:text-white border border-transparent'
            }`}
          >
            <span className="text-lg">{persona.emoji}</span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold truncate">{persona.name}</div>
              {persona.vibe && (
                <div className="text-[10px] text-zinc-500 truncate">{persona.vibe}</div>
              )}
            </div>
            {activePersonaId === persona.id && (
              <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" title="Aktiv" />
            )}
          </button>
        ))}
      </div>

      <div className="border-t border-zinc-800 flex flex-col min-h-0" style={{ maxHeight: '45%' }}>
        <div className="p-4 border-b border-zinc-800">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-black text-white uppercase tracking-widest">Rooms</h2>
            <button
              onClick={onCreateRoomFlow}
              disabled={roomCreating}
              className="p-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white transition-colors disabled:opacity-60"
              title="Neuen Room erstellen"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {roomsLoading && rooms.length === 0 && (
            <div className="text-zinc-600 text-sm text-center py-4">Laden...</div>
          )}
          {!roomsLoading && rooms.length === 0 && (
            <div className="text-zinc-600 text-sm text-center py-4">Keine Rooms erstellt.</div>
          )}
          {rooms.map((room) => (
            <button
              key={room.id}
              onClick={() => onSelectRoom(room.id)}
              className={`w-full text-left px-3 py-2.5 rounded-xl transition-all border ${
                selectedRoomId === room.id
                  ? 'bg-emerald-600/20 border-emerald-500/30 text-white'
                  : 'hover:bg-zinc-800/60 text-zinc-400 hover:text-white border-transparent'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-semibold truncate">{room.name}</div>
                <span
                  className={`text-[10px] px-2 py-0.5 rounded-full uppercase tracking-wider ${
                    room.runState === 'running'
                      ? 'bg-emerald-600/20 text-emerald-300'
                      : room.runState === 'degraded'
                        ? 'bg-amber-700/30 text-amber-300'
                        : 'bg-zinc-700/60 text-zinc-300'
                  }`}
                >
                  {room.runState}
                </span>
              </div>
              <div className="text-[10px] text-zinc-500 truncate mt-1">
                {room.goalMode} • {room.routingProfileId}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
