import crypto from 'node:crypto';
import { toRun } from '@/server/rooms/roomRowMappers';
import type { RoomRun, RoomRunState } from '@/server/rooms/types';
import { BaseRepository } from '@/server/rooms/repositories/baseRepository';

/**
 * Repository for room run/lease-related operations.
 */
export class RunRepository extends BaseRepository {
  acquireRoomLease(roomId: string, leaseOwner: string, leaseExpiresAt: string): RoomRun {
    const now = this.now();
    const tx = this.db.transaction(() => {
      const active = this.db
        .prepare('SELECT * FROM room_runs WHERE room_id = ? AND ended_at IS NULL')
        .get(roomId) as Record<string, unknown> | undefined;

      if (active) {
        const activeLeaseOwner = (active.lease_owner as string) || null;
        const activeLeaseExpiresAt = (active.lease_expires_at as string) || null;
        if (
          activeLeaseOwner &&
          activeLeaseOwner !== leaseOwner &&
          activeLeaseExpiresAt &&
          activeLeaseExpiresAt > now
        ) {
          return toRun(active);
        }

        this.db
          .prepare(
            `
            UPDATE room_runs
            SET run_state = 'running',
                lease_owner = ?,
                lease_expires_at = ?,
                heartbeat_at = ?,
                failure_reason = NULL,
                updated_at = ?,
                ended_at = NULL
            WHERE id = ?
          `,
          )
          .run(leaseOwner, leaseExpiresAt, now, now, active.id as string);
      } else {
        this.db
          .prepare(
            `
            INSERT INTO room_runs (
              id, room_id, run_state, lease_owner, lease_expires_at, heartbeat_at, failure_reason, started_at, ended_at, created_at, updated_at
            ) VALUES (?, ?, 'running', ?, ?, ?, NULL, ?, NULL, ?, ?)
          `,
          )
          .run(crypto.randomUUID(), roomId, leaseOwner, leaseExpiresAt, now, now, now, now);
      }

      this.db
        .prepare('UPDATE rooms SET run_state = ?, updated_at = ? WHERE id = ?')
        .run('running', now, roomId);

      const current = this.db
        .prepare('SELECT * FROM room_runs WHERE room_id = ? AND ended_at IS NULL')
        .get(roomId) as Record<string, unknown>;
      return toRun(current);
    });

    return tx();
  }

  heartbeatRoomLease(
    roomId: string,
    runId: string,
    leaseOwner: string,
    leaseExpiresAt: string,
  ): RoomRun {
    const now = this.now();
    const result = this.db
      .prepare(
        `
        UPDATE room_runs
        SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND room_id = ? AND lease_owner = ? AND ended_at IS NULL
      `,
      )
      .run(now, leaseExpiresAt, now, runId, roomId, leaseOwner);
    if (result.changes === 0) {
      throw new Error(`Could not heartbeat run lease: ${roomId}/${runId}`);
    }
    const row = this.db.prepare('SELECT * FROM room_runs WHERE id = ?').get(runId) as Record<
      string,
      unknown
    >;
    return toRun(row);
  }

  getActiveRoomRun(roomId: string): RoomRun | null {
    const row = this.db
      .prepare('SELECT * FROM room_runs WHERE room_id = ? AND ended_at IS NULL')
      .get(roomId) as Record<string, unknown> | undefined;
    return row ? toRun(row) : null;
  }

  closeActiveRoomRun(
    roomId: string,
    endedState: RoomRunState = 'stopped',
    failureReason: string | null = null,
  ): void {
    const now = this.now();
    const active = this.getActiveRoomRun(roomId);
    if (active) {
      this.db
        .prepare(
          `
          UPDATE room_runs
          SET run_state = ?, failure_reason = ?, lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = ?, ended_at = ?, updated_at = ?
          WHERE id = ?
        `,
        )
        .run(endedState, failureReason, now, now, now, active.id);
    }

    this.db
      .prepare('UPDATE rooms SET run_state = ?, updated_at = ? WHERE id = ?')
      .run(endedState, now, roomId);
  }
}
