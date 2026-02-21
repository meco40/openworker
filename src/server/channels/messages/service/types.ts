import type { ChannelType } from '@/shared/domain/types';
import type { MemoryFeedbackSignal } from '@/server/memory/service';
import type { Conversation } from '@/server/channels/messages/repository';

export const MEMORY_CONTEXT_CHAR_LIMIT = 5000;
export const MEMORY_RECALL_LIMIT = 10;
export const MEMORY_FEEDBACK_WINDOW_MS = 10 * 60 * 1000;
export const MODEL_HUB_GATEWAY_PREFIX_RE = /^\[model-hub-gateway[^\]]*\]\s*/i;
export const MAX_TOOL_ROUNDS = 3;
export const TOOL_OUTPUT_MAX_CHARS = 12_000;
export const TOOL_APPROVAL_TTL_MS = 30 * 60 * 1000;
export const SUBAGENT_RECENT_MINUTES = 60;
export const SUBAGENT_DEFAULT_AGENT_ID = 'worker';
export const SUBAGENT_MAX_ACTIVE_PER_CONVERSATION = 5;
export const SUBAGENT_RESULT_PREVIEW_MAX_CHARS = 1200;
export const SUBAGENT_ANNOUNCE_MAX_CHARS = 3000;

export type LastRecallState = {
  personaId: string;
  userId: string;
  nodeIds: string[];
  queriedAt: number;
};

export type ToolExecutionResult =
  | { kind: 'ok'; output: string }
  | { kind: 'error'; output: string }
  | { kind: 'approval_required'; prompt: string; pending: PendingToolApproval };

export type ResolvedToolContext = {
  tools: unknown[];
  installedFunctionNames: Set<string>;
  functionToSkillId: Map<string, string>;
};

export type PendingToolApproval = {
  token: string;
  userId: string;
  conversationId: string;
  platform: ChannelType;
  externalChatId: string;
  toolFunctionName: string;
  toolId?: string;
  args: Record<string, unknown>;
  command?: string;
  createdAtMs: number;
};

export type KnowledgeRetrievalServiceLike = {
  retrieve: (input: {
    userId: string;
    personaId: string;
    conversationId?: string;
    query: string;
  }) => Promise<{ context: string }>;
  shouldTriggerRecall?: (input: {
    userId: string;
    personaId: string;
    query: string;
  }) => Promise<boolean> | boolean;
};

export type SubagentAction = 'list' | 'spawn' | 'kill' | 'steer' | 'log' | 'info' | 'help';

export type SubagentDispatchContext = {
  conversation: Conversation;
  platform: ChannelType;
  externalChatId: string;
};

// Memory utility functions
export function extractMemorySaveContent(content: string): string | null {
  const trimmed = content.trim();
  const prefixMatch = /^speichere\s+ab\b/i.exec(trimmed);
  if (!prefixMatch) return null;

  let remainder = trimmed.slice(prefixMatch[0].length).trimStart();
  if (
    remainder.startsWith(':') ||
    remainder.startsWith('-') ||
    remainder.startsWith('–') ||
    remainder.startsWith('—')
  ) {
    remainder = remainder.slice(1).trimStart();
  }

  return remainder.trim();
}

export function shouldRecallMemoryForInput(content: string): boolean {
  const normalized = content.trim().toLowerCase();
  if (!normalized) return false;
  if (extractMemorySaveContent(normalized) !== null) return false;

  // Always-on recall for meaningful user turns (non-command, non-trivial)
  if (
    /^(ok|okay|danke|thx|merci|hi|hallo|hey|moin|ja|nein|passt|super|top|alles klar|gut)\W*$/i.test(
      normalized,
    )
  ) {
    return false;
  }

  const tokenCount = normalized.split(/\s+/).filter(Boolean).length;
  if (tokenCount <= 2 && !/[?]/.test(normalized)) return false;

  return true;
}

export function normalizeMemoryContext(context: string): string | null {
  const trimmed = context.trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase() === 'no relevant memories found.') return null;
  return trimmed.slice(0, MEMORY_CONTEXT_CHAR_LIMIT);
}

export function detectMemoryFeedbackSignal(content: string): MemoryFeedbackSignal | null {
  const normalized = content.trim().toLowerCase();
  if (!normalized) return null;

  if (
    /\b(falsch|stimmt nicht|nicht korrekt|inkorrekt|wrong|incorrect|not true|das ist nicht richtig)\b/i.test(
      normalized,
    )
  ) {
    return 'negative';
  }

  if (/\b(genau|stimmt|korrekt|richtig|exactly|correct|that's right)\b/i.test(normalized)) {
    return 'positive';
  }

  return null;
}

export function extractCorrectionContent(content: string): string | null {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  const patterns = [
    /\bsondern\s+(.+)$/i,
    /\b(richtig ist|korrekt ist|eigentlich)\s+(.+)$/i,
    /\bfalsch\b\s*[,.:;-]\s*(.+)$/i,
    /^\s*(falsch|nein)\s*[,.:;-]?\s*(.+)$/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(normalized);
    if (!match) continue;
    const candidate = (match[2] || match[1] || '').trim();
    if (candidate.length < 8) continue;
    return candidate;
  }

  return null;
}

export function inferShellCommandFromNaturalLanguage(content: string): string | null {
  const normalized = content.trim().toLowerCase();
  if (!normalized) return null;

  const asksFileCount =
    ((/\bwie viele\b/.test(normalized) && /\bdatei(?:en)?\b/.test(normalized)) ||
      (/\bhow many\b/.test(normalized) && /\bfiles?\b/.test(normalized))) &&
    /\bdesktop\b/.test(normalized);

  if (asksFileCount) {
    if (process.platform === 'win32') {
      return "$desktop=[Environment]::GetFolderPath('Desktop'); (Get-ChildItem -LiteralPath $desktop -Force -File | Measure-Object).Count";
    }
    return 'if [ -d "$HOME/Desktop" ]; then find "$HOME/Desktop" -maxdepth 1 -type f | wc -l; else echo 0; fi';
  }

  return null;
}
