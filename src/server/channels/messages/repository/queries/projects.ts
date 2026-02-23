import crypto from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import type {
  ConversationProjectState,
  PersonaProjectRecord,
} from '@/server/channels/messages/repository/types';

export class ProjectQueries {
  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly normalizeUserId: (userId?: string) => string,
  ) {}

  createProject(input: {
    userId: string;
    personaId: string;
    name: string;
    workspacePath: string;
    workspaceRelativePath?: string;
  }): PersonaProjectRecord {
    const userId = this.normalizeUserId(input.userId);
    const personaId = String(input.personaId || '').trim();
    const name = String(input.name || '').trim();
    if (!personaId) throw new Error('personaId is required');
    if (!name) throw new Error('project name is required');
    if (!String(input.workspacePath || '').trim()) throw new Error('workspacePath is required');

    const id = `project-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const slug = this.resolveUniqueProjectSlug(userId, personaId, name);

    this.db
      .prepare(
        `
        INSERT INTO persona_projects (
          id, user_id, persona_id, name, slug,
          workspace_path, workspace_relative_path, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        id,
        userId,
        personaId,
        name,
        slug,
        input.workspacePath.trim(),
        input.workspaceRelativePath?.trim() || null,
        now,
        now,
      );

    return this.getProjectById(id, userId)!;
  }

  listProjectsByPersona(personaId: string, userId: string): PersonaProjectRecord[] {
    const normalizedUserId = this.normalizeUserId(userId);
    const rows = this.db
      .prepare(
        `
        SELECT * FROM persona_projects
        WHERE persona_id = ? AND user_id = ?
        ORDER BY updated_at DESC
      `,
      )
      .all(personaId, normalizedUserId) as Array<Record<string, unknown>>;
    return rows.map(toPersonaProjectRecord);
  }

  getProjectByIdOrSlug(personaId: string, userId: string, idOrSlug: string): PersonaProjectRecord | null {
    const normalizedUserId = this.normalizeUserId(userId);
    const normalized = String(idOrSlug || '').trim();
    if (!normalized) return null;

    const row = this.db
      .prepare(
        `
        SELECT * FROM persona_projects
        WHERE user_id = ? AND persona_id = ? AND (id = ? OR slug = ?)
        LIMIT 1
      `,
      )
      .get(normalizedUserId, personaId, normalized, normalized) as Record<string, unknown> | undefined;
    return row ? toPersonaProjectRecord(row) : null;
  }

  setActiveProjectForConversation(
    conversationId: string,
    userId: string,
    projectId: string | null,
  ): void {
    const normalizedUserId = this.normalizeUserId(userId);
    const conversation = this.db
      .prepare('SELECT id, persona_id FROM conversations WHERE id = ? AND user_id = ? LIMIT 1')
      .get(conversationId, normalizedUserId) as { id: string; persona_id: string | null } | undefined;
    if (!conversation) {
      throw new Error('Conversation not found.');
    }

    let nextProjectId: string | null = null;
    if (projectId) {
      const project = this.getProjectById(projectId, normalizedUserId);
      if (!project) {
        throw new Error('Project not found.');
      }
      if (!conversation.persona_id) {
        throw new Error('Conversation has no active persona.');
      }
      if (project.personaId !== conversation.persona_id) {
        throw new Error('Project persona does not match conversation persona.');
      }
      nextProjectId = project.id;
    }

    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO conversation_project_state (
          conversation_id, user_id, active_project_id, guard_approved_without_project, updated_at
        )
        VALUES (?, ?, ?, 0, ?)
        ON CONFLICT(conversation_id)
        DO UPDATE SET
          user_id = excluded.user_id,
          active_project_id = excluded.active_project_id,
          guard_approved_without_project = 0,
          updated_at = excluded.updated_at
      `,
      )
      .run(conversationId, normalizedUserId, nextProjectId, now);
  }

  getConversationProjectState(conversationId: string, userId: string): ConversationProjectState {
    const normalizedUserId = this.normalizeUserId(userId);
    const row = this.db
      .prepare(
        `
        SELECT conversation_id, active_project_id, guard_approved_without_project, updated_at
        FROM conversation_project_state
        WHERE conversation_id = ? AND user_id = ?
        LIMIT 1
      `,
      )
      .get(conversationId, normalizedUserId) as Record<string, unknown> | undefined;

    if (!row) {
      return {
        conversationId,
        activeProjectId: null,
        guardApprovedWithoutProject: false,
        updatedAt: null,
      };
    }

    return {
      conversationId: String(row.conversation_id),
      activeProjectId: row.active_project_id ? String(row.active_project_id) : null,
      guardApprovedWithoutProject: Number(row.guard_approved_without_project || 0) === 1,
      updatedAt: row.updated_at ? String(row.updated_at) : null,
    };
  }

  setConversationProjectGuardApproved(
    conversationId: string,
    userId: string,
    approved: boolean,
  ): void {
    const normalizedUserId = this.normalizeUserId(userId);
    const now = new Date().toISOString();
    const existing = this.getConversationProjectState(conversationId, normalizedUserId);
    this.db
      .prepare(
        `
        INSERT INTO conversation_project_state (
          conversation_id, user_id, active_project_id, guard_approved_without_project, updated_at
        )
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(conversation_id)
        DO UPDATE SET
          user_id = excluded.user_id,
          active_project_id = excluded.active_project_id,
          guard_approved_without_project = excluded.guard_approved_without_project,
          updated_at = excluded.updated_at
      `,
      )
      .run(
        conversationId,
        normalizedUserId,
        existing.activeProjectId,
        approved ? 1 : 0,
        now,
      );
  }

  private getProjectById(projectId: string, userId: string): PersonaProjectRecord | null {
    const row = this.db
      .prepare('SELECT * FROM persona_projects WHERE id = ? AND user_id = ? LIMIT 1')
      .get(projectId, userId) as Record<string, unknown> | undefined;
    return row ? toPersonaProjectRecord(row) : null;
  }

  private resolveUniqueProjectSlug(userId: string, personaId: string, name: string): string {
    const base = slugify(name);
    let candidate = base;
    let counter = 1;

    while (
      this.db
        .prepare(
          'SELECT id FROM persona_projects WHERE user_id = ? AND persona_id = ? AND slug = ? LIMIT 1',
        )
        .get(userId, personaId, candidate)
    ) {
      counter += 1;
      candidate = `${base}_${counter}`;
    }

    return candidate;
  }
}

function toPersonaProjectRecord(row: Record<string, unknown>): PersonaProjectRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    personaId: String(row.persona_id),
    name: String(row.name),
    slug: String(row.slug),
    workspacePath: String(row.workspace_path),
    workspaceRelativePath: row.workspace_relative_path ? String(row.workspace_relative_path) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function slugify(value: string): string {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || 'project';
}
