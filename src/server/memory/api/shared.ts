import type { MemoryType } from '@/core/memory/types';
import { LEGACY_LOCAL_USER_ID } from '@/server/auth/constants';
import { getMessageRepository } from '@/server/channels/messages/runtime';
import { parseBoundedIntOrFallback } from '@/server/http/params';
import type { ParsedBulkBody, ParsedRecallArgs, ParsedStoreArgs, ParsedUpdateBody } from './types';

export class ValidationError extends Error {}

const ALLOWED_TYPES: MemoryType[] = [
  'fact',
  'preference',
  'avoidance',
  'lesson',
  'personality_trait',
  'workflow_pattern',
];

export const DELETE_ALL_CONFIRM_TOKEN = 'delete-all-memory';

export function parseStoreArgs(raw: Record<string, unknown>): ParsedStoreArgs {
  const personaId = parsePersonaId(raw.personaId);
  const type = String(raw.type || '').trim() as MemoryType;
  const content = String(raw.content || '').trim();
  const importanceRaw = Number(raw.importance ?? 3);
  const importance = Number.isFinite(importanceRaw)
    ? Math.min(5, Math.max(1, Math.round(importanceRaw)))
    : 3;

  if (!ALLOWED_TYPES.includes(type)) {
    throw new ValidationError('Invalid memory type.');
  }
  if (!content) {
    throw new ValidationError('content is required.');
  }
  return { personaId, type, content, importance };
}

export function parseRecallArgs(raw: Record<string, unknown>): ParsedRecallArgs {
  const personaId = parsePersonaId(raw.personaId);
  const query = String(raw.query || '').trim();
  const limitRaw = Number(raw.limit ?? 3);
  const limit = Number.isFinite(limitRaw) ? Math.min(20, Math.max(1, Math.floor(limitRaw))) : 3;
  if (!query) {
    throw new ValidationError('query is required.');
  }
  return { personaId, query, limit };
}

export function parsePersonaId(raw: unknown): string {
  const personaId = String(raw || '').trim();
  if (!personaId) {
    throw new ValidationError('personaId is required.');
  }
  return personaId;
}

export function parseMemoryNodeId(raw: unknown): string {
  const nodeId = String(raw || '').trim();
  if (!nodeId) {
    throw new ValidationError('id is required.');
  }
  return nodeId;
}

export function parseUpdateBody(raw: Record<string, unknown>): ParsedUpdateBody {
  const personaId = parsePersonaId(raw.personaId);
  const id = parseMemoryNodeId(raw.id);

  const next: ParsedUpdateBody = { personaId, id };

  if (raw.type !== undefined) {
    const type = String(raw.type || '').trim() as MemoryType;
    if (!ALLOWED_TYPES.includes(type)) {
      throw new ValidationError('Invalid memory type.');
    }
    next.type = type;
  }

  if (raw.content !== undefined) {
    const content = String(raw.content || '').trim();
    if (!content) {
      throw new ValidationError('content must not be empty.');
    }
    next.content = content;
  }

  if (raw.importance !== undefined) {
    const importanceRaw = Number(raw.importance);
    const importance = Number.isFinite(importanceRaw)
      ? Math.min(5, Math.max(1, Math.round(importanceRaw)))
      : NaN;
    if (!Number.isFinite(importance)) {
      throw new ValidationError('importance must be numeric.');
    }
    next.importance = importance;
  }

  if (raw.expectedVersion !== undefined) {
    const expectedRaw = Number(raw.expectedVersion);
    const expectedVersion = Number.isFinite(expectedRaw) ? Math.floor(expectedRaw) : NaN;
    if (!Number.isFinite(expectedVersion) || expectedVersion < 1) {
      throw new ValidationError('expectedVersion must be a positive integer.');
    }
    next.expectedVersion = expectedVersion;
  }

  if (raw.restoreIndex !== undefined) {
    const restoreRaw = Number(raw.restoreIndex);
    const restoreIndex = Number.isFinite(restoreRaw) ? Math.floor(restoreRaw) : NaN;
    if (!Number.isFinite(restoreIndex) || restoreIndex < 0) {
      throw new ValidationError('restoreIndex must be a non-negative integer.');
    }
    next.restoreIndex = restoreIndex;
  }

  if (next.restoreIndex !== undefined) {
    if (next.type !== undefined || next.content !== undefined || next.importance !== undefined) {
      throw new ValidationError(
        'restoreIndex cannot be combined with type/content/importance updates.',
      );
    }
    return next;
  }

  if (next.type === undefined && next.content === undefined && next.importance === undefined) {
    throw new ValidationError('No fields to update.');
  }

  return next;
}

export function parseFlag(raw: unknown): boolean {
  const value = String(raw || '')
    .trim()
    .toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

export function parseOptionalType(raw: unknown): MemoryType | undefined {
  const value = String(raw || '').trim();
  if (!value || value === 'all') {
    return undefined;
  }
  if (!ALLOWED_TYPES.includes(value as MemoryType)) {
    throw new ValidationError('Invalid memory type.');
  }
  return value as MemoryType;
}

export function parseBulkBody(raw: Record<string, unknown>): ParsedBulkBody {
  const personaId = parsePersonaId(raw.personaId);
  const idsRaw = Array.isArray(raw.ids) ? raw.ids : [];
  const ids = Array.from(
    new Set(idsRaw.map((id) => String(id || '').trim()).filter((id) => id.length > 0)),
  );
  if (ids.length === 0) {
    throw new ValidationError('ids must be a non-empty array.');
  }

  const actionRaw = String(raw.action || '')
    .trim()
    .toLowerCase();
  if (actionRaw !== 'update' && actionRaw !== 'delete') {
    throw new ValidationError('action must be either "update" or "delete".');
  }
  const action: 'update' | 'delete' = actionRaw;

  const updates: { type?: MemoryType; importance?: number } = {};
  if (raw.type !== undefined) {
    updates.type = parseOptionalType(raw.type);
  }
  if (raw.importance !== undefined) {
    updates.importance = parseBoundedIntOrFallback(raw.importance, 3, 1, 5);
  }

  if (action === 'update' && updates.type === undefined && updates.importance === undefined) {
    throw new ValidationError('Bulk update requires at least one update field.');
  }

  return { personaId, ids, action, updates };
}

export function isDeleteAllConfirmed(raw: unknown): boolean {
  return (
    String(raw || '')
      .trim()
      .toLowerCase() === DELETE_ALL_CONFIRM_TOKEN
  );
}

export function resolveMemoryReadUserScopes(baseUserId: string, personaId: string): string[] {
  const normalizedUserId = String(baseUserId || '').trim();
  if (!normalizedUserId) return [];
  if (normalizedUserId !== LEGACY_LOCAL_USER_ID) return [normalizedUserId];

  const scopes = new Set<string>([normalizedUserId]);
  try {
    const conversations = getMessageRepository().listConversations(500, normalizedUserId);
    for (const conversation of conversations) {
      const channel = String(conversation.channelType || '')
        .trim()
        .toLowerCase();
      const externalChatId = String(conversation.externalChatId || '').trim();
      const conversationPersonaId = String(conversation.personaId || '').trim();
      if (!channel || !externalChatId || channel === 'webchat') continue;
      if (conversationPersonaId && conversationPersonaId !== personaId) continue;
      scopes.add(`channel:${channel}:${externalChatId}`);
    }
  } catch (error) {
    console.warn('Memory scope discovery failed:', error);
  }

  return Array.from(scopes);
}

export function dedupeById<T extends { id: string }>(rows: T[]): T[] {
  const deduped = new Map<string, T>();
  for (const row of rows) {
    if (!row?.id) continue;
    deduped.set(row.id, row);
  }
  return Array.from(deduped.values());
}

export function rankNodeTimestamp(node: { metadata?: Record<string, unknown> }): number {
  const iso = String(node.metadata?.lastVerified || '').trim();
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}
