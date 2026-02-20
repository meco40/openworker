import { describe, expect, it } from 'vitest';
import { upsertRoomMessage } from '@/modules/rooms/useRoomSync';
import type { RoomMessage } from '@/modules/rooms/types';

function message(seq: number, overrides: Partial<RoomMessage> = {}): RoomMessage {
  return {
    id: `m-${seq}`,
    roomId: 'room-1',
    seq,
    speakerType: 'persona',
    speakerPersonaId: 'persona-1',
    content: `msg-${seq}`,
    createdAt: `2026-02-12T00:00:${String(seq).padStart(2, '0')}.000Z`,
    ...overrides,
  };
}

describe('upsertRoomMessage', () => {
  it('appends message when sequence is newer than the current tail', () => {
    const previous = [message(1), message(2)];
    const next = upsertRoomMessage(previous, message(3));

    expect(next.map((item) => item.seq)).toEqual([1, 2, 3]);
  });

  it('inserts out-of-order message at the correct position', () => {
    const previous = [message(1), message(3)];
    const next = upsertRoomMessage(previous, message(2));

    expect(next.map((item) => item.seq)).toEqual([1, 2, 3]);
  });

  it('ignores duplicate messages by id or seq', () => {
    const previous = [message(1), message(2)];
    const sameId = message(3, { id: 'm-2' });
    const sameSeq = message(2, { id: 'm-2b' });

    expect(upsertRoomMessage(previous, sameId)).toBe(previous);
    expect(upsertRoomMessage(previous, sameSeq)).toBe(previous);
  });
});
