'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { usePersona } from '@/modules/personas/PersonaContext';
import type { PersonaTabName, MemoryPersonaType } from '@/server/personas/personaTypes';
import { PersonasSidebar } from '@/components/personas/PersonasSidebar';
import { PersonaEditorPane } from '@/components/personas/PersonaEditorPane';
import {
  usePersonaSelection,
  usePersonaEditor,
  usePersonaMeta,
  usePersonaTemplates,
  usePersonaCRUD,
  usePipelineModels,
  useKeyboardShortcuts,
} from '@/components/personas/hooks';

const PersonasView: React.FC = () => {
  const {
    personas,
    activePersonaId,
    setActivePersonaId,
    refreshPersonas,
    loadPersonaById,
    patchPersonaFile,
    loading,
  } = usePersona();
  const [activeTab, setActiveTab] = useState<PersonaTabName>('SOUL.md');

  // Persona selection and loading
  const {
    selectedId,
    selectedPersona,
    setSelectedId,
    loadPersona,
    patchSelectedPersonaFile,
    preferredModelId,
    setPreferredModelId,
  } = usePersonaSelection({ loadPersonaById, onPersonaFilePatched: patchPersonaFile });

  // Memory persona type state
  const [memoryPersonaType, setMemoryPersonaType] = useState<MemoryPersonaType>('general');
  const [savingMemoryPersonaType, setSavingMemoryPersonaType] = useState(false);

  // Autonomous agent state
  const [isAutonomous, setIsAutonomous] = useState(false);
  const [maxToolCalls, setMaxToolCalls] = useState(120);
  const [savingAutonomous, setSavingAutonomous] = useState(false);

  // Sync memoryPersonaType when persona loads
  useEffect(() => {
    if (selectedPersona) {
      setMemoryPersonaType(selectedPersona.memoryPersonaType || 'general');
      setIsAutonomous(Boolean(selectedPersona.isAutonomous));
      setMaxToolCalls(selectedPersona.maxToolCalls ?? 120);
    }
  }, [selectedPersona]);

  // Editor state
  const { editorContent, setEditorContent, dirty, setDirty, saveFile } = usePersonaEditor({
    selectedId,
    selectedPersona,
    activeTab,
    onSavedFile: patchSelectedPersonaFile,
  });

  // Metadata editing
  const {
    editingMeta,
    setEditingMeta,
    metaName,
    setMetaName,
    metaEmoji,
    setMetaEmoji,
    metaVibe,
    setMetaVibe,
    saving: savingMeta,
    startEditMeta,
    saveMeta,
  } = usePersonaMeta({
    selectedId,
    selectedPersona,
    refreshPersonas,
    loadPersona,
  });

  // Templates
  const { templates, showTemplates, setShowTemplates } = usePersonaTemplates();

  // CRUD operations
  const { creating, createPersona, duplicatePersona, deletePersona } = usePersonaCRUD({
    selectedId,
    selectedPersona,
    refreshPersonas,
    setSelectedId,
    setActivePersonaId,
    activePersonaId,
  });

  // Pipeline models
  const { pipelineModels, loadPipelineModels, savingPreferredModel, savePreferredModel } =
    usePipelineModels();

  // Selection handlers
  const selectPersona = useCallback(
    (id: string) => {
      if (dirty && !window.confirm('Ungespeicherte Änderungen verwerfen?')) return;
      setSelectedId(id);
      setDirty(false);
      setEditingMeta(false);
    },
    [dirty, setSelectedId, setDirty, setEditingMeta],
  );

  // Effects
  useEffect(() => {
    loadPipelineModels();
  }, [loadPipelineModels]);

  // Keyboard shortcuts
  useKeyboardShortcuts({ dirty, selectedId, activeTab, onSave: saveFile });

  // Save preferred model wrapper
  const handleSavePreferredModel = useCallback(
    async (modelId: string | null) => {
      if (!selectedId) return;
      await savePreferredModel(selectedId, modelId, refreshPersonas, loadPersona);
      setPreferredModelId(modelId);
    },
    [selectedId, savePreferredModel, refreshPersonas, loadPersona, setPreferredModelId],
  );

  // Save memory persona type
  const handleSaveMemoryPersonaType = useCallback(
    async (type: MemoryPersonaType) => {
      if (!selectedId) return;
      setMemoryPersonaType(type);
      setSavingMemoryPersonaType(true);
      try {
        const res = await fetch(`/api/personas/${selectedId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ memoryPersonaType: type }),
        });
        if (res.ok) {
          await refreshPersonas();
          await loadPersona(selectedId);
        }
      } catch {
        /* ignore */
      } finally {
        setSavingMemoryPersonaType(false);
      }
    },
    [selectedId, refreshPersonas, loadPersona],
  );

  // Save autonomous settings (called on toggle flip OR save button press)
  const handleSaveAutonomous = useCallback(
    async (newIsAutonomous: boolean) => {
      if (!selectedId) return;
      setIsAutonomous(newIsAutonomous);
      setSavingAutonomous(true);
      try {
        const res = await fetch(`/api/personas/${selectedId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isAutonomous: newIsAutonomous, maxToolCalls }),
        });
        if (res.ok) {
          await refreshPersonas();
          await loadPersona(selectedId);
        }
      } catch {
        /* ignore */
      } finally {
        setSavingAutonomous(false);
      }
    },
    [selectedId, maxToolCalls, refreshPersonas, loadPersona],
  );

  return (
    <div className="animate-in fade-in flex h-full duration-500">
      <PersonasSidebar
        personas={personas}
        activePersonaId={activePersonaId}
        loading={loading}
        selectedId={selectedId}
        onSelectPersona={selectPersona}
        showTemplates={showTemplates}
        setShowTemplates={setShowTemplates}
        creating={creating}
        templates={templates}
        onCreatePersona={createPersona}
      />

      {/* ── Right Panel: Editor ───────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        {!selectedPersona ? (
          <div className="flex flex-1 items-center justify-center text-zinc-600">
            <div className="space-y-2 text-center">
              <div className="text-4xl">🎭</div>
              <div className="text-sm">Wähle oder erstelle eine Persona</div>
            </div>
          </div>
        ) : (
          <PersonaEditorPane
            selectedPersona={selectedPersona}
            selectedId={selectedId}
            editingMeta={editingMeta}
            setEditingMeta={setEditingMeta}
            metaName={metaName}
            setMetaName={setMetaName}
            metaEmoji={metaEmoji}
            setMetaEmoji={setMetaEmoji}
            metaVibe={metaVibe}
            setMetaVibe={setMetaVibe}
            saveMeta={saveMeta}
            saving={savingMeta}
            startEditMeta={startEditMeta}
            activePersonaId={activePersonaId}
            setActivePersonaId={setActivePersonaId}
            duplicatePersona={duplicatePersona}
            creating={creating}
            deletePersona={deletePersona}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            dirty={dirty}
            setDirty={setDirty}
            editorContent={editorContent}
            setEditorContent={setEditorContent}
            saveFile={saveFile}
            pipelineModels={pipelineModels}
            preferredModelId={preferredModelId}
            onPreferredModelChange={handleSavePreferredModel}
            savingPreferredModel={savingPreferredModel}
            memoryPersonaType={memoryPersonaType}
            onMemoryPersonaTypeChange={handleSaveMemoryPersonaType}
            savingMemoryPersonaType={savingMemoryPersonaType}
            isAutonomous={isAutonomous}
            maxToolCalls={maxToolCalls}
            onIsAutonomousChange={handleSaveAutonomous}
            onMaxToolCallsChange={setMaxToolCalls}
            savingAutonomous={savingAutonomous}
          />
        )}
      </div>
    </div>
  );
};

export default PersonasView;
