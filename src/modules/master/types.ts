/**
 * Master module – frontend-facing types.
 *
 * Re-exports canonical server types so the UI never duplicates them.
 * Adds frontend-only shapes (e.g. precise MasterMetrics, StatusMessage).
 */

// ─── Re-exports from server ───────────────────────────────────────────────────

export type {
  MasterRun,
  MasterRunStatus,
  ApprovalDecision,
  MasterStep,
} from '@/server/master/types';

// ─── Persona summary (minimal shape needed by the UI) ─────────────────────────

export interface MasterPersonaSummary {
  id: string;
  name: string;
  slug: string;
  emoji?: string;
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

export interface MasterMetrics {
  run_completion_rate: number;
  verify_pass_rate: number;
  delegation_success_rate: number;
  learning_cycle_success_rate?: number;
  tool_forge_success_rate?: number;
  generated_at: string;
}

// ─── UI state ─────────────────────────────────────────────────────────────────

export interface StatusMessage {
  tone: 'info' | 'success' | 'error';
  text: string;
}

// ─── Known action types for approval decisions ────────────────────────────────

export const KNOWN_ACTION_TYPES = [
  'gmail.send',
  'shell.exec',
  'file.write',
  'http.post',
  'run.start',
  'run.export',
] as const;

export type KnownActionType = (typeof KNOWN_ACTION_TYPES)[number];
