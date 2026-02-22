import type BetterSqlite3 from 'better-sqlite3';
import type {
  ChannelBinding,
  ChannelBindingStatus,
  UpsertChannelBindingInput,
} from '@/server/channels/messages/channelBindings';
import type { ChannelKey } from '@/server/channels/adapters/types';
import { toChannelBinding } from '@/server/channels/messages/messageRowMappers';

export class ChannelBindingQueries {
  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly normalizeUserId: (userId?: string) => string,
  ) {}

  upsertChannelBinding(input: UpsertChannelBindingInput): ChannelBinding {
    const userId = this.normalizeUserId(input.userId);
    const now = new Date().toISOString();

    this.db
      .prepare(
        `
        INSERT INTO channel_bindings (
          user_id,
          channel,
          status,
          external_peer_id,
          peer_name,
          transport,
          metadata,
          last_seen_at,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, channel)
        DO UPDATE SET
          status = excluded.status,
          external_peer_id = excluded.external_peer_id,
          peer_name = excluded.peer_name,
          transport = excluded.transport,
          metadata = excluded.metadata,
          updated_at = excluded.updated_at
      `,
      )
      .run(
        userId,
        input.channel,
        input.status,
        input.externalPeerId || null,
        input.peerName || null,
        input.transport || null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        null,
        now,
        now,
      );

    const row = this.db
      .prepare('SELECT * FROM channel_bindings WHERE user_id = ? AND channel = ?')
      .get(userId, input.channel) as Record<string, unknown>;
    return toChannelBinding(row);
  }

  listChannelBindings(userId: string): ChannelBinding[] {
    const normalizedUserId = this.normalizeUserId(userId);
    const rows = this.db
      .prepare('SELECT * FROM channel_bindings WHERE user_id = ? ORDER BY updated_at DESC')
      .all(normalizedUserId) as Array<Record<string, unknown>>;
    return rows.map(toChannelBinding);
  }

  getChannelBinding(userId: string, channel: ChannelKey): ChannelBinding | null {
    const normalizedUserId = this.normalizeUserId(userId);
    const row = this.db
      .prepare('SELECT * FROM channel_bindings WHERE user_id = ? AND channel = ?')
      .get(normalizedUserId, channel) as Record<string, unknown> | undefined;
    return row ? toChannelBinding(row) : null;
  }

  updateChannelBindingPersona(userId: string, channel: ChannelKey, personaId: string | null): void {
    const normalizedUserId = this.normalizeUserId(userId);
    const now = new Date().toISOString();
    this.db
      .prepare(
        'UPDATE channel_bindings SET persona_id = ?, updated_at = ? WHERE user_id = ? AND channel = ?',
      )
      .run(personaId, now, normalizedUserId, channel);
  }

  touchChannelLastSeen(
    userId: string,
    channel: ChannelKey,
    atIso = new Date().toISOString(),
    status: ChannelBindingStatus = 'connected',
  ): void {
    const normalizedUserId = this.normalizeUserId(userId);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO channel_bindings (
          user_id,
          channel,
          status,
          external_peer_id,
          peer_name,
          transport,
          metadata,
          last_seen_at,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)
        ON CONFLICT(user_id, channel)
        DO UPDATE SET
          status = excluded.status,
          last_seen_at = excluded.last_seen_at,
          updated_at = excluded.updated_at
      `,
      )
      .run(normalizedUserId, channel, status, atIso, now, now);
  }
}
