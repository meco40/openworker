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
                  const { PERSONA_TEMPLATES } = await import('../../lib/persona-templates');
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

      <div className="flex min-h-0 flex-col border-t border-zinc-800" style={{ maxHeight: '45%' }}>
        <div className="border-b border-zinc-800 p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-black tracking-widest text-white uppercase">Rooms</h2>
            <button
              onClick={onCreateRoomFlow}
              disabled={roomCreating}
              className="rounded-lg bg-emerald-600 p-1.5 text-white transition-colors hover:bg-emerald-500 disabled:opacity-60"
              title="Neuen Room erstellen"
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
        </div>
        <div className="flex-1 space-y-1 overflow-y-auto p-2">
          {roomsLoading && rooms.length === 0 && (
            <div className="py-4 text-center text-sm text-zinc-600">Laden...</div>
          )}
          {!roomsLoading && rooms.length === 0 && (
            <div className="py-4 text-center text-sm text-zinc-600">Keine Rooms erstellt.</div>
          )}
          {rooms.map((room) => (
            <button
              key={room.id}
              onClick={() => onSelectRoom(room.id)}
              className={`w-full rounded-xl border px-3 py-2.5 text-left transition-all ${
                selectedRoomId === room.id
                  ? 'border-emerald-500/30 bg-emerald-600/20 text-white'
                  : 'border-transparent text-zinc-400 hover:bg-zinc-800/60 hover:text-white'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="truncate text-sm font-semibold">{room.name}</div>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] tracking-wider uppercase ${
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
              <div className="mt-1 truncate text-[10px] text-zinc-500">
                {room.goalMode} • {room.routingProfileId}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
