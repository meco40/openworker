/**
 * Session utility functions.
 */

import type { AgentSessionSnapshot } from '@/server/agent-v2/types';
import { DEFAULT_MAX_QUEUE_LENGTH, MIN_QUEUE_LENGTH, MAX_QUEUE_LENGTH } from './constants';

/**
 * Resolves the maximum queue length from environment variable
 * with safe defaults and bounds checking.
 */
export function resolveMaxQueueLength(): number {
  const raw = Number.parseInt(String(process.env.AGENT_V2_MAX_QUEUE_PER_SESSION || ''), 10);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_MAX_QUEUE_LENGTH;
  return Math.max(MIN_QUEUE_LENGTH, Math.min(raw, MAX_QUEUE_LENGTH));
}

/**
 * Safely parses a JSON string into a typed object.
 * Returns null if parsing fails or input is null/empty.
 */
export function safeJsonParse<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/**
 * Builds a pending session snapshot for use before session creation.
 */
export function buildPendingSessionSnapshot(
  userId: string,
  conversationId: string,
  now: string,
): AgentSessionSnapshot {
  return {
    id: 'pending',
    userId,
    conversationId,
    status: 'idle',
    revision: 0,
    lastSeq: 0,
    queueDepth: 0,
    runningCommandId: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
}

/**
 * Builds a human-readable message for approval result status.
 */
export function buildApprovalResultMessage(
  status: 'approved' | 'denied' | 'not_found' | 'approval_required',
): string {
  if (status === 'approved') return 'Approval command accepted.';
  if (status === 'denied') return 'Approval denied.';
  if (status === 'approval_required') return 'Another approval step is required.';
  return 'Approval token not found.';
}
