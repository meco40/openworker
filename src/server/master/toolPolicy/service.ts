import type { MasterRepository } from '@/server/master/repository';
import type { MasterToolPolicy, WorkspaceScope } from '@/server/master/types';

const KNOWN_POLICY_HOSTS = new Set(['gateway', 'sandbox', '*']);

export function loadToolPolicy(input: {
  repo: MasterRepository;
  scope: WorkspaceScope;
  fallbackAllowlist?: string[];
}): MasterToolPolicy | null {
  const existing = input.repo.getToolPolicy(input.scope);
  if (existing) {
    return existing;
  }
  if (!input.fallbackAllowlist) {
    return null;
  }
  return {
    id: 'default',
    userId: input.scope.userId,
    workspaceId: input.scope.workspaceId,
    security: 'allowlist',
    ask: 'on_miss',
    allowlist: input.fallbackAllowlist,
    updatedBy: null,
    createdAt: '',
    updatedAt: '',
  };
}

export function saveToolPolicy(input: {
  repo: MasterRepository;
  scope: WorkspaceScope;
  policy: Omit<MasterToolPolicy, 'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt'>;
}): MasterToolPolicy {
  return input.repo.upsertToolPolicy(input.scope, input.policy);
}

function matchGlob(pattern: string, value: string): boolean {
  const normalizedPattern = String(pattern || '').toLowerCase();
  const normalizedValue = String(value || '').toLowerCase();
  if (normalizedPattern === '*') {
    return true;
  }

  const parts = normalizedPattern.split('*');
  if (parts.length === 1) {
    return normalizedValue === normalizedPattern;
  }

  let cursor = 0;
  let isFirstPart = true;
  for (const part of parts) {
    if (!part) {
      isFirstPart = false;
      continue;
    }
    const index = normalizedValue.indexOf(part, cursor);
    if (index < 0) {
      return false;
    }
    if (isFirstPart && !normalizedPattern.startsWith('*') && index !== 0) {
      return false;
    }
    cursor = index + part.length;
    isFirstPart = false;
  }

  const lastPart = parts[parts.length - 1] ?? '';
  if (lastPart && !normalizedPattern.endsWith('*') && !normalizedValue.endsWith(lastPart)) {
    return false;
  }

  return true;
}

function parseAllowlistEntry(entry: string): {
  subject: string;
  host: string | null;
  target: string;
} | null {
  const trimmed = String(entry || '').trim();
  if (!trimmed) return null;

  const firstColon = trimmed.indexOf(':');
  if (firstColon < 0) {
    return { subject: trimmed, host: null, target: '*' };
  }

  const subject = trimmed.slice(0, firstColon).trim();
  const remainder = trimmed.slice(firstColon + 1);
  const secondColon = remainder.indexOf(':');
  if (secondColon >= 0) {
    const hostCandidate = remainder.slice(0, secondColon).trim();
    if (KNOWN_POLICY_HOSTS.has(hostCandidate)) {
      return {
        subject,
        host: hostCandidate === '*' ? '*' : hostCandidate,
        target: remainder.slice(secondColon + 1).trim() || '*',
      };
    }
  }

  return { subject, host: null, target: remainder.trim() || '*' };
}

function matchesAllowlistEntry(input: {
  entry: string;
  actionType: string;
  toolName?: string;
  host?: string | null;
  targetContext?: string | null;
  fingerprint?: string;
}): boolean {
  const parsed = parseAllowlistEntry(input.entry);
  if (!parsed) return false;

  const subjects = new Set(
    [input.actionType, input.toolName, '*']
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  );
  if (!subjects.has(parsed.subject)) {
    return false;
  }

  const host = String(input.host || '').trim();
  if (parsed.host && parsed.host !== '*' && parsed.host !== host) {
    return false;
  }

  const targetCandidates = [
    input.targetContext,
    input.fingerprint,
    [input.targetContext, input.fingerprint].filter(Boolean).join(':'),
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  if (parsed.target === '*') {
    return true;
  }

  return targetCandidates.some((candidate) => matchGlob(parsed.target, candidate));
}

export interface ToolPolicyResolution {
  decision: 'allow' | 'ask' | 'deny';
  policy: MasterToolPolicy | null;
  matchedAllowlistEntry: string | null;
  reason?: string;
}

export function resolveToolPolicy(input: {
  repo: MasterRepository;
  scope: WorkspaceScope;
  actionType: string;
  toolName?: string;
  host?: string | null;
  targetContext?: string | null;
  fingerprint?: string;
}): ToolPolicyResolution {
  const policy = loadToolPolicy({ repo: input.repo, scope: input.scope });
  if (!policy) {
    return { decision: 'allow', policy: null, matchedAllowlistEntry: null };
  }

  if (policy.security === 'deny') {
    return {
      decision: 'deny',
      policy,
      matchedAllowlistEntry: null,
      reason: `Tool policy blocks ${input.actionType}.`,
    };
  }

  const matchedAllowlistEntry =
    policy.security === 'full'
      ? '*'
      : (policy.allowlist.find((entry) =>
          matchesAllowlistEntry({
            entry,
            actionType: input.actionType,
            toolName: input.toolName,
            host: input.host,
            targetContext: input.targetContext,
            fingerprint: input.fingerprint,
          }),
        ) ?? null);

  if (policy.security === 'allowlist' && !matchedAllowlistEntry) {
    if (policy.ask === 'off') {
      return {
        decision: 'deny',
        policy,
        matchedAllowlistEntry: null,
        reason: `Tool policy requires allowlist match for ${input.actionType}.`,
      };
    }
    return {
      decision: 'ask',
      policy,
      matchedAllowlistEntry: null,
      reason: `Tool policy approval required for ${input.actionType}.`,
    };
  }

  if (policy.ask === 'always') {
    return {
      decision: 'ask',
      policy,
      matchedAllowlistEntry,
      reason: `Tool policy requires explicit approval for ${input.actionType}.`,
    };
  }

  return {
    decision: 'allow',
    policy,
    matchedAllowlistEntry,
  };
}
