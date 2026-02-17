/**
 * Dynamic Recall Budget Calculator
 *
 * Scales the recall context budget from ~4k (simple factual question)
 * up to ~25k chars (comprehensive "tell me everything" query).
 */

export type QueryComplexity = 'simple' | 'medium' | 'complex' | 'comprehensive';

export interface RecallBudgetRequest {
  queryComplexity: QueryComplexity;
  entityCount: number;
  availableSourceCount: number;
}

export interface RecallBudget {
  total: number;
  knowledge: number;
  memory: number;
  chat: number;
  entityContext: number;
  computedAnswer: number;
  summary: number;
}

interface BudgetPreset {
  knowledge: number;
  memory: number;
  chat: number;
  entityContext: number;
  computedAnswer: number;
  summary: number;
}

const BUDGET_PRESETS: Record<QueryComplexity, BudgetPreset> = {
  simple: {
    knowledge: 1000,
    memory: 800,
    chat: 1200,
    entityContext: 500,
    computedAnswer: 300,
    summary: 0,
  },
  medium: {
    knowledge: 2500,
    memory: 1500,
    chat: 2500,
    entityContext: 1000,
    computedAnswer: 500,
    summary: 2000,
  },
  complex: {
    knowledge: 3000,
    memory: 2000,
    chat: 3000,
    entityContext: 1500,
    computedAnswer: 1000,
    summary: 2500,
  },
  comprehensive: {
    knowledge: 4000,
    memory: 3000,
    chat: 3000,
    entityContext: 3000,
    computedAnswer: 0,
    summary: 5000,
  },
};

/**
 * Detects query complexity from user message text.
 */
export function detectQueryComplexity(query: string): QueryComplexity {
  if (/\b(was weisst du|erzaehl|zusammenfassung|alles ueber|ueberblick)\b/i.test(query))
    return 'comprehensive';

  if (/\b(wie (?:viele|oft|lange)|insgesamt|seit wann|vergleich)\b/i.test(query)) return 'complex';

  if (/\b(wann|warum|was (?:hast|haben|wurde)|letzte woche|letzten monat)\b/i.test(query))
    return 'medium';

  return 'simple';
}

/**
 * Calculates the recall budget based on query complexity and context.
 */
export function calculateRecallBudget(request: RecallBudgetRequest): RecallBudget {
  const preset = BUDGET_PRESETS[request.queryComplexity] ?? BUDGET_PRESETS.medium;

  // Scale entity context budget with entity count (cap at 2.0x)
  const entityScale = Math.min(2.0, 1.0 + request.entityCount * 0.1);
  const scaledEntityContext = Math.round(preset.entityContext * entityScale);

  const knowledge = preset.knowledge;
  const memory = preset.memory;
  const chat = preset.chat;
  const computedAnswer = preset.computedAnswer;
  const summary = preset.summary;

  const total = knowledge + memory + chat + scaledEntityContext + computedAnswer + summary;

  return {
    total,
    knowledge,
    memory,
    chat,
    entityContext: scaledEntityContext,
    computedAnswer,
    summary,
  };
}
