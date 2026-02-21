import type { MemoryType } from '@/core/memory/types';
import { LEGACY_LOCAL_USER_ID } from '@/server/auth/constants';
import { MIN_CONFIDENCE, MAX_CONFIDENCE, MIN_IMPORTANCE, MAX_IMPORTANCE } from '../constants';

export function resolveUserId(userId?: string): string {
  const normalized = String(userId || '').trim();
  return normalized || LEGACY_LOCAL_USER_ID;
}

export function asMemoryType(value: unknown): MemoryType {
  const text = String(value || '').trim() as MemoryType;
  const allowed: MemoryType[] = [
    'fact',
    'preference',
    'avoidance',
    'lesson',
    'personality_trait',
    'workflow_pattern',
  ];
  return allowed.includes(text) ? text : 'fact';
}

export function asImportance(value: unknown, fallback = 3): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_IMPORTANCE, Math.max(MIN_IMPORTANCE, Math.round(parsed)));
}

export function asConfidence(value: unknown, fallback = 0.5): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_CONFIDENCE, Math.max(MIN_CONFIDENCE, parsed));
}

export function asFeedbackCount(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

export function asVersion(value: unknown, fallback = 1): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}
