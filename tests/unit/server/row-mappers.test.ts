import { describe, expect, it } from 'vitest';

import {
  toConversation,
  toMessage,
  toChannelBinding,
} from '../../../src/server/channels/messages/messageRowMappers';
import {
  toRoom,
  toMember,
  toRoomMessage,
  toIntervention,
  toRun,
  toMemberRuntime,
  toPersonaSession,
  toPersonaContext,
} from '../../../src/server/rooms/roomRowMappers';
import {
  toRule,
  toRun as toAutomationRun,
  toDeadLetter,
  toLease,
} from '../../../src/server/automation/automationRowMappers';
import {
  toTask,
  toStep,
  toArtifact,
  toApprovalRule,
} from '../../../src/server/worker/workerRowMappers';

describe('repository row mapper modules', () => {
  it('maps channel message repository rows', () => {
    const conversation = toConversation({
      id: 'c1',
      channel_type: 'WebChat',
      external_chat_id: null,
      user_id: '',
      title: 'Hello',
      model_override: null,
      persona_id: null,
      created_at: 'a',
      updated_at: 'b',
    });
    expect(conversation.userId).toBe('legacy-local-user');

    const message = toMessage({
      id: 'm1',
      conversation_id: 'c1',
      seq: 2,
      role: 'agent',
      content: 'x',
      platform: 'WebChat',
      created_at: 'now',
    });
    expect(message.seq).toBe(2);

    const binding = toChannelBinding({
      user_id: 'u',
      channel: 'telegram',
      status: 'active',
      created_at: 'a',
      updated_at: 'b',
    });
    expect(binding.userId).toBe('u');
  });

  it('maps room repository rows', () => {
    expect(
      toRoom({
        id: 'r',
        user_id: 'u',
        name: 'n',
        description: null,
        goal_mode: 'planning',
        routing_profile_id: 'p1',
        run_state: 'running',
        created_at: 'a',
        updated_at: 'b',
      }).id,
    ).toBe('r');

    expect(
      toMember({
        room_id: 'r',
        persona_id: 'p',
        role_label: 'assistant',
        turn_priority: 1,
        model_override: null,
        created_at: 'a',
        updated_at: 'b',
      }).personaId,
    ).toBe('p');

    expect(
      toRoomMessage({
        id: 'rm',
        room_id: 'r',
        seq: 1,
        speaker_type: 'user',
        speaker_persona_id: null,
        content: 'msg',
        metadata_json: '{"x":1}',
        created_at: 'a',
      }).metadata,
    ).toEqual({ x: 1 });

    expect(
      toIntervention({ id: 'i', room_id: 'r', user_id: 'u', note: 'n', created_at: 'a' }).id,
    ).toBe('i');

    expect(
      toRun({
        id: 'run',
        room_id: 'r',
        run_state: 'running',
        lease_owner: null,
        lease_expires_at: null,
        heartbeat_at: null,
        failure_reason: null,
        started_at: 'a',
        ended_at: null,
        created_at: 'a',
        updated_at: 'a',
      }).id,
    ).toBe('run');

    expect(
      toMemberRuntime({
        room_id: 'r',
        persona_id: 'p',
        status: 'idle',
        busy_reason: null,
        busy_until: null,
        current_task: null,
        last_model: null,
        last_profile_id: null,
        last_tool: null,
        updated_at: 'a',
      }).status,
    ).toBe('idle');

    expect(
      toPersonaSession({
        room_id: 'r',
        persona_id: 'p',
        provider_id: 'pr',
        model: 'm',
        session_id: 's',
        updated_at: 'a',
      }).sessionId,
    ).toBe('s');

    expect(
      toPersonaContext({
        room_id: 'r',
        persona_id: 'p',
        summary_text: 'sum',
        last_message_seq: 3,
        updated_at: 'a',
      }).summary,
    ).toBe('sum');
  });

  it('maps automation rows', () => {
    expect(
      toRule({
        id: 'r1',
        user_id: 'u1',
        name: 'n',
        cron_expression: '* * * * *',
        timezone: 'UTC',
        prompt: 'p',
        enabled: 1,
        next_run_at: null,
        last_run_at: null,
        consecutive_failures: 0,
        last_error: null,
        created_at: 'a',
        updated_at: 'b',
      }).enabled,
    ).toBe(true);

    expect(
      toAutomationRun({
        id: 'run1',
        rule_id: 'r1',
        user_id: 'u1',
        trigger_source: 'scheduled',
        scheduled_for: 'a',
        run_key: 'k',
        status: 'queued',
        attempt: 0,
        next_attempt_at: null,
        error_message: null,
        result_summary: null,
        started_at: null,
        finished_at: null,
        created_at: 'a',
      }).runKey,
    ).toBe('k');

    expect(
      toDeadLetter({
        id: 'd',
        run_id: 'run1',
        rule_id: 'r1',
        reason: 'x',
        payload: null,
        created_at: 'a',
      }).reason,
    ).toBe('x');

    expect(
      toLease({
        singleton_key: 'k',
        instance_id: 'i',
        heartbeat_at: 'a',
        updated_at: 'b',
      }).instanceId,
    ).toBe('i');
  });

  it('maps worker rows', () => {
    expect(
      toTask({
        id: 't',
        title: 'task',
        objective: 'obj',
        status: 'queued',
        priority: 'normal',
        origin_platform: 'WebChat',
        origin_conversation: 'c',
        origin_external_chat: null,
        current_step: 0,
        total_steps: 0,
        result_summary: null,
        error_message: null,
        resumable: 1,
        last_checkpoint: null,
        workspace_path: null,
        workspace_type: null,
        created_at: 'a',
        started_at: null,
        completed_at: null,
      }).resumable,
    ).toBe(true);

    expect(
      toStep({
        id: 's',
        task_id: 't',
        step_index: 1,
        description: 'd',
        status: 'pending',
        output: null,
        tool_calls: null,
        started_at: null,
        completed_at: null,
      }).taskId,
    ).toBe('t');

    expect(
      toArtifact({
        id: 'a',
        task_id: 't',
        name: 'n',
        type: 'text',
        content: 'c',
        mime_type: null,
        created_at: 'x',
      }).name,
    ).toBe('n');

    expect(
      toApprovalRule({ id: 'r', command_pattern: '^npm test$', created_at: 'a' }).commandPattern,
    ).toBe('^npm test$');
  });
});
