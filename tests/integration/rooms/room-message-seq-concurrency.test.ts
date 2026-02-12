import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SqliteRoomRepository } from '../../../src/server/rooms/sqliteRoomRepository';

type InternalDb = {
  prepare: (sql: string) => { get: (...params: unknown[]) => unknown };
};

function uniqueDbPath(name: string): string {
  return path.join(
    process.cwd(),
    '.local',
    `${name}.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
  );
}

describe('room message sequence allocator', () => {
  const createdDbFiles: string[] = [];

  afterEach(() => {
    for (const dbFile of createdDbFiles.splice(0, createdDbFiles.length)) {
      if (fs.existsSync(dbFile)) {
        try {
          fs.unlinkSync(dbFile);
        } catch {
          // ignore transient locks
        }
      }
    }
  });

  it('persists and advances room_message_sequences across repository instances', () => {
    const dbPath = uniqueDbPath('rooms.seq');
    createdDbFiles.push(dbPath);

    const repoA = new SqliteRoomRepository(dbPath);
    const room = repoA.createRoom({
      userId: 'user-a',
      name: 'Office',
      goalMode: 'planning',
      routingProfileId: 'p1',
    });

    const m1 = repoA.appendMessage({
      roomId: room.id,
      speakerType: 'user',
      speakerPersonaId: null,
      content: 'first',
    });
    expect(m1.seq).toBe(1);
    repoA.close();

    const repoB = new SqliteRoomRepository(dbPath);
    const m2 = repoB.appendMessage({
      roomId: room.id,
      speakerType: 'user',
      speakerPersonaId: null,
      content: 'second',
    });
    expect(m2.seq).toBe(2);

    const db = (repoB as unknown as { db: InternalDb }).db;
    const seqRow = db
      .prepare('SELECT last_seq FROM room_message_sequences WHERE room_id = ?')
      .get(room.id) as { last_seq: number } | undefined;
    expect(seqRow?.last_seq).toBe(2);
    repoB.close();
  });
});
