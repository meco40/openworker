import type { MemoryType } from '@/core/memory/types';
import type { resolveRequestUserContext } from '@/server/auth/userContext';

export interface MemoryPostBody {
  fcName?: string;
  args?: Record<string, unknown>;
}

export interface ParsedStoreArgs {
  personaId: string;
  workspaceId?: string;
  type: MemoryType;
  content: string;
  importance: number;
}

export interface ParsedRecallArgs {
  personaId: string;
  workspaceId?: string;
  query: string;
  limit: number;
}

export interface ParsedUpdateBody {
  personaId: string;
  workspaceId?: string;
  id: string;
  type?: MemoryType;
  content?: string;
  importance?: number;
  expectedVersion?: number;
  restoreIndex?: number;
}

export interface ParsedBulkBody {
  personaId: string;
  workspaceId?: string;
  ids: string[];
  action: 'update' | 'delete';
  updates: { type?: MemoryType; importance?: number };
}

export type MemoryApiUserContext = NonNullable<
  Awaited<ReturnType<typeof resolveRequestUserContext>>
>;
