/**
 * GET  /api/worker/[id]/planning  → Get planning state + messages
 * POST /api/worker/[id]/planning  → Start a new planning session (first LLM question)
 */

import { NextResponse } from 'next/server';
import { getWorkerRepository } from '../../../../../src/server/worker/workerRepository';
import { getModelHubService, getModelHubEncryptionKey } from '../../../../../src/server/model-hub/runtime';
import type { PlanningMessage, PlanningQuestion } from '../../../../../src/server/worker/workerTypes';

export const runtime = 'nodejs';

const PLANNING_SYSTEM_PROMPT = `Du bist ein intelligenter Projektplaner. Deine Aufgabe ist es, dem Benutzer gezielte Rückfragen zu stellen, um eine Aufgabe vollständig zu verstehen und zu spezifizieren.

REGELN:
- Stelle EINE Frage auf einmal
- Biete 2-5 konkrete Antwortmöglichkeiten an (Multiple-Choice)
- Fragen sollen helfen, Anforderungen zu konkretisieren
- Nach 3-5 Fragen erstelle eine finale Spezifikation
- Antworte IMMER als valides JSON

FORMAT (Frage):
{
  "type": "question",
  "question": "Deine Frage hier",
  "options": ["Option A", "Option B", "Option C"],
  "context": "Optionaler Kontext warum diese Frage wichtig ist"
}

FORMAT (Finale Spezifikation nach genug Antworten):
{
  "type": "specification",
  "summary": "Zusammenfassung der Anforderungen",
  "steps": ["Schritt 1", "Schritt 2", "Schritt 3"],
  "constraints": ["Einschränkung 1", "Einschränkung 2"]
}`;

function parseLLMResponse(text: string): { type: 'question'; data: PlanningQuestion } | { type: 'specification'; data: { summary: string; steps: string[]; constraints: string[] } } | null {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);

    if (parsed.type === 'question') {
      return {
        type: 'question',
        data: {
          question: parsed.question || 'Wie soll das Projekt umgesetzt werden?',
          options: Array.isArray(parsed.options) ? parsed.options : ['Option A', 'Option B'],
          context: parsed.context,
        },
      };
    }

    if (parsed.type === 'specification') {
      return {
        type: 'specification',
        data: {
          summary: parsed.summary || '',
          steps: Array.isArray(parsed.steps) ? parsed.steps : [],
          constraints: Array.isArray(parsed.constraints) ? parsed.constraints : [],
        },
      };
    }

    return null;
  } catch {
    return null;
  }
}

// GET — return current planning state
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const repo = getWorkerRepository();
    const task = repo.getTask(id);

    if (!task) {
      return NextResponse.json({ ok: false, error: 'Task not found' }, { status: 404 });
    }

    const messages = repo.getPlanningMessages(id);

    return NextResponse.json({
      ok: true,
      planningComplete: task.planningComplete,
      messages,
      status: task.status,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to get planning state';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

// POST — start planning session (generate first question)
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const repo = getWorkerRepository();
    const task = repo.getTask(id);

    if (!task) {
      return NextResponse.json({ ok: false, error: 'Task not found' }, { status: 404 });
    }

    if (task.planningComplete) {
      return NextResponse.json({ ok: false, error: 'Planning already completed' }, { status: 400 });
    }

    // Build initial messages
    const messages: PlanningMessage[] = [
      { role: 'system', content: PLANNING_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Aufgabe: ${task.title}\n\nBeschreibung: ${task.objective}\n\nWorkspace-Typ: ${task.workspaceType}\n\nBitte stelle die erste Frage, um die Anforderungen zu konkretisieren.`,
      },
    ];

    // Call LLM
    const service = getModelHubService();
    const encryptionKey = getModelHubEncryptionKey();

    const result = await service.dispatchWithFallback('p1', encryptionKey, {
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      auditContext: { kind: 'worker_planner', taskId: id },
    });

    if (!result.ok || !result.text) {
      return NextResponse.json({ ok: false, error: 'LLM call failed' }, { status: 502 });
    }

    const assistantMessage: PlanningMessage = { role: 'assistant', content: result.text };
    messages.push(assistantMessage);

    // Save messages
    repo.savePlanningMessages(id, messages);
    repo.updateStatus(id, 'clarifying');

    // Parse response
    const parsed = parseLLMResponse(result.text);

    return NextResponse.json({
      ok: true,
      messages,
      currentQuestion: parsed?.type === 'question' ? parsed.data : null,
      planningComplete: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to start planning';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
