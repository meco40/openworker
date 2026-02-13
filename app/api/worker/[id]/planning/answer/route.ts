/**
 * POST /api/worker/[id]/planning/answer → Send user answer, get next question or spec
 */

import { NextResponse } from 'next/server';
import { getWorkerRepository } from '../../../../../../src/server/worker/workerRepository';
import {
  getModelHubService,
  getModelHubEncryptionKey,
} from '../../../../../../src/server/model-hub/runtime';
import { processQueue } from '../../../../../../src/server/worker/workerAgent';
import type {
  PlanningMessage,
  PlanningQuestion,
} from '../../../../../../src/server/worker/workerTypes';

export const runtime = 'nodejs';

function parseLLMResponse(
  text: string,
):
  | { type: 'question'; data: PlanningQuestion }
  | { type: 'specification'; data: { summary: string; steps: string[]; constraints: string[] } }
  | null {
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

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
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

    const body = (await request.json()) as { answer: string };

    if (!body.answer) {
      return NextResponse.json({ ok: false, error: 'answer is required' }, { status: 400 });
    }

    // Get existing messages and append user answer
    const messages = repo.getPlanningMessages(id);
    const userMessage: PlanningMessage = { role: 'user', content: body.answer };
    messages.push(userMessage);

    // Call LLM with full conversation
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

    // Parse response
    const parsed = parseLLMResponse(result.text);

    // If specification → complete planning & queue task
    if (parsed?.type === 'specification') {
      const spec = parsed.data;

      // Update objective with enriched specification
      const enrichedObjective =
        `${task.objective}\n\n--- Spezifikation ---\n${spec.summary}` +
        (spec.constraints.length > 0
          ? `\n\nEinschränkungen:\n${spec.constraints.map((c) => `- ${c}`).join('\n')}`
          : '');

      repo.savePlanningMessages(id, messages);
      repo.completePlanning(id);

      // Update task objective with enriched specification and move to queued
      repo.updateObjective(id, enrichedObjective);
      repo.updateStatus(id, 'queued', { summary: undefined });

      repo.addActivity({
        taskId: id,
        type: 'status_change',
        message: 'Planung abgeschlossen — Task in Warteschlange verschoben',
        metadata: { from: 'clarifying', to: 'queued', specSteps: spec.steps.length },
      });

      // Trigger queue processing
      processQueue().catch((err: unknown) => console.error('[Planning] Queue error:', err));

      return NextResponse.json({
        ok: true,
        messages,
        specification: spec,
        planningComplete: true,
        currentQuestion: null,
      });
    }

    // More questions
    repo.savePlanningMessages(id, messages);

    return NextResponse.json({
      ok: true,
      messages,
      currentQuestion: parsed?.type === 'question' ? parsed.data : null,
      planningComplete: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to process answer';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
