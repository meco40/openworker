import { describe, it, expect, beforeEach } from 'vitest';

import { SqliteRoomRepository } from '@/server/rooms/sqliteRoomRepository';

describe('SqliteRoomRepository', () => {
  let repo: SqliteRoomRepository;

  beforeEach(() => {
    repo = new SqliteRoomRepository(':memory:');
  });

  it('creates and lists rooms scoped by user', () => {
    const roomA = repo.createRoom({
      userId: 'user-a',
      name: 'Office',
      goalMode: 'planning',
      routingProfileId: 'p1',
    });
    repo.createRoom({
      userId: 'user-b',
      name: 'Home',
      goalMode: 'simulation',
      routingProfileId: 'p1',
    });

    expect(roomA.id).toBeTruthy();
    expect(repo.listRooms('user-a')).toHaveLength(1);
    expect(repo.listRooms('user-b')).toHaveLength(1);
    expect(repo.listRooms('user-a')[0]?.name).toBe('Office');
  });

  it('adds room members and prevents duplicate persona membership per room', () => {
    const room = repo.createRoom({
      userId: 'user-a',
      name: 'Office',
      goalMode: 'planning',
      routingProfileId: 'p1',
    });

    repo.addMember(room.id, 'persona-1', 'Lead Analyst', 1, 'grok-4');
    expect(repo.listMembers(room.id)).toHaveLength(1);

    expect(() => repo.addMember(room.id, 'persona-1', 'Lead Analyst', 1, 'grok-4')).toThrow();
  });

  it('stores room messages with monotonic sequence and supports beforeSeq pagination', () => {
    const room = repo.createRoom({
      userId: 'user-a',
      name: 'Home',
      goalMode: 'simulation',
      routingProfileId: 'p1',
    });

    const m1 = repo.appendMessage({
      roomId: room.id,
      speakerType: 'persona',
      speakerPersonaId: 'p1',
      content: 'Hallo',
      metadata: {},
    });
    repo.appendMessage({
      roomId: room.id,
      speakerType: 'persona',
      speakerPersonaId: 'p2',
      content: 'Hi',
      metadata: {},
    });
    repo.appendMessage({
      roomId: room.id,
      speakerType: 'persona',
      speakerPersonaId: 'p3',
      content: 'Wie gehts?',
      metadata: {},
    });

    expect(m1.seq).toBe(1);

    const page = repo.listMessages(room.id, 50, 3);
    expect(page.map((m) => m.content)).toEqual(['Hallo', 'Hi']);
  });

  it('stores room run lease, member runtime, persona sessions, and persona context', () => {
    const room = repo.createRoom({
      userId: 'user-a',
      name: 'Office',
      goalMode: 'planning',
      routingProfileId: 'p1',
    });
    repo.addMember(room.id, 'persona-1', 'Lead Analyst', 1, 'grok-4');

    const run = repo.acquireRoomLease(
      room.id,
      'scheduler-a',
      new Date(Date.now() + 30_000).toISOString(),
    );
    expect(run.roomId).toBe(room.id);
    expect(run.leaseOwner).toBe('scheduler-a');
    expect(run.runState).toBe('running');

    const heartbeat = repo.heartbeatRoomLease(
      room.id,
      run.id,
      'scheduler-a',
      new Date(Date.now() + 45_000).toISOString(),
    );
    expect(heartbeat.leaseOwner).toBe('scheduler-a');

    repo.upsertMemberRuntime({
      roomId: room.id,
      personaId: 'persona-1',
      status: 'busy',
      busyReason: 'Busy: am Kochen',
      busyUntil: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
      currentTask: 'cook',
    });
    const runtimeState = repo.getMemberRuntime(room.id, 'persona-1');
    expect(runtimeState?.status).toBe('busy');
    expect(runtimeState?.busyReason).toContain('Kochen');

    repo.upsertPersonaSession(room.id, 'persona-1', {
      providerId: 'xai',
      model: 'grok-4',
      sessionId: 'sess-1',
      lastSeenRoomSeq: 5,
    });
    const session = repo.getPersonaSession(room.id, 'persona-1');
    expect(session?.sessionId).toBe('sess-1');
    expect(session?.lastSeenRoomSeq).toBe(5);

    repo.upsertPersonaContext(room.id, 'persona-1', {
      summary: 'Nadine war in der Schule',
      lastMessageSeq: 5,
    });
    const context = repo.getPersonaContext(room.id, 'persona-1');
    expect(context?.summary).toContain('Nadine');
    expect(context?.lastMessageSeq).toBe(5);
  });

  it('supports paused member runtime status', () => {
    const room = repo.createRoom({
      userId: 'user-a',
      name: 'Office',
      goalMode: 'planning',
      routingProfileId: 'p1',
    });
    repo.addMember(room.id, 'persona-1', 'Lead Analyst', 1, null);

    const runtime = repo.upsertMemberRuntime({
      roomId: room.id,
      personaId: 'persona-1',
      status: 'paused',
      busyReason: 'Paused by user',
    });
    expect(runtime.status).toBe('paused');
    expect(runtime.busyReason).toContain('Paused');
  });

  it('stores per-persona thread messages and supports room message sync cursors', () => {
    const room = repo.createRoom({
      userId: 'user-a',
      name: 'Office',
      goalMode: 'planning',
      routingProfileId: 'p1',
    });

    const m1 = repo.appendMessage({
      roomId: room.id,
      speakerType: 'user',
      content: 'Hello',
      metadata: {},
    });
    repo.appendMessage({
      roomId: room.id,
      speakerType: 'persona',
      speakerPersonaId: 'persona-2',
      content: 'Hi there',
      metadata: {},
    });
    repo.appendMessage({
      roomId: room.id,
      speakerType: 'system',
      content: 'Reminder',
      metadata: {},
    });

    const afterFirst = repo.listMessagesAfterSeq(room.id, m1.seq, 10);
    expect(afterFirst).toHaveLength(2);
    expect(afterFirst[0]?.content).toBe('Hi there');

    repo.appendPersonaThreadMessage({
      roomId: room.id,
      personaId: 'persona-1',
      role: 'system',
      content: 'You are Persona 1',
    });
    repo.appendPersonaThreadMessage({
      roomId: room.id,
      personaId: 'persona-1',
      role: 'assistant',
      content: 'resp-1',
    });

    const thread = repo.listPersonaThreadMessages(room.id, 'persona-1', 10);
    expect(thread).toHaveLength(2);
    expect(thread[0]?.role).toBe('system');
    expect(thread[1]?.content).toBe('resp-1');
  });
});
