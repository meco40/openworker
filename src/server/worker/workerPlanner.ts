// ─── Worker Planner ──────────────────────────────────────────
// AI-based task analysis: breaks an objective into executable steps.
// Now with Persona integration for customized planning behavior.

import { getModelHubService, getModelHubEncryptionKey } from '../model-hub/runtime';
import { loadPersonaContext, buildPersonaSystemPrompt } from './personaIntegration';
import type { WorkerTaskRecord } from './workerTypes';

const PLANNER_PROMPT = `Du bist ein Task-Planer. Analysiere die folgende Aufgabe und erstelle einen schrittweisen Plan.

REGELN:
- Maximal 10 Schritte
- Jeder Schritt muss eine klare, ausführbare Aktion sein
- Schritte in logischer Reihenfolge
- Format: Gib NUR ein JSON-Array mit Strings zurück, z.B.:
  ["Projektstruktur erstellen", "Dateien anlegen", "Code schreiben", "Testen"]

AUFGABE:`;

export interface TaskPlan {
  steps: string[];
}

export const LEGACY_WORKER_PLANNER = true;

/**
 * Uses AI to analyze a task objective and generate an execution plan.
 * Now supports Persona context for customized planning behavior.
 */
export async function planTask(task: WorkerTaskRecord): Promise<TaskPlan> {
  const service = getModelHubService();
  const encryptionKey = getModelHubEncryptionKey();

  // Load persona context if assigned
  const personaContext = await loadPersonaContext(task.assignedPersonaId);

  // Build system prompt with persona context
  const systemPrompt = buildPersonaSystemPrompt(
    PLANNER_PROMPT,
    personaContext,
    {
      title: task.title,
      objective: task.objective,
      workspaceType: task.workspaceType || 'general',
      step: 'Planung', // Planning phase
    },
  );

  const result = await service.dispatchWithFallback('p1', encryptionKey, {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Titel: ${task.title}\n\nObjective: ${task.objective}` },
    ],
    auditContext: {
      kind: 'worker_planner',
      taskId: task.id,
    },
  });

  if (!result.ok || !result.text) {
    return { steps: ['Aufgabe analysieren und ausführen'] };
  }

  try {
    // Extract JSON array from response (may be wrapped in markdown)
    const jsonMatch = result.text.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) {
      return { steps: [result.text.trim()] };
    }

    const steps = JSON.parse(jsonMatch[0]);
    if (
      Array.isArray(steps) &&
      steps.length > 0 &&
      steps.every((s: unknown) => typeof s === 'string')
    ) {
      return { steps: steps.slice(0, 10) };
    }
  } catch {
    // Fallback: treat entire response as a single step
  }

  return { steps: ['Aufgabe analysieren und ausführen'] };
}
