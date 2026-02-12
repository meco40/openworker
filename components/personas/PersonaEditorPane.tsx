'use client';

import React from 'react';
import { PERSONA_FILE_NAMES } from '../../src/server/personas/personaTypes';
import type { PersonaFileName, PersonaWithFiles } from '../../src/server/personas/personaTypes';
import { FILE_LABELS } from './personaLabels';

interface PersonaEditorPaneProps {
  selectedPersona: PersonaWithFiles;
  selectedId: string | null;
  editingMeta: boolean;
  setEditingMeta: (value: boolean) => void;
  metaName: string;
  setMetaName: (value: string) => void;
  metaEmoji: string;
  setMetaEmoji: (value: string) => void;
  metaVibe: string;
  setMetaVibe: (value: string) => void;
  saveMeta: () => void;
  saving: boolean;
  startEditMeta: () => void;
  activePersonaId: string | null;
  setActivePersonaId: (id: string | null) => void;
  duplicatePersona: () => void;
  creating: boolean;
  deletePersona: () => void;
  activeFile: PersonaFileName;
  setActiveFile: (file: PersonaFileName) => void;
  dirty: boolean;
  setDirty: (value: boolean) => void;
  editorContent: string;
  setEditorContent: (value: string) => void;
  saveFile: () => void;
}

export function PersonaEditorPane({
  selectedPersona,
  selectedId,
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
  activeFile,
  setActiveFile,
  dirty,
  setDirty,
  editorContent,
  setEditorContent,
  saveFile,
}: PersonaEditorPaneProps) {
  return (
    <>
      <div className="p-4 border-b border-zinc-800 flex items-center gap-4">
        {editingMeta ? (
          <div className="flex items-center gap-3 flex-1">
            <input
              value={metaEmoji}
              onChange={(event) => setMetaEmoji(event.target.value)}
              className="w-12 text-center bg-zinc-900 border border-zinc-700 rounded-lg p-1 text-lg"
              maxLength={4}
            />
            <input
              value={metaName}
              onChange={(event) => setMetaName(event.target.value)}
              className="flex-1 bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-white"
              placeholder="Name"
            />
            <input
              value={metaVibe}
              onChange={(event) => setMetaVibe(event.target.value)}
              className="flex-1 bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-zinc-300"
              placeholder="Vibe / Beschreibung"
            />
            <button
              onClick={saveMeta}
              disabled={saving}
              className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-bold transition-colors"
            >
              OK
            </button>
            <button
              onClick={() => setEditingMeta(false)}
              className="px-3 py-1.5 text-zinc-500 hover:text-white text-xs transition-colors"
            >
              Abbrechen
            </button>
          </div>
        ) : (
          <>
            <span className="text-2xl">{selectedPersona.emoji}</span>
            <div className="flex-1 min-w-0">
              <h3 className="text-lg font-bold text-white truncate">{selectedPersona.name}</h3>
              {selectedPersona.vibe && (
                <div className="text-xs text-zinc-500 truncate">{selectedPersona.vibe}</div>
              )}
            </div>
            <button
              onClick={startEditMeta}
              className="p-2 text-zinc-500 hover:text-white transition-colors"
              title="Bearbeiten"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.863 4.487Zm0 0L19.5 7.125" />
              </svg>
            </button>
            <button
              onClick={() =>
                setActivePersonaId(activePersonaId === selectedPersona.id ? null : selectedPersona.id)
              }
              className={`px-4 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider transition-all ${
                activePersonaId === selectedPersona.id
                  ? 'bg-emerald-600/20 text-emerald-400 border border-emerald-500/30 hover:bg-rose-600/20 hover:text-rose-400 hover:border-rose-500/30'
                  : 'bg-indigo-600 hover:bg-indigo-500 text-white'
              }`}
            >
              {activePersonaId === selectedPersona.id ? 'Aktiv ✓' : 'Aktivieren'}
            </button>
            <button
              onClick={duplicatePersona}
              disabled={creating}
              className="p-2 text-zinc-500 hover:text-indigo-400 transition-colors"
              title="Duplizieren"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 0 1 1.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 0 0-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 0 1-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H9.75" />
              </svg>
            </button>
            <button
              onClick={deletePersona}
              className="p-2 text-zinc-600 hover:text-rose-500 transition-colors"
              title="Löschen"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
              </svg>
            </button>
          </>
        )}
      </div>

      <div className="flex border-b border-zinc-800 px-4 overflow-x-auto">
        {PERSONA_FILE_NAMES.map((fileName) => (
          <button
            key={fileName}
            onClick={() => {
              if (dirty && !window.confirm('Ungespeicherte Änderungen verwerfen?')) return;
              setActiveFile(fileName);
            }}
            className={`px-4 py-2.5 text-xs font-bold uppercase tracking-wider transition-colors whitespace-nowrap border-b-2 ${
              activeFile === fileName
                ? 'text-indigo-400 border-indigo-500'
                : 'text-zinc-500 border-transparent hover:text-zinc-300'
            }`}
          >
            {FILE_LABELS[fileName]}
          </button>
        ))}
      </div>

      <div className="flex-1 relative">
        <textarea
          value={editorContent}
          onChange={(event) => {
            setEditorContent(event.target.value);
            setDirty(true);
          }}
          className="absolute inset-0 w-full h-full bg-zinc-950 text-zinc-200 font-mono text-sm p-6 resize-none focus:outline-none leading-relaxed placeholder:text-zinc-700"
          placeholder={`# ${FILE_LABELS[activeFile]}\n\nSchreibe hier die ${FILE_LABELS[activeFile]}-Definition für deine Persona...`}
          spellCheck={false}
        />
      </div>

      <div className="flex items-center justify-between px-4 py-2 border-t border-zinc-800 bg-zinc-900/40">
        <div className="text-[10px] text-zinc-600 font-mono">
          {activeFile}
          {dirty && <span className="text-amber-500 ml-2">● Ungespeichert</span>}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-zinc-600">{editorContent.length} Zeichen</span>
          <button
            onClick={saveFile}
            disabled={!dirty || saving || !selectedId}
            className={`px-4 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider transition-all ${
              dirty
                ? 'bg-indigo-600 hover:bg-indigo-500 text-white'
                : 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
            }`}
          >
            {saving ? 'Speichern...' : 'Speichern'}
          </button>
        </div>
      </div>
    </>
  );
}
