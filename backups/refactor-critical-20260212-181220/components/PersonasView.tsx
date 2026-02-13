'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { usePersona } from '../src/modules/personas/PersonaContext';
import type { PersonaWithFiles, PersonaFileName } from '../src/server/personas/personaTypes';
import { PERSONA_FILE_NAMES } from '../src/server/personas/personaTypes';
import type { PersonaTemplate } from '../lib/persona-templates';
import { RoomDetailPanel } from '../src/modules/rooms/components/RoomDetailPanel';
import { CreateRoomModal } from '../src/modules/rooms/components/CreateRoomModal';
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

// ─── File tab labels ─────────────────────────────────────────
const FILE_LABELS: Record<PersonaFileName, string> = {
  'SOUL.md': 'Soul',
  'IDENTITY.md': 'Identity',
  'AGENTS.md': 'Agents',
  'USER.md': 'User',
  'TOOLS.md': 'Tools',
  'HEARTBEAT.md': 'Heartbeat',
};

const PersonasView: React.FC = () => {
  const { personas, activePersonaId, setActivePersonaId, refreshPersonas, loading } = usePersona();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedPersona, setSelectedPersona] = useState<PersonaWithFiles | null>(null);
  const [activeFile, setActiveFile] = useState<PersonaFileName>('SOUL.md');
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

  // ─── Load persona detail ──────────────────────────────────
  const loadPersona = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/personas/${id}`);
        if (res.ok) {
          const data = await res.json();
          const p = data.persona as PersonaWithFiles;
          setSelectedPersona(p);
          // Load current file content
          setEditorContent(p.files[activeFile] ?? '');
          setDirty(false);
        }
      } catch {
        /* ignore */
      }
    },
    [activeFile],
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

  // ─── On selectedId or activeFile change, re-load ──────────
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
  }, [refreshRooms]);

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
    if (selectedPersona) {
      setEditorContent(selectedPersona.files[activeFile] ?? '');
      setDirty(false);
    }
  }, [activeFile, selectedPersona]);

  // ─── Save file ────────────────────────────────────────────
  const saveFile = useCallback(async () => {
    if (!selectedId) return;
    setSaving(true);
    try {
      await fetch(`/api/personas/${selectedId}/files/${activeFile}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: editorContent }),
      });
      setDirty(false);
      // Update local cache
      if (selectedPersona) {
        const updatedFiles = { ...selectedPersona.files, [activeFile]: editorContent };
        setSelectedPersona({ ...selectedPersona, files: updatedFiles });
      }
    } catch {
      /* ignore */
    } finally {
      setSaving(false);
    }
  }, [selectedId, activeFile, editorContent, selectedPersona]);

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
      if ((e.ctrlKey || e.metaKey) && e.key === 's' && dirty && selectedId) {
        e.preventDefault();
        saveFile();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [dirty, selectedId, saveFile]);

  return (
    <div className="animate-in fade-in flex h-full duration-500">
      {/* ── Left Panel: Personas + Rooms combined ─────────── */}
      <div className="flex w-72 shrink-0 flex-col border-r border-zinc-800">
        {/* Personas Section */}
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

          {/* Quick-create without template */}
          {showTemplates && (
            <div className="mb-3 space-y-2 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
              <button
                onClick={() => createPersona('Neue Persona', '🤖', '')}
                disabled={creating}
                className="w-full rounded-lg bg-zinc-800 px-3 py-2 text-left text-sm text-white transition-colors hover:bg-zinc-700"
              >
                ✨ Leere Persona erstellen
              </button>
              <div className="mt-2 mb-1 text-[9px] font-black tracking-widest text-zinc-500 uppercase">
                Vorlagen
              </div>
              {templates.map((t) => (
                <button
                  key={t.id}
                  onClick={async () => {
                    // Fetch full template with files
                    const { PERSONA_TEMPLATES } = await import('../lib/persona-templates');
                    const full = PERSONA_TEMPLATES.find((pt) => pt.id === t.id);
                    createPersona(t.name, t.emoji, t.vibe, full?.files);
                  }}
                  disabled={creating}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-zinc-300 transition-colors hover:bg-zinc-800"
                >
                  <span>{t.emoji}</span>
                  <span>{t.name}</span>
                  <span className="ml-auto text-[10px] text-zinc-600">{t.vibe}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Persona list */}
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
          {personas.map((p) => (
            <button
              key={p.id}
              onClick={() => selectPersona(p.id)}
              className={`group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-all ${
                selectedId === p.id
                  ? 'border border-indigo-500/30 bg-indigo-600/20 text-white'
                  : 'border border-transparent text-zinc-400 hover:bg-zinc-800/60 hover:text-white'
              }`}
            >
              <span className="text-lg">{p.emoji}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{p.name}</div>
                {p.vibe && <div className="truncate text-[10px] text-zinc-500">{p.vibe}</div>}
              </div>
              {activePersonaId === p.id && (
                <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" title="Aktiv" />
              )}
            </button>
          ))}
        </div>

        {/* Rooms Section */}
        <div
          className="flex min-h-0 flex-col border-t border-zinc-800"
          style={{ maxHeight: '45%' }}
        >
          <div className="border-b border-zinc-800 p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-black tracking-widest text-white uppercase">Rooms</h2>
              <button
                onClick={createRoomFlow}
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
                onClick={() => selectRoom(room.id)}
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
          <>
            {/* Persona Header */}
            <div className="flex items-center gap-4 border-b border-zinc-800 p-4">
              {editingMeta ? (
                <div className="flex flex-1 items-center gap-3">
                  <input
                    value={metaEmoji}
                    onChange={(e) => setMetaEmoji(e.target.value)}
                    className="w-12 rounded-lg border border-zinc-700 bg-zinc-900 p-1 text-center text-lg"
                    maxLength={4}
                  />
                  <input
                    value={metaName}
                    onChange={(e) => setMetaName(e.target.value)}
                    className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-white"
                    placeholder="Name"
                  />
                  <input
                    value={metaVibe}
                    onChange={(e) => setMetaVibe(e.target.value)}
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
                    <h3 className="truncate text-lg font-bold text-white">
                      {selectedPersona.name}
                    </h3>
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

                  {/* Activate / Deactivate Button */}
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

            {/* File Tabs */}
            <div className="flex overflow-x-auto border-b border-zinc-800 px-4">
              {PERSONA_FILE_NAMES.map((fname) => (
                <button
                  key={fname}
                  onClick={() => {
                    if (dirty && !window.confirm('Ungespeicherte Änderungen verwerfen?')) return;
                    setActiveFile(fname);
                  }}
                  className={`border-b-2 px-4 py-2.5 text-xs font-bold tracking-wider whitespace-nowrap uppercase transition-colors ${
                    activeFile === fname
                      ? 'border-indigo-500 text-indigo-400'
                      : 'border-transparent text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  {FILE_LABELS[fname]}
                </button>
              ))}
            </div>

            {/* Editor */}
            <div className="relative flex-1">
              <textarea
                value={editorContent}
                onChange={(e) => {
                  setEditorContent(e.target.value);
                  setDirty(true);
                }}
                className="absolute inset-0 h-full w-full resize-none bg-zinc-950 p-6 font-mono text-sm leading-relaxed text-zinc-200 placeholder:text-zinc-700 focus:outline-none"
                placeholder={`# ${FILE_LABELS[activeFile]}\n\nSchreibe hier die ${FILE_LABELS[activeFile]}-Definition für deine Persona...`}
                spellCheck={false}
              />
            </div>

            {/* Bottom Bar */}
            <div className="flex items-center justify-between border-t border-zinc-800 bg-zinc-900/40 px-4 py-2">
              <div className="font-mono text-[10px] text-zinc-600">
                {activeFile}
                {dirty && <span className="ml-2 text-amber-500">● Ungespeichert</span>}
              </div>
              <div className="flex items-center gap-3">
                <span className="text-[10px] text-zinc-600">{editorContent.length} Zeichen</span>
                <button
                  onClick={saveFile}
                  disabled={!dirty || saving}
                  className={`rounded-lg px-4 py-1.5 text-xs font-bold tracking-wider uppercase transition-all ${
                    dirty
                      ? 'bg-indigo-600 text-white hover:bg-indigo-500'
                      : 'cursor-not-allowed bg-zinc-800 text-zinc-600'
                  }`}
                >
                  {saving ? 'Speichern...' : 'Speichern'}
                </button>
              </div>
            </div>
          </>
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
