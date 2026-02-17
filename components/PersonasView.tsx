'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { usePersona } from '../src/modules/personas/PersonaContext';
import type { PersonaTabName } from '../src/server/personas/personaTypes';
import { RoomDetailPanel } from '../src/modules/rooms/components/RoomDetailPanel';
import { CreateRoomModal } from '../src/modules/rooms/components/CreateRoomModal';
import { PersonasSidebar } from './personas/PersonasSidebar';
import { PersonaEditorPane } from './personas/PersonaEditorPane';
import { useRoomSync } from '../src/modules/rooms/useRoomSync';
import {
  usePersonaSelection,
  usePersonaEditor,
  usePersonaMeta,
  usePersonaTemplates,
  usePersonaCRUD,
  usePipelineModels,
  useRoomManagement,
  useKeyboardShortcuts,
} from './personas/hooks';

const PersonasView: React.FC = () => {
  const { personas, activePersonaId, setActivePersonaId, refreshPersonas, loading } = usePersona();
  const [activeTab, setActiveTab] = useState<PersonaTabName>('SOUL.md');

  // Persona selection and loading
  const {
    selectedId,
    selectedPersona,
    setSelectedId,
    loadPersona,
    preferredModelId,
    setPreferredModelId,
  } = usePersonaSelection({ activeTab });

  // Editor state
  const { editorContent, setEditorContent, dirty, setDirty, saveFile } = usePersonaEditor({
    selectedId,
    selectedPersona,
    activeTab,
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

  // Room management
  const handleRoomSelect = useCallback(() => {
    setSelectedId(null);
    setEditingMeta(false);
  }, [setSelectedId, setEditingMeta]);

  const {
    rooms,
    roomsLoading,
    roomCreating,
    selectedRoomId,
    selectedRoomState,
    selectedRoomMembers,
    selectedRoomMessages,
    initialRoomMemberStatus,
    activeRoomCountsByPersona,
    refreshRooms,
    loadRoomDetail,
    selectRoom,
    createRoomFlow,
    handleCreateRoom,
    startSelectedRoom,
    stopSelectedRoom,
    addMemberToSelectedRoom,
    deleteSelectedRoom,
    removeMemberFromSelectedRoom,
    toggleMemberPauseInSelectedRoom,
    sendMessageToSelectedRoom,
    showCreateRoomModal,
    setShowCreateRoomModal,
  } = useRoomManagement(handleRoomSelect);

  const selectedRoom = selectedRoomId
    ? rooms.find((room) => room.id === selectedRoomId) || null
    : null;

  const {
    messages: liveRoomMessages,
    memberStatus: liveMemberStatus,
    runStatus: liveRunStatus,
    interventions: liveInterventions,
    metrics: liveMetrics,
  } = useRoomSync(selectedRoomId, selectedRoomMessages);

  const mergedMemberStatus = { ...initialRoomMemberStatus, ...liveMemberStatus };

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

  const handleSelectRoom = useCallback(
    (roomId: string) => {
      selectRoom(roomId, dirty);
      setDirty(false);
    },
    [selectRoom, dirty, setDirty],
  );

  // Effects
  useEffect(() => {
    refreshRooms();
    loadPipelineModels();
  }, [refreshRooms, loadPipelineModels]);

  useEffect(() => {
    if (!selectedRoomId) {
      return;
    }
    loadRoomDetail(selectedRoomId);
  }, [selectedRoomId, loadRoomDetail]);

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
        roomsLoading={roomsLoading}
        rooms={rooms}
        selectedRoomId={selectedRoomId}
        onSelectRoom={handleSelectRoom}
        roomCreating={roomCreating}
        onCreateRoomFlow={createRoomFlow}
      />

      {/* ── Right Panel: Editor ───────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        {selectedRoomId ? (
          <RoomDetailPanel
            room={selectedRoom}
            state={selectedRoomState}
            members={selectedRoomMembers}
            messages={liveRoomMessages}
            memberStatus={mergedMemberStatus}
            activeRoomCountsByPersona={activeRoomCountsByPersona}
            liveRunStatus={liveRunStatus}
            interventions={liveInterventions}
            metrics={liveMetrics}
            personas={personas}
            loading={roomsLoading}
            onStart={startSelectedRoom}
            onStop={stopSelectedRoom}
            onRefresh={async () => {
              if (selectedRoomId) {
                await Promise.all([loadRoomDetail(selectedRoomId), refreshRooms()]);
              }
            }}
            onDelete={deleteSelectedRoom}
            onAddMember={addMemberToSelectedRoom}
            onRemoveMember={removeMemberFromSelectedRoom}
            onToggleMemberPause={toggleMemberPauseInSelectedRoom}
            onSendMessage={sendMessageToSelectedRoom}
          />
        ) : !selectedPersona ? (
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
          />
        )}
      </div>

      <CreateRoomModal
        open={showCreateRoomModal}
        creating={roomCreating}
        onClose={() => setShowCreateRoomModal(false)}
        onCreate={handleCreateRoom}
      />
    </div>
  );
};

export default PersonasView;
