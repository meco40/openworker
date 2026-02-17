'use client';

import { useCallback, useState } from 'react';
import type {
  RoomSummary,
  RoomState,
  RoomMember,
  RoomMessage,
  RoomMemberStatus,
} from '../../../src/modules/rooms/types';
import {
  addRoomMember,
  createRoom,
  deleteRoom,
  getActiveRoomCountsByPersona,
  getRoomMessages,
  getRoomState,
  listRooms,
  removeRoomMember,
  sendRoomMessage,
  setRoomMemberPaused,
  startRoom,
  stopRoom,
} from '../../../src/modules/rooms/api';

interface UseRoomManagementReturn {
  rooms: RoomSummary[];
  setRooms: (rooms: RoomSummary[]) => void;
  roomsLoading: boolean;
  roomCreating: boolean;
  selectedRoomId: string | null;
  setSelectedRoomId: (id: string | null) => void;
  selectedRoomState: RoomState | null;
  selectedRoomMembers: RoomMember[];
  selectedRoomMessages: RoomMessage[];
  initialRoomMemberStatus: Record<string, RoomMemberStatus>;
  activeRoomCountsByPersona: Record<string, number>;
  refreshRooms: () => Promise<void>;
  loadRoomDetail: (roomId: string) => Promise<void>;
  selectRoom: (roomId: string, dirty: boolean) => boolean;
  createRoomFlow: () => Promise<void>;
  handleCreateRoom: (input: {
    name: string;
    description: string | null;
    goalMode: 'planning' | 'simulation' | 'free';
    routingProfileId: string;
  }) => Promise<void>;
  startSelectedRoom: () => Promise<void>;
  stopSelectedRoom: () => Promise<void>;
  addMemberToSelectedRoom: (
    personaId: string,
    roleLabel: string,
    modelOverride: string,
  ) => Promise<void>;
  deleteSelectedRoom: () => Promise<void>;
  removeMemberFromSelectedRoom: (personaId: string) => Promise<void>;
  toggleMemberPauseInSelectedRoom: (personaId: string, paused: boolean) => Promise<void>;
  sendMessageToSelectedRoom: (content: string) => Promise<void>;
  showCreateRoomModal: boolean;
  setShowCreateRoomModal: (show: boolean) => void;
}

export function useRoomManagement(onRoomSelect?: () => void): UseRoomManagementReturn {
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
  const [showCreateRoomModal, setShowCreateRoomModal] = useState(false);

  const refreshRooms = useCallback(async () => {
    setRoomsLoading(true);
    try {
      const [items, counts] = await Promise.all([
        listRooms(),
        getActiveRoomCountsByPersona().catch(() => ({}) as Record<string, number>),
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
    (roomId: string, dirty: boolean): boolean => {
      if (dirty && !window.confirm('Ungespeicherte Änderungen verwerfen?')) return false;
      setSelectedRoomId(roomId);
      onRoomSelect?.();
      return true;
    },
    [onRoomSelect],
  );

  const createRoomFlow = useCallback(async () => {
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

  return {
    rooms,
    setRooms,
    roomsLoading,
    roomCreating,
    selectedRoomId,
    setSelectedRoomId,
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
  };
}
