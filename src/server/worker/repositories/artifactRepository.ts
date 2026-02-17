import crypto from 'node:crypto';
import { toArtifact } from '../workerRowMappers';
import type {
  WorkerRepository,
  WorkerArtifactRecord,
  SaveArtifactInput,
} from '../workerTypes';
import { BaseRepository } from './baseRepository';

/**
 * Repository for artifact-related operations.
 */
export class ArtifactRepository extends BaseRepository implements Pick<WorkerRepository,
  | 'saveArtifact'
  | 'getArtifacts'
> {
  
  saveArtifact(input: SaveArtifactInput): WorkerArtifactRecord {
    const id = `art-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const now = this.now();

    this.db
      .prepare(
        `
        INSERT INTO worker_artifacts (id, task_id, name, type, content, mime_type, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(id, input.taskId, input.name, input.type, input.content, input.mimeType || null, now);

    const row = this.db.prepare('SELECT * FROM worker_artifacts WHERE id = ?').get(id) as Record<
      string,
      unknown
    >;
    return toArtifact(row);
  }

  getArtifacts(taskId: string): WorkerArtifactRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM worker_artifacts WHERE task_id = ? ORDER BY created_at ASC')
      .all(taskId) as Array<Record<string, unknown>>;
    return rows.map(toArtifact);
  }
}
