import type { RoomMemberStatus, RoomMember, RoomMessage, RoomState, RoomSummary } from '@/modules/rooms/types';

export async function listRooms(): Promise<RoomSummary[]> {
  const response = await fetch('/api/rooms');
  if (!response.ok) {
    throw new Error('Failed to load rooms');
  }
  const payload = (await response.json()) as { ok: boolean; rooms?: RoomSummary[] };
  return payload.rooms || [];
}

export async function createRoom(input: {
  name: string;
  description?: string | null;
  goalMode: 'planning' | 'simulation' | 'free';
  routingProfileId: string;
}): Promise<RoomSummary> {
  const response = await fetch('/api/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error('Failed to create room');
  }
  const payload = (await response.json()) as { ok: boolean; room: RoomSummary };
  return payload.room;
}

export async function deleteRoom(roomId: string): Promise<void> {
  const response = await fetch(`/api/rooms/${roomId}`, { method: 'DELETE' });
  if (!response.ok) {
    throw new Error('Failed to delete room');
  }
}

export async function addRoomMember(
  roomId: string,
  input: {
    personaId: string;
    roleLabel: string;
    modelOverride?: string | null;
  },
): Promise<RoomMember> {
  const response = await fetch(`/api/rooms/${roomId}/members`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error('Failed to add room member');
  }
  const payload = (await response.json()) as { ok: boolean; member: RoomMember };
  return payload.member;
}

export async function removeRoomMember(roomId: string, personaId: string): Promise<void> {
  const response = await fetch(`/api/rooms/${roomId}/members/${personaId}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    throw new Error('Failed to remove room member');
  }
}

export async function setRoomMemberPaused(
  roomId: string,
  personaId: string,
  paused: boolean,
): Promise<void> {
  const response = await fetch(`/api/rooms/${roomId}/members/${personaId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paused }),
  });
  if (!response.ok) {
    throw new Error(paused ? 'Failed to pause room member' : 'Failed to resume room member');
  }
}

export async function startRoom(roomId: string): Promise<void> {
  const response = await fetch(`/api/rooms/${roomId}/start`, { method: 'POST' });
  if (!response.ok) {
    throw new Error('Failed to start room');
  }
}

export async function stopRoom(roomId: string): Promise<void> {
  const response = await fetch(`/api/rooms/${roomId}/stop`, { method: 'POST' });
  if (!response.ok) {
    throw new Error('Failed to stop room');
  }
}

export async function getRoomState(roomId: string): Promise<{
  state: RoomState;
  members: RoomMember[];
  memberRuntime: RoomMemberStatus[];
}> {
  const response = await fetch(`/api/rooms/${roomId}/state`);
  if (!response.ok) {
    throw new Error('Failed to load room state');
  }
  const payload = (await response.json()) as {
    ok: boolean;
    state: RoomState;
    members: RoomMember[];
    memberRuntime?: RoomMemberStatus[];
  };
  return {
    state: payload.state,
    members: payload.members || [],
    memberRuntime: payload.memberRuntime || [],
  };
}

export async function getRoomMessages(roomId: string, limit = 100): Promise<RoomMessage[]> {
  const response = await fetch(`/api/rooms/${roomId}/messages?limit=${limit}`);
  if (!response.ok) {
    throw new Error('Failed to load room messages');
  }
  const payload = (await response.json()) as { ok: boolean; messages: RoomMessage[] };
  return payload.messages || [];
}

export async function getActiveRoomCountsByPersona(): Promise<Record<string, number>> {
  const response = await fetch('/api/rooms/membership-counts');
  if (!response.ok) {
    throw new Error('Failed to load active room counts');
  }
  const payload = (await response.json()) as { ok: boolean; counts: Record<string, number> };
  return payload.counts || {};
}

export async function sendRoomMessage(roomId: string, content: string): Promise<RoomMessage> {
  const response = await fetch(`/api/rooms/${roomId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!response.ok) {
    throw new Error('Failed to send message');
  }
  const payload = (await response.json()) as { ok: boolean; message: RoomMessage };
  return payload.message;
}
