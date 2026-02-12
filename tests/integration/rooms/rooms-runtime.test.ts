import { describe, expect, it } from 'vitest';

import { RoomOrchestrator } from '../../../src/server/rooms/orchestrator';
import { SqliteRoomRepository } from '../../../src/server/rooms/sqliteRoomRepository';

describe('rooms runtime orchestrator', () => {
  it('processes running rooms and appends a proactive room message', async () => {
    const repo = new SqliteRoomRepository(':memory:');
    const room = repo.createRoom({
      userId: 'user-a',
      name: 'Office',
      goalMode: 'planning',
      routingProfileId: 'p1',
    });
    repo.addMember(room.id, 'persona-1', 'Researcher', 1, 'grok-4');
    repo.updateRunState(room.id, 'running');
    repo.setPersonaPermissions('persona-1', { tools: { search: true } });

    const orchestrator = new RoomOrchestrator(repo, {
      instanceId: 'scheduler-a',
      activeModelsByProfile: { p1: ['grok-4'] },
    });
    const result = await orchestrator.runOnce();

    expect(result.processedRooms).toBe(1);
    const messages = repo.listMessages(room.id, 10);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.speakerType).toBe('persona');
    expect(messages[0]?.content).toContain('Tool executed');
  });

  it('acquires lease for running room and records the active run', async () => {
    const repo = new SqliteRoomRepository(':memory:');
    const room = repo.createRoom({
      userId: 'user-a',
      name: 'Office',
      goalMode: 'planning',
      routingProfileId: 'p1',
    });
    repo.addMember(room.id, 'persona-1', 'Researcher', 1, 'grok-4');
    repo.updateRunState(room.id, 'running');
    repo.setPersonaPermissions('persona-1', { tools: { search: false } });

    const orchestrator = new RoomOrchestrator(repo, {
      instanceId: 'scheduler-a',
      activeModelsByProfile: { p1: ['grok-4'] },
    });
    await orchestrator.runOnce();

    const activeRun = repo.getActiveRoomRun(room.id);
    expect(activeRun).toBeTruthy();
    expect(activeRun?.leaseOwner).toBe('scheduler-a');
    expect(activeRun?.runState).toBe('running');
  });

  it('skips room when lease is currently held by another scheduler instance', async () => {
    const repo = new SqliteRoomRepository(':memory:');
    const room = repo.createRoom({
      userId: 'user-a',
      name: 'Office',
      goalMode: 'planning',
      routingProfileId: 'p1',
    });
    repo.addMember(room.id, 'persona-1', 'Researcher', 1, 'grok-4');
    repo.updateRunState(room.id, 'running');
    repo.acquireRoomLease(room.id, 'scheduler-b', new Date(Date.now() + 120_000).toISOString());

    const orchestrator = new RoomOrchestrator(repo, {
      instanceId: 'scheduler-a',
      activeModelsByProfile: { p1: ['grok-4'] },
    });
    const result = await orchestrator.runOnce();

    expect(result.processedRooms).toBe(0);
    expect(repo.listMessages(room.id, 20)).toHaveLength(0);
  });

  it('marks run degraded when no model can be resolved for any member', async () => {
    const repo = new SqliteRoomRepository(':memory:');
    const room = repo.createRoom({
      userId: 'user-a',
      name: 'Office',
      goalMode: 'planning',
      routingProfileId: 'p-office',
    });
    repo.addMember(room.id, 'persona-1', 'Researcher', 1, 'grok-4');
    repo.updateRunState(room.id, 'running');

    const orchestrator = new RoomOrchestrator(repo, {
      instanceId: 'scheduler-a',
      activeModelsByProfile: {},
    });
    await orchestrator.runOnce();

    const updated = repo.getRoom(room.id);
    expect(updated?.runState).toBe('degraded');
  });
});
