import { getWorldModelConfig } from '@/server/world-model/config';
import { insertStandingIntent } from '@/server/world-model/repositories/prospectiveRepository';
import type { StandingIntentInput, StandingIntentRecord } from '@/server/world-model/types';

/**
 * Compiles natural-language statements like
 *   "Wenn Mike antwortet, erinnere mich an das Angebot"
 * into a validated StandingIntentInput. This first implementation is
 * deterministic and rule-based: it recognizes a small set of trigger words and
 * produces a structured trigger configuration. LLM-assist can be layered on
 * later without changing the persisted shape.
 */
export interface CompiledStandingIntent {
  input: StandingIntentInput;
  matchedTemplate: 'if_when_subject' | 'always_trigger' | 'none';
  confidence: number;
}

const TRIGGER_CONSOLIDATED: Record<string, string[]> = {
  mike: ['mike', 'mike antwortet'],
  christina: ['christina'],
};

const COMPILER_ENABLED = true;

export function compileStandingIntent(input: {
  userId: string;
  personaId: string;
  workspaceId?: string;
  statement: string;
}): CompiledStandingIntent {
  const text = input.statement.toLowerCase();

  // "Wenn <subjekt> <verb>, erinnere mich an <objekt>"
  const ifWhenMatch = text.match(/wenn\s+(.+?)\s+(antwortet|wieder da ist|zurück ist|melde)/);
  if (ifWhenMatch) {
    const subjectRaw = ifWhenMatch[1] ?? '';
    const subject = subjectRaw.trim();
    const matchedTemplate = 'if_when_subject';
    const confidence = 0.8;

    const triggerTerms = Object.entries(TRIGGER_CONSOLIDATED).find(([key]) =>
      subject.includes(key),
    )?.[1] ?? [subject];

    return {
      matchedTemplate,
      confidence,
      input: {
        userId: input.userId,
        personaId: input.personaId,
        workspaceId: input.workspaceId ?? '',
        description: input.statement,
        triggerTerms,
        deduplicationKey: `compiled:${input.statement.trim().toLowerCase()}`,
        maxFires: 1,
        cooldownMs: 0,
      },
    };
  }

  return { matchedTemplate: 'none', confidence: 0, input: nullableIntent(input) };
}

function nullableIntent(input: {
  userId: string;
  personaId: string;
  workspaceId?: string;
  statement: string;
}): StandingIntentInput {
  return {
    userId: input.userId,
    personaId: input.personaId,
    workspaceId: input.workspaceId ?? '',
    description: input.statement,
    triggerTerms: [],
    deduplicationKey: `compiled:${input.statement.trim().toLowerCase()}`,
  };
}

export function isStandingIntentCompilerAvailable(): boolean {
  return COMPILER_ENABLED && getWorldModelConfig().enabled;
}

/**
 * Verdrahtet den Compiler in den eingehenden Nachrichtenpfad (chats).
 * Extrahiert Standing-Intent-Aussagen aus Chat-Nachrichten und persistiert
 * sie als validierte `world_model_standing_intents`.
 *
 * Nur affirmative Aussagen im If/Wenn-Muster werden verarbeitet. Die Funktion
 * ist idempotent (deduplication_key).
 */
export async function processIncomingStandingIntents(input: {
  userId: string;
  personaId: string;
  workspaceId?: string;
  text: string;
}): Promise<StandingIntentRecord[] | null> {
  const config = getWorldModelConfig();
  if (!config.enabled && !config.e2eEnabled) return null;
  if (!COMPILER_ENABLED) return null;

  const compiled = compileStandingIntent({
    userId: input.userId,
    personaId: input.personaId,
    workspaceId: input.workspaceId,
    statement: input.text,
  });
  if (compiled.matchedTemplate === 'none') return null;

  try {
    const record = await insertStandingIntent(compiled.input);
    return [record];
  } catch (error) {
    console.error('[world-model:standing-intent] persistence failed:', error);
    return null;
  }
}
