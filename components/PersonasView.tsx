'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { usePersona } from '../src/modules/personas/PersonaContext';
import type { PersonaWithFiles, PersonaTabName } from '../src/server/personas/personaTypes';
import type { PersonaTemplate } from '../lib/persona-templates';
import { RoomDetailPanel } from '../src/modules/rooms/components/RoomDetailPanel';
import { CreateRoomModal } from '../src/modules/rooms/components/CreateRoomModal';
import { PersonasSidebar } from './personas/PersonasSidebar';
import { PersonaEditorPane } from './personas/PersonaEditorPane';
import {
  addRoomMember,
  createRoom,
  deleteRoom,
  getActiveRoomCountsByPersona,
  getRoomMessages,
  getRoomState,
  listRooms,
  removeRoomMember,
  setRoomMemberPaused,
  sendRoomMessage,
  startRoom,
  stopRoom,
} from '../src/modules/rooms/api';
import { useRoomSync } from '../src/modules/rooms/useRoomSync';
import type {
  RoomMember,
  RoomState,
  RoomSummary,
  RoomMessage,
  RoomMemberStatus,
} from '../src/modules/rooms/types';

interface PipelineModel {
  id: string;
  accountId: string;
  providerId: string;
  modelName: string;
  status: 'active' | 'rate-limited' | 'offline';
  priority: number;
}

const PersonasView: React.FC = () => {
  const { personas, activePersonaId, setActivePersonaId, refreshPersonas, loading } = usePersona();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedPersona, setSelectedPersona] = useState<PersonaWithFiles | null>(null);
  const [activeTab, setActiveTab] = useState<PersonaTabName>('SOUL.md');
  const [editorContent, setEditorContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [creating, setCreating] = useState(false);
  const [templates, setTemplates] = useState<PersonaTemplate[]>([]);
  const [showTemplates, setShowTemplates] = useState(false);
  const [editingMeta, setEditingMeta] = useState(false);
  const [metaName, setMetaName] = useState('');
  const [metaEmoji, setMetaEmoji] = useState('');
  const [metaVibe, setMetaVibe] = useState('');
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [roomsLoading, setRoomsLoading] = useState(false);
  const [roomCreating, setRoomCreating] = useState(false);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [selectedRoomState, setSelectedRoomState] = useState<RoomState | null>(null);
  const [selectedRoomMembers, setSelectedRoomMembers] = useState<RoomMember[]>([]);
  const [selectedRoomMessages, setSelectedRoomMessages] = useState<RoomMessage[]>([]);
  const [initialRoomMemberStatus, setInitialRoomMemberStatus] = useState<
    Record<string, RoomMemberStatus>
  >({});
  const [activeRoomCountsByPersona, setActiveRoomCountsByPersona] = useState<
    Record<string, number>
  >({});

  // Gateway state
  const [pipelineModels, setPipelineModels] = useState<PipelineModel[]>([]);
  const [preferredModelId, setPreferredModelId] = useState<string | null>(null);
  const [savingPreferredModel, setSavingPreferredModel] = useState(false);

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

  // ─── Load pipeline models ─────────────────────────────────
  const loadPipelineModels = useCallback(async () => {
    try {
      const res = await fetch('/api/model-hub/pipeline');
      if (res.ok) {
        const data = await res.json();
        setPipelineModels(data.models ?? []);
      }
    } catch {
      /* ignore */
    }
  }, []);

  // ─── Load persona detail ──────────────────────────────────
  const loadPersona = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/personas/${id}`);
        if (res.ok) {
          const data = await res.json();
          const p = data.persona as PersonaWithFiles;
          setSelectedPersona(p);
          setPreferredModelId(p.preferredModelId ?? null);
          // Load current file content if not on gateway tab
          if (activeTab !== 'GATEWAY') {
            setEditorContent(p.files[activeTab] ?? '');
          }
          setDirty(false);
        }
      } catch {
        /* ignore */
      }
    },
    [activeTab],
  );

  const refreshRooms = useCallback(async () => {
    setRoomsLoading(true);
    try {
      const [items, counts] = await Promise.all([
        listRooms(),
        getActiveRoomCountsByPersona().catch(() => ({})),
      ]);
      setRooms(items);
      setActiveRoomCountsByPersona(counts);
    } catch {
      /* ignore */
    } finally {
      setRoomsLoading(false);
    }
  }, []);

  const loadRoomDetail = useCallback(async (roomId: string) => {
    try {
      const [statePayload, messages] = await Promise.all([
        getRoomState(roomId),
        getRoomMessages(roomId, 120),
      ]);
      setSelectedRoomState(statePayload.state);
      setSelectedRoomMembers(statePayload.members);
      setSelectedRoomMessages(messages);
      const initialStatus: Record<string, RoomMemberStatus> = {};
      for (const status of statePayload.memberRuntime) {
        initialStatus[status.personaId] = status;
      }
      setInitialRoomMemberStatus(initialStatus);
    } catch {
      /* ignore */
    }
  }, []);

  const selectRoom = useCallback(
    (roomId: string) => {
      if (dirty && !window.confirm('Ungespeicherte Änderungen verwerfen?')) return;
      setSelectedRoomId(roomId);
      setSelectedId(null);
      setSelectedPersona(null);
      setDirty(false);
      setEditingMeta(false);
    },
    [dirty],
  );

  const [showCreateRoomModal, setShowCreateRoomModal] = useState(false);

  const createRoomFlow = useCallback(() => {
    setShowCreateRoomModal(true);
  }, []);

  const handleCreateRoom = useCallback(
    async (input: {
      name: string;
      description: string | null;
      goalMode: 'planning' | 'simulation' | 'free';
      routingProfileId: string;
    }) => {
      setRoomCreating(true);
      try {
        const room = await createRoom(input);
        await refreshRooms();
        setSelectedRoomId(room.id);
        setSelectedId(null);
        setShowCreateRoomModal(false);
      } catch {
        /* ignore */
      } finally {
        setRoomCreating(false);
      }
    },
    [refreshRooms],
  );

  const startSelectedRoom = useCallback(async () => {
    if (!selectedRoomId) return;
    try {
      await startRoom(selectedRoomId);
      await Promise.all([loadRoomDetail(selectedRoomId), refreshRooms()]);
    } catch {
      /* ignore */
    }
  }, [selectedRoomId, loadRoomDetail, refreshRooms]);

  const stopSelectedRoom = useCallback(async () => {
    if (!selectedRoomId) return;
    try {
      await stopRoom(selectedRoomId);
      await Promise.all([loadRoomDetail(selectedRoomId), refreshRooms()]);
    } catch {
      /* ignore */
    }
  }, [selectedRoomId, loadRoomDetail, refreshRooms]);

  const addMemberToSelectedRoom = useCallback(
    async (personaId: string, roleLabel: string, modelOverride: string) => {
      if (!selectedRoomId) return;
      try {
        await addRoomMember(selectedRoomId, {
          personaId,
          roleLabel,
          modelOverride: modelOverride || null,
        });
        await loadRoomDetail(selectedRoomId);
      } catch {
        /* ignore */
      }
    },
    [selectedRoomId, loadRoomDetail],
  );

  const deleteSelectedRoom = useCallback(async () => {
    if (!selectedRoomId) return;
    if (!window.confirm('Room endgültig löschen?')) return;
    try {
      await deleteRoom(selectedRoomId);
      setSelectedRoomId(null);
      setSelectedRoomState(null);
      setSelectedRoomMembers([]);
      setSelectedRoomMessages([]);
      setInitialRoomMemberStatus({});
      await refreshRooms();
    } catch {
      /* ignore */
    }
  }, [selectedRoomId, refreshRooms]);

  const removeMemberFromSelectedRoom = useCallback(
    async (personaId: string) => {
      if (!selectedRoomId) return;
      try {
        await removeRoomMember(selectedRoomId, personaId);
        await loadRoomDetail(selectedRoomId);
      } catch {
        /* ignore */
      }
    },
    [selectedRoomId, loadRoomDetail],
  );

  const toggleMemberPauseInSelectedRoom = useCallback(
    async (personaId: string, paused: boolean) => {
      if (!selectedRoomId) return;
      try {
        await setRoomMemberPaused(selectedRoomId, personaId, paused);
        await loadRoomDetail(selectedRoomId);
      } catch {
        /* ignore */
      }
    },
    [selectedRoomId, loadRoomDetail],
  );

  const sendMessageToSelectedRoom = useCallback(
    async (content: string) => {
      if (!selectedRoomId) return;
      try {
        await sendRoomMessage(selectedRoomId, content);
      } catch {
        /* ignore */
      }
    },
    [selectedRoomId],
  );

  // ─── Select persona ───────────────────────────────────────
  const selectPersona = useCallback(
    (id: string) => {
      if (dirty && !window.confirm('Ungespeicherte Änderungen verwerfen?')) return;
      setSelectedId(id);
      setSelectedRoomId(null);
      setDirty(false);
      setEditingMeta(false);
    },
    [dirty],
  );

  // ─── On selectedId or activeTab change, re-load ──────────
  useEffect(() => {
    if (selectedId) {
      loadPersona(selectedId);
    } else {
      setSelectedPersona(null);
      setEditorContent('');
    }
  }, [selectedId, loadPersona]);

  useEffect(() => {
    refreshRooms();
    loadPipelineModels();
  }, [refreshRooms, loadPipelineModels]);

  useEffect(() => {
    if (!selectedRoomId) {
      setSelectedRoomState(null);
      setSelectedRoomMembers([]);
      setSelectedRoomMessages([]);
      setInitialRoomMemberStatus({});
      return;
    }
    loadRoomDetail(selectedRoomId);
  }, [selectedRoomId, loadRoomDetail]);

  // ─── When switching file tabs ─────────────────────────────
  useEffect(() => {
    if (selectedPersona && activeTab !== 'GATEWAY') {
      setEditorContent(selectedPersona.files[activeTab] ?? '');
      setDirty(false);
    }
  }, [activeTab, selectedPersona]);

  // ─── Save file ────────────────────────────────────────────
  const saveFile = useCallback(async () => {
    if (!selectedId || activeTab === 'GATEWAY') return;
    setSaving(true);
    try {
      await fetch(`/api/personas/${selectedId}/files/${activeTab}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: editorContent }),
      });
      setDirty(false);
      // Update local cache
      if (selectedPersona) {
        const updatedFiles = { ...selectedPersona.files, [activeTab]: editorContent };
        setSelectedPersona({ ...selectedPersona, files: updatedFiles });
      }
    } catch {
      /* ignore */
    } finally {
      setSaving(false);
    }
  }, [selectedId, activeTab, editorContent, selectedPersona]);

  // ─── Save preferred model ─────────────────────────────────
  const savePreferredModel = useCallback(
    async (modelId: string | null) => {
      if (!selectedId) return;
      setSavingPreferredModel(true);
      try {
        const res = await fetch(`/api/personas/${selectedId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ preferredModelId: modelId }),
        });
        if (res.ok) {
          await refreshPersonas();
          await loadPersona(selectedId);
        }
      } catch {
        /* ignore */
      } finally {
        setSavingPreferredModel(false);
      }
    },
    [selectedId, refreshPersonas, loadPersona],
  );

  // ─── Save metadata ───────────────────────────────────────
  const saveMeta = useCallback(async () => {
    if (!selectedId) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/personas/${selectedId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: metaName, emoji: metaEmoji, vibe: metaVibe }),
      });
      if (res.ok) {
        setEditingMeta(false);
        await refreshPersonas();
        await loadPersona(selectedId);
      }
    } catch {
      /* ignore */
    } finally {
      setSaving(false);
    }
  }, [selectedId, metaName, metaEmoji, metaVibe, refreshPersonas, loadPersona]);

  // ─── Create persona ───────────────────────────────────────
  const createPersona = useCallback(
    async (name: string, emoji: string, vibe: string, files?: Record<string, string>) => {
      setCreating(true);
      try {
        const res = await fetch('/api/personas', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, emoji, vibe, files }),
        });
        if (res.ok) {
          const data = await res.json();
          await refreshPersonas();
          setSelectedId(data.persona.id);
          setShowTemplates(false);
        }
      } catch {
        /* ignore */
      } finally {
        setCreating(false);
      }
    },
    [refreshPersonas],
  );

  // ─── Duplicate persona ─────────────────────────────────────
  const duplicatePersona = useCallback(async () => {
    if (!selectedId || !selectedPersona) return;
    setCreating(true);
    try {
      const res = await fetch('/api/personas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `${selectedPersona.name} Kopie`,
          emoji: selectedPersona.emoji,
          vibe: selectedPersona.vibe,
          files: selectedPersona.files,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        await refreshPersonas();
        setSelectedId(data.persona.id);
      }
    } catch {
      /* ignore */
    } finally {
      setCreating(false);
    }
  }, [selectedId, selectedPersona, refreshPersonas]);

  // ─── Delete persona ───────────────────────────────────────
  const deletePersona = useCallback(async () => {
    if (!selectedId) return;
    if (!window.confirm('Persona endgültig löschen?')) return;
    try {
      await fetch(`/api/personas/${selectedId}`, { method: 'DELETE' });
      if (activePersonaId === selectedId) setActivePersonaId(null);
      setSelectedId(null);
      setSelectedPersona(null);
      await refreshPersonas();
    } catch {
      /* ignore */
    }
  }, [selectedId, activePersonaId, setActivePersonaId, refreshPersonas]);

  // ─── Load templates ───────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/personas/templates');
        if (res.ok) {
          const data = await res.json();
          setTemplates(data.templates ?? []);
        }
      } catch {
        /* ignore */
      }
    })();
  }, []);

  // ─── Start editing metadata ───────────────────────────────
  const startEditMeta = useCallback(() => {
    if (selectedPersona) {
      setMetaName(selectedPersona.name);
      setMetaEmoji(selectedPersona.emoji);
      setMetaVibe(selectedPersona.vibe);
      setEditingMeta(true);
    }
  }, [selectedPersona]);

  // ─── Keyboard shortcuts ───────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's' && dirty && selectedId && activeTab !== 'GATEWAY') {
        e.preventDefault();
        saveFile();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [dirty, selectedId, saveFile, activeTab]);

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
        onSelectRoom={selectRoom}
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
            onRefresh={() => {
              if (selectedRoomId) {
                loadRoomDetail(selectedRoomId);
                refreshRooms();
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
            saving={saving}
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
            onPreferredModelChange={savePreferredModel}
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
