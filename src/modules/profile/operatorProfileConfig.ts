import type { ControlPlaneMetrics } from '@/shared/domain/types';

export interface OperatorProfileState {
  displayName: string;
  primaryContact: string;
  localUuid: string;
  workspaceSlots: number;
  dailyTokenBudget: number;
}

export interface OperatorUsageSnapshot {
  workspaceUsed: number;
  workspaceTotal: number;
  activeAgents: number;
  remainingBudgetPercent: number;
  tokensToday: number;
}

const DEFAULT_OPERATOR_PROFILE: OperatorProfileState = {
  displayName: 'OpenClaw Operator',
  primaryContact: 'operator@openclaw.io',
  localUuid: '',
  workspaceSlots: 12,
  dailyTokenBudget: 250_000,
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readObject(
  parent: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = parent[key];
  return isObject(value) ? value : undefined;
}

function readString(parent: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!parent) return undefined;
  const value = parent[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readPositiveInt(
  parent: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  if (!parent) return undefined;
  const value = parent[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return undefined;
  return value;
}

export function parseOperatorProfileFromConfig(config: unknown): OperatorProfileState {
  if (!isObject(config)) {
    return { ...DEFAULT_OPERATOR_PROFILE };
  }

  const operator = readObject(config, 'operator');
  const profile = operator ? readObject(operator, 'profile') : undefined;
  const limits = operator ? readObject(operator, 'limits') : undefined;

  return {
    displayName: readString(profile, 'displayName') || DEFAULT_OPERATOR_PROFILE.displayName,
    primaryContact:
      readString(profile, 'primaryContact') || DEFAULT_OPERATOR_PROFILE.primaryContact,
    localUuid: readString(profile, 'localUuid') || DEFAULT_OPERATOR_PROFILE.localUuid,
    workspaceSlots:
      readPositiveInt(limits, 'workspaceSlots') || DEFAULT_OPERATOR_PROFILE.workspaceSlots,
    dailyTokenBudget:
      readPositiveInt(limits, 'dailyTokenBudget') || DEFAULT_OPERATOR_PROFILE.dailyTokenBudget,
  };
}

export function applyOperatorProfileToConfig(
  baseConfig: Record<string, unknown>,
  profile: OperatorProfileState,
): Record<string, unknown> {
  const cloned = JSON.parse(JSON.stringify(baseConfig)) as Record<string, unknown>;
  const operator = readObject(cloned, 'operator') || {};
  const existingProfile = readObject(operator, 'profile') || {};
  const existingLimits = readObject(operator, 'limits') || {};

  operator.profile = {
    ...existingProfile,
    displayName: profile.displayName.trim(),
    primaryContact: profile.primaryContact.trim(),
    localUuid: profile.localUuid.trim(),
  };
  operator.limits = {
    ...existingLimits,
    workspaceSlots: profile.workspaceSlots,
    dailyTokenBudget: profile.dailyTokenBudget,
  };

  cloned.operator = operator;
  return cloned;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function computeOperatorUsageSnapshot(
  limits: Pick<OperatorProfileState, 'workspaceSlots' | 'dailyTokenBudget'>,
  metrics: Partial<ControlPlaneMetrics> | null | undefined,
): OperatorUsageSnapshot {
  const workspaceUsed = Math.max(0, metrics?.rooms?.totalRooms || 0);
  const workspaceTotal = Math.max(1, limits.workspaceSlots);
  const activeAgents = Math.max(0, metrics?.rooms?.runningRooms || 0);
  const tokensToday = Math.max(0, metrics?.tokensToday || 0);
  const budget = Math.max(1, limits.dailyTokenBudget);
  const consumedPercent = clampInt((tokensToday / budget) * 100, 0, 100);

  return {
    workspaceUsed,
    workspaceTotal,
    activeAgents,
    remainingBudgetPercent: 100 - consumedPercent,
    tokensToday,
  };
}
