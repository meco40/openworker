import type { PersonaPermissions } from '../types';
import { BaseRepository } from './baseRepository';

/**
 * Repository for persona permission-related operations.
 */
export class PermissionRepository extends BaseRepository {
  setPersonaPermissions(personaId: string, permissions: PersonaPermissions): void {
    const now = this.now();
    this.db
      .prepare(
        `
        INSERT INTO persona_permissions (persona_id, tools_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(persona_id) DO UPDATE
          SET tools_json = excluded.tools_json,
              updated_at = excluded.updated_at
      `,
      )
      .run(personaId, JSON.stringify(permissions.tools || {}), now);
  }

  getPersonaPermissions(personaId: string): PersonaPermissions | null {
    const row = this.db
      .prepare('SELECT tools_json FROM persona_permissions WHERE persona_id = ?')
      .get(personaId) as { tools_json: string } | undefined;
    if (!row) {
      return null;
    }
    return { tools: JSON.parse(row.tools_json) as Record<string, boolean> };
  }
}
