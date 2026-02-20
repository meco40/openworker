import { describe, expect, it } from 'vitest';
import { ChannelType } from '@/shared/domain/types';
import type { StoredMessage } from '@/server/channels/messages/repository';
import {
  buildAutoMemoryCandidates,
  isAutoSessionMemoryEnabled,
} from '@/server/channels/messages/autoMemory';

function msg(
  role: StoredMessage['role'],
  content: string,
  createdAt = '2026-02-14T10:00:00.000Z',
): StoredMessage {
  return {
    id: `${role}-${createdAt}-${content.slice(0, 8)}`,
    conversationId: 'conv-1',
    seq: 1,
    role,
    content,
    platform: ChannelType.WEBCHAT,
    externalMsgId: null,
    senderName: null,
    metadata: null,
    createdAt,
  };
}

describe('autoMemory candidate builder', () => {
  it('extracts preference and event memory candidates from user messages', () => {
    const candidates = buildAutoMemoryCandidates([
      msg('user', 'Ich trinke Kaffee immer schwarz.'),
      msg('user', 'Morgen um 15:00 habe ich einen Zahnarzttermin.'),
    ]);

    expect(candidates.some((item) => item.type === 'preference')).toBe(true);
    expect(candidates.some((item) => item.type === 'fact')).toBe(true);
  });

  it('skips explicit save trigger content to avoid duplicate auto-store', () => {
    const candidates = buildAutoMemoryCandidates([
      msg('user', 'Speichere ab: Ich trinke Kaffee immer schwarz.'),
    ]);
    expect(candidates).toHaveLength(0);
  });

  it('skips explicit save trigger without colon to avoid duplicate auto-store', () => {
    const candidates = buildAutoMemoryCandidates([
      msg('user', 'Speichere ab Ich trinke Kaffee immer schwarz.'),
    ]);
    expect(candidates).toHaveLength(0);
  });

  it('adds a dated session recap lesson when enough user messages exist', () => {
    const candidates = buildAutoMemoryCandidates([
      msg('user', 'Ich trinke Kaffee schwarz.', '2026-02-10T09:00:00.000Z'),
      msg('user', 'Ich mag Lasagne.', '2026-02-10T09:05:00.000Z'),
      msg('user', 'Morgen habe ich einen Termin.', '2026-02-10T09:10:00.000Z'),
      msg('user', 'Bitte erinnere mich daran.', '2026-02-10T09:12:00.000Z'),
    ]);

    const recap = candidates.find((item) => item.type === 'lesson');
    expect(recap?.content).toContain('Besprochen am 2026-02-10');
  });

  it('treats auto session memory as enabled by default', () => {
    const previous = process.env.CHAT_AUTO_SESSION_MEMORY;
    delete process.env.CHAT_AUTO_SESSION_MEMORY;
    expect(isAutoSessionMemoryEnabled()).toBe(true);
    process.env.CHAT_AUTO_SESSION_MEMORY = previous;
  });

  it('classifies recurring pattern as workflow_pattern with recurrence metadata', () => {
    const candidates = buildAutoMemoryCandidates([
      msg('user', 'Jeden Montag gehe ich ins Fitnessstudio.'),
    ]);

    const pattern = candidates.find((item) => item.type === 'workflow_pattern');
    expect(pattern).toBeDefined();
    expect(pattern!.importance).toBe(4);
  });

  it('detects daily recurrence pattern', () => {
    const candidates = buildAutoMemoryCandidates([
      msg('user', 'Täglich mache ich eine Stunde Yoga.'),
    ]);

    const pattern = candidates.find((item) => item.type === 'workflow_pattern');
    expect(pattern).toBeDefined();
  });

  it('does not classify non-recurring text as workflow_pattern', () => {
    const candidates = buildAutoMemoryCandidates([msg('user', 'Ich war gestern beim Arzt.')]);

    const pattern = candidates.find((item) => item.type === 'workflow_pattern');
    expect(pattern).toBeUndefined();
  });
});
