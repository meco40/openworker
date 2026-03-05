import type { MasterRepository } from '@/server/master/repository';
import type { WorkspaceScope } from '@/server/master/types';
import { getModelHubEncryptionKey, getModelHubService } from '@/server/model-hub/runtime';
import { getMasterRuntimePersonaConfig } from '@/server/master/runtimePersona';

export function shouldRunLearningCycleAt(date: Date): boolean {
  return date.getUTCHours() === 3 && date.getUTCMinutes() === 0;
}

function parseJsonObject(payload: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseAiDelta(payload: string): { delta: number | null; evidenceCount: number | null } {
  const parsed = parseJsonObject(payload);
  const deltaRaw = Number(parsed?.delta);
  const evidenceRaw = Number(parsed?.evidenceCount);
  const delta =
    Number.isFinite(deltaRaw) && deltaRaw >= -0.05 && deltaRaw <= 0.05 ? deltaRaw : null;
  const evidenceCount = Number.isFinite(evidenceRaw) && evidenceRaw >= 0 ? evidenceRaw : null;
  return { delta, evidenceCount };
}

async function computeAiConfidenceAdjustment(input: {
  capability: string;
  confidence: number;
  benchmarkSummary: string;
  scope: WorkspaceScope;
}): Promise<{ delta: number | null; evidenceCount: number | null }> {
  if (String(process.env.MASTER_AI_RUNTIME_V2 || '').trim() !== '1') {
    return { delta: null, evidenceCount: null };
  }
  try {
    const runtimePersona = getMasterRuntimePersonaConfig(input.scope);
    const response = await getModelHubService().dispatchWithFallback(
      runtimePersona.modelHubProfileId,
      getModelHubEncryptionKey(),
      {
        messages: [
          {
            role: 'system',
            content: [
              runtimePersona.systemInstruction,
              'You evaluate capability confidence updates.',
              'Return JSON only with keys:',
              '- delta: number between -0.05 and 0.05',
              '- evidenceCount: integer >= 0',
            ]
              .filter(Boolean)
              .join('\n\n'),
          },
          {
            role: 'user',
            content: [
              `capability=${input.capability}`,
              `confidence=${input.confidence}`,
              `benchmarkSummary=${input.benchmarkSummary}`,
            ].join('\n'),
          },
        ],
        temperature: 0.1,
        max_tokens: 120,
        auditContext: { kind: 'worker_planner' },
      },
    );
    if (!response.ok) {
      return { delta: null, evidenceCount: null };
    }
    return parseAiDelta(response.text);
  } catch {
    return { delta: null, evidenceCount: null };
  }
}

export async function runCapabilityUnderstandingCycle(
  repo: MasterRepository,
  scope: WorkspaceScope,
  now = new Date(),
): Promise<{ updated: number; executed: boolean }> {
  if (!shouldRunLearningCycleAt(now)) {
    return { updated: 0, executed: false };
  }
  const scores = repo.listCapabilityScores(scope);
  let updated = 0;
  for (const score of scores) {
    const ai = await computeAiConfidenceAdjustment({
      capability: score.capability,
      confidence: score.confidence,
      benchmarkSummary: score.benchmarkSummary,
      scope,
    });
    const fallbackDelta = 0.01;
    const delta = ai.delta ?? fallbackDelta;
    const boosted = Math.max(0, Math.min(1, score.confidence + delta));
    const benchmarkSummary = JSON.stringify({
      source: ai.delta === null ? 'heuristic' : 'ai',
      version: ai.delta === null ? 'v1' : 'v2',
      evidenceCount: ai.evidenceCount ?? 0,
      previous: score.benchmarkSummary,
    });
    repo.upsertCapabilityScore(
      scope,
      score.capability,
      boosted,
      benchmarkSummary,
      now.toISOString(),
    );
    updated += 1;
  }
  return { updated, executed: true };
}
