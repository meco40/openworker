'use client';

import React from 'react';
import { PERSONA_TAB_NAMES } from '../../src/server/personas/personaTypes';
import type { PersonaTabName, PersonaWithFiles } from '../../src/server/personas/personaTypes';
import { TAB_LABELS } from './personaLabels';

interface PipelineModel {
  id: string;
  accountId: string;
  providerId: string;
  modelName: string;
  status: 'active' | 'rate-limited' | 'offline';
  priority: number;
}

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
  activeTab: PersonaTabName;
  setActiveTab: (tab: PersonaTabName) => void;
  dirty: boolean;
  setDirty: (value: boolean) => void;
  editorContent: string;
  setEditorContent: (value: string) => void;
  saveFile: () => void;
  // Gateway tab props
  pipelineModels: PipelineModel[];
  preferredModelId: string | null;
  onPreferredModelChange: (modelId: string | null) => void;
  savingPreferredModel: boolean;
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
  activeTab,
  setActiveTab,
  dirty,
  setDirty,
  editorContent,
  setEditorContent,
  saveFile,
  pipelineModels,
  preferredModelId,
  onPreferredModelChange,
  savingPreferredModel,
}: PersonaEditorPaneProps) {
  const isGatewayTab = activeTab === 'GATEWAY';
  const activeFile = isGatewayTab ? null : activeTab;

  // Filter active models for selection
  const activeModels = pipelineModels.filter((m) => m.status === 'active');
  const hasMultipleActiveModels = activeModels.length > 1;

  return (
    <>
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
                setActivePersonaId(
                  activePersonaId === selectedPersona.id ? null : selectedPersona.id,
                )
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

      <div className="flex overflow-x-auto border-b border-zinc-800 px-4">
        {PERSONA_TAB_NAMES.map((tabName) => (
          <button
            key={tabName}
            onClick={() => {
              if (dirty && !window.confirm('Ungespeicherte Änderungen verwerfen?')) return;
              setActiveTab(tabName);
            }}
            className={`border-b-2 px-4 py-2.5 text-xs font-bold tracking-wider whitespace-nowrap uppercase transition-colors ${
              activeTab === tabName
                ? 'border-indigo-500 text-indigo-400'
                : 'border-transparent text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {TAB_LABELS[tabName]}
          </button>
        ))}
      </div>

      <div className="relative flex-1">
        {isGatewayTab ? (
          <div className="absolute inset-0 h-full w-full overflow-auto bg-zinc-950 p-6">
            <div className="mx-auto max-w-2xl space-y-6">
              <div className="space-y-2">
                <h4 className="text-lg font-bold text-white">Gateway Konfiguration</h4>
                <p className="text-sm text-zinc-400">
                  Wähle das bevorzugte Modell für diese Persona. Das bevorzugte Modell wird 
                  zuerst versucht. Bei Rate-Limit oder Fehler wird automatisch auf die anderen 
                  aktiven Modelle in der Pipeline ausgewichen.
                </p>
              </div>

              {activeModels.length === 0 ? (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
                  <div className="flex items-start gap-3">
                    <svg
                      className="mt-0.5 h-5 w-5 text-amber-400"
                      fill="none"
                      viewBox="0 0 24 24"
                      strokeWidth={1.5}
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
                      />
                    </svg>
                    <div>
                      <p className="font-medium text-amber-400">Keine aktiven Modelle</p>
                      <p className="mt-1 text-sm text-amber-300/70">
                        Es sind keine aktiven Modelle in der Pipeline konfiguriert.
                        Bitte füge zuerst Modelle im Model Hub hinzu.
                      </p>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Model Selection */}
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-zinc-300">
                      Bevorzugtes Modell
                    </label>
                    <select
                      value={preferredModelId ?? ''}
                      onChange={(e) =>
                        onPreferredModelChange(e.target.value ? e.target.value : null)
                      }
                      disabled={savingPreferredModel || !hasMultipleActiveModels}
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <option value="">
                        {hasMultipleActiveModels
                          ? 'Automatisch (Primary)'
                          : `${activeModels[0]?.modelName} (Primary)`}
                      </option>
                      {activeModels.map((model) => (
                        <option key={model.id} value={model.modelName}>
                          {model.modelName} ({model.providerId})
                        </option>
                      ))}
                    </select>
                    {!hasMultipleActiveModels && (
                      <p className="text-xs text-zinc-500">
                        Es ist nur ein Modell aktiv. Die Auswahl ist auf das Primary-Modell beschränkt.
                      </p>
                    )}
                  </div>

                  {/* Active Models List */}
                  <div className="space-y-2 pt-4">
                    <h5 className="text-sm font-medium text-zinc-400">Aktive Modelle in Pipeline</h5>
                    <div className="space-y-2">
                      {activeModels
                        .sort((a, b) => a.priority - b.priority)
                        .map((model, index) => (
                          <div
                            key={model.id}
                            className={`flex items-center justify-between rounded-lg border p-3 ${
                              preferredModelId === model.modelName ||
                              (!preferredModelId && index === 0)
                                ? 'border-indigo-500/50 bg-indigo-500/10'
                                : 'border-zinc-800 bg-zinc-900/50'
                            }`}
                          >
                            <div className="flex items-center gap-3">
                              <span
                                className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
                                  index === 0
                                    ? 'bg-emerald-500/20 text-emerald-400'
                                    : 'bg-zinc-700 text-zinc-400'
                                }`}
                              >
                                {index + 1}
                              </span>
                              <div>
                                <p className="text-sm font-medium text-white">{model.modelName}</p>
                                <p className="text-xs text-zinc-500">{model.providerId}</p>
                              </div>
                            </div>
                            {index === 0 && (
                              <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-xs font-medium text-emerald-400">
                                Primary
                              </span>
                            )}
                            {preferredModelId === model.modelName && index !== 0 && (
                              <span className="rounded-full bg-indigo-500/20 px-2 py-0.5 text-xs font-medium text-indigo-400">
                                Bevorzugt
                              </span>
                            )}
                          </div>
                        ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : (
          <textarea
            value={editorContent}
            onChange={(event) => {
              setEditorContent(event.target.value);
              setDirty(true);
            }}
            className="absolute inset-0 h-full w-full resize-none bg-zinc-950 p-6 font-mono text-sm leading-relaxed text-zinc-200 placeholder:text-zinc-700 focus:outline-none"
            placeholder={`# ${activeFile ? TAB_LABELS[activeFile] : ''}\n\nSchreibe hier die ${activeFile ? TAB_LABELS[activeFile] : ''}-Definition für deine Persona...`}
            spellCheck={false}
          />
        )}
      </div>

      <div className="flex items-center justify-between border-t border-zinc-800 bg-zinc-900/40 px-4 py-2">
        <div className="font-mono text-[10px] text-zinc-600">
          {isGatewayTab ? (
            <span className="text-indigo-400">Gateway Konfiguration</span>
          ) : (
            <>
              {activeFile}
              {dirty && <span className="ml-2 text-amber-500">● Ungespeichert</span>}
            </>
          )}
        </div>
        <div className="flex items-center gap-3">
          {!isGatewayTab && (
            <span className="text-[10px] text-zinc-600">{editorContent.length} Zeichen</span>
          )}
          <button
            onClick={isGatewayTab ? () => onPreferredModelChange(preferredModelId) : saveFile}
            disabled={isGatewayTab ? savingPreferredModel : !dirty || saving || !selectedId}
            className={`rounded-lg px-4 py-1.5 text-xs font-bold tracking-wider uppercase transition-all ${
              isGatewayTab
                ? savingPreferredModel
                  ? 'cursor-not-allowed bg-zinc-800 text-zinc-600'
                  : 'bg-indigo-600 text-white hover:bg-indigo-500'
                : dirty
                  ? 'bg-indigo-600 text-white hover:bg-indigo-500'
                  : 'cursor-not-allowed bg-zinc-800 text-zinc-600'
            }`}
          >
            {isGatewayTab
              ? savingPreferredModel
                ? 'Speichern...'
                : 'Speichern'
              : saving
                ? 'Speichern...'
                : 'Speichern'}
          </button>
        </div>
      </div>
    </>
  );
}
