/**
 * Recall Fusion — merges context from Knowledge, Mem0, and FTS5 Chat sources
 * into a single labeled context string for the LLM.
 */

import type { StoredMessage } from '@/server/channels/messages/repository';

// ── Budget configuration ─────────────────────────────────────

/** Total character budget for the fused recall context. */
export const RECALL_FUSION_TOTAL_BUDGET = 5000;

/** Per-source character budgets. */
const SOURCE_BUDGETS = {
  knowledge: 1800,
  memory: 1200,
  chat: 2000,
} as const;

// ── Types ────────────────────────────────────────────────────

export interface RecallSources {
  /** Context string from the Knowledge Layer (episodes/ledger). */
  knowledge: string | null;
  /** Context string from Mem0 semantic recall. */
  memory: string | null;
  /** Chat messages matched via FTS5 full-text search. */
  chatHits: StoredMessage[];
  /** Computed factual answer from event aggregation (e.g., day counts). */
  computedAnswer?: string | null;
}

// ── Fusion ───────────────────────────────────────────────────

/**
 * Fuses recall context from up to three sources into a single labeled string.
 *
 * Each source is truncated to its budget, and the total output is capped at
 * {@link RECALL_FUSION_TOTAL_BUDGET} characters.
 *
 * Returns `null` when no source produced any content.
 */
export function fuseRecallSources(sources: RecallSources): string | null {
  const sections: string[] = [];

  // ── Computed Answer — highest priority, always first ─────
  const computedText = sources.computedAnswer?.trim() || '';
  if (computedText) {
    sections.push(`[Computed Answer]\n${computedText}`);
  }

  // ── Chat History (FTS5) — high-signal for direct recall ──
  if (sources.chatHits.length > 0) {
    const chatLines = sources.chatHits.map((msg) => {
      const dateStr = formatDate(msg.createdAt);
      return `- "${truncate(msg.content, 400)}" — ${dateStr}`;
    });
    const chatBlock = chatLines.join('\n');
    sections.push(`[Chat History]\n${truncate(chatBlock, SOURCE_BUDGETS.chat)}`);
  }

  // ── Knowledge ────────────────────────────────────
  const knowledgeText = sources.knowledge?.trim() || '';
  if (knowledgeText) {
    sections.push(`[Knowledge]\n${truncate(knowledgeText, SOURCE_BUDGETS.knowledge)}`);
  }

  // ── Memory (Mem0) ────────────────────────────────
  const memoryText = sources.memory?.trim() || '';
  if (memoryText) {
    sections.push(`[Memory]\n${truncate(memoryText, SOURCE_BUDGETS.memory)}`);
  }

  if (sections.length === 0) return null;

  const fused = sections.join('\n\n');
  return truncate(fused, RECALL_FUSION_TOTAL_BUDGET);
}

// ── Helpers ──────────────────────────────────────────────────

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1) + '…';
}

function formatDate(isoString: string): string {
  try {
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return isoString;
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}.${month}.${year}`;
  } catch {
    return isoString;
  }
}
