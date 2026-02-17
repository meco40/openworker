import { toUserSettings } from '../workerRowMappers';
import type {
  WorkerRepository,
  WorkerUserSettingsRecord,
} from '../workerTypes';
import { BaseRepository } from './baseRepository';

/**
 * Repository for user settings-related operations.
 */
export class UserSettingsRepository extends BaseRepository implements Pick<WorkerRepository,
  | 'getUserSettings'
  | 'saveUserSettings'
> {
  
  getUserSettings(userId: string): WorkerUserSettingsRecord | null {
    const row = this.db
      .prepare('SELECT * FROM worker_user_settings WHERE user_id = ?')
      .get(userId) as Record<string, unknown> | undefined;
    return row ? toUserSettings(row) : null;
  }

  saveUserSettings(
    userId: string,
    updates: { defaultWorkspaceRoot: string | null },
  ): WorkerUserSettingsRecord {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO worker_user_settings (user_id, default_workspace_root, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           default_workspace_root = excluded.default_workspace_root,
           updated_at = excluded.updated_at`,
      )
      .run(userId, updates.defaultWorkspaceRoot, now);

    const row = this.db
      .prepare('SELECT * FROM worker_user_settings WHERE user_id = ?')
      .get(userId) as Record<string, unknown>;
    return toUserSettings(row);
  }
}
