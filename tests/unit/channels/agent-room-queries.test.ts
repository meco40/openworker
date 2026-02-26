import { beforeEach, describe, expect, it } from 'vitest';
import { ChannelType } from '@/shared/domain/types';
import { SqliteMessageRepository } from '@/server/channels/messages/sqliteMessageRepository';

describe('agent room query module', () => {
  let repo: SqliteMessageRepository;

  beforeEach(() => {
    repo = new SqliteMessageRepository(':memory:');
  });

  it('creates, lists, gets, updates and deletes persisted swarms', () => {
    const conversation = repo.createConversation({
      channelType: ChannelType.WEBCHAT,
      externalChatId: 'agent-room',
      userId: 'user-a',
      title: 'Agent Room',
      personaId: 'persona-lead',
    });

    const created = repo.createAgentRoomSwarm!({
      conversationId: conversation.id,
      userId: 'user-a',
      title: 'Research',
      task: 'Analyze architecture',
      leadPersonaId: 'persona-lead',
      units: [{ personaId: 'persona-lead', role: 'lead' }],
    });
    expect(created.status).toBe('idle');

    const listed = repo.listAgentRoomSwarms!('user-a');
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(created.id);

    const fetched = repo.getAgentRoomSwarm!(created.id, 'user-a');
    expect(fetched?.task).toBe('Analyze architecture');

    const updated = repo.updateAgentRoomSwarm!(created.id, 'user-a', {
      status: 'running',
      currentPhase: 'ideation',
      sessionId: 'session-1',
      holdFlag: false,
      consensusScore: 55,
      artifact: 'Draft artifact',
      artifactHistory: ['Draft artifact'],
      friction: {
        level: 'medium',
        confidence: 50,
        hold: false,
        reasons: ['risk-signals:2'],
        updatedAt: new Date().toISOString(),
      },
      lastSeq: 9,
    });
    expect(updated?.status).toBe('running');
    expect(updated?.currentPhase).toBe('ideation');
    expect(updated?.sessionId).toBe('session-1');

    const deleted = repo.deleteAgentRoomSwarm!(created.id, 'user-a');
    expect(deleted).toBe(true);
    expect(repo.listAgentRoomSwarms!('user-a')).toHaveLength(0);
  });

  it('enforces user scoping for swarm reads/updates/deletes', () => {
    const conversation = repo.createConversation({
      channelType: ChannelType.WEBCHAT,
      externalChatId: 'agent-room-scope',
      userId: 'owner',
      title: 'Agent Room',
      personaId: 'persona-lead',
    });
    const created = repo.createAgentRoomSwarm!({
      conversationId: conversation.id,
      userId: 'owner',
      title: 'Scoped Swarm',
      task: 'Task',
      leadPersonaId: 'persona-lead',
      units: [{ personaId: 'persona-lead', role: 'lead' }],
    });

    expect(repo.getAgentRoomSwarm!(created.id, 'intruder')).toBeNull();
    expect(repo.updateAgentRoomSwarm!(created.id, 'intruder', { status: 'running' })).toBeNull();
    expect(repo.deleteAgentRoomSwarm!(created.id, 'intruder')).toBe(false);
  });

  it('removes swarm rows when conversation is deleted', () => {
    const conversation = repo.createConversation({
      channelType: ChannelType.WEBCHAT,
      externalChatId: 'agent-room-cascade',
      userId: 'user-cascade',
      title: 'Agent Room',
      personaId: 'persona-lead',
    });
    const created = repo.createAgentRoomSwarm!({
      conversationId: conversation.id,
      userId: 'user-cascade',
      title: 'Cascade',
      task: 'Task',
      leadPersonaId: 'persona-lead',
      units: [{ personaId: 'persona-lead', role: 'lead' }],
    });

    expect(repo.getAgentRoomSwarm!(created.id, 'user-cascade')).not.toBeNull();
    repo.deleteConversation(conversation.id, 'user-cascade');
    expect(repo.getAgentRoomSwarm!(created.id, 'user-cascade')).toBeNull();
  });
});
