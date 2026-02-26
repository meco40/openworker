'use client';

import React from 'react';
import type { FormHeaderProps } from '../types';

export function FormHeader({
  selectedPersona,
  editingMeta,
  setEditingMeta,
  metaName,
  setMetaName,
  metaEmoji,
  setMetaEmoji,
  metaVibe,
  setMetaVibe,
  saveMeta,
  saving,
  startEditMeta,
  activePersonaId,
  setActivePersonaId,
  duplicatePersona,
  creating,
  deletePersona,
}: FormHeaderProps) {
  return (
    <div className="flex items-center gap-4 border-b border-zinc-800 p-4">
      {editingMeta ? (
        <div className="flex flex-1 items-center gap-3">
          <input
            value={metaEmoji}
            onChange={(event) => setMetaEmoji(event.target.value)}
            className="w-12 rounded-lg border border-zinc-700 bg-zinc-900 p-1 text-center text-lg"
            maxLength={4}
          />
          <input
            value={metaName}
            onChange={(event) => setMetaName(event.target.value)}
            className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-white"
            placeholder="Name"
          />
          <input
            value={metaVibe}
            onChange={(event) => setMetaVibe(event.target.value)}
            className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-300"
            placeholder="Vibe / Beschreibung"
          />
          <button
            onClick={saveMeta}
            disabled={saving}
            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-bold text-white transition-colors hover:bg-indigo-500"
          >
            OK
          </button>
          <button
            onClick={() => setEditingMeta(false)}
            className="px-3 py-1.5 text-xs text-zinc-500 transition-colors hover:text-white"
          >
            Abbrechen
          </button>
        </div>
      ) : (
        <>
          <span className="text-2xl">{selectedPersona.emoji}</span>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-lg font-bold text-white">{selectedPersona.name}</h3>
            {selectedPersona.vibe && (
              <div className="truncate text-xs text-zinc-500">{selectedPersona.vibe}</div>
            )}
          </div>
          <button
            onClick={startEditMeta}
            className="p-2 text-zinc-500 transition-colors hover:text-white"
            title="Bearbeiten"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.863 4.487Zm0 0L19.5 7.125"
              />
            </svg>
          </button>
          <button
            onClick={() =>
              setActivePersonaId(activePersonaId === selectedPersona.id ? null : selectedPersona.id)
            }
            className={`rounded-lg px-4 py-1.5 text-xs font-bold tracking-wider uppercase transition-all ${
              activePersonaId === selectedPersona.id
                ? 'border border-emerald-500/30 bg-emerald-600/20 text-emerald-400 hover:border-rose-500/30 hover:bg-rose-600/20 hover:text-rose-400'
                : 'bg-indigo-600 text-white hover:bg-indigo-500'
            }`}
          >
            {activePersonaId === selectedPersona.id ? 'Aktiv ✓' : 'Aktivieren'}
          </button>
          <button
            onClick={duplicatePersona}
            disabled={creating}
            className="p-2 text-zinc-500 transition-colors hover:text-indigo-400"
            title="Duplizieren"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 0 1 1.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 0 0-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 0 1-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H9.75"
              />
            </svg>
          </button>
          <button
            onClick={deletePersona}
            className="p-2 text-zinc-600 transition-colors hover:text-rose-500"
            title="Löschen"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"
              />
            </svg>
          </button>
        </>
      )}
    </div>
  );
}
