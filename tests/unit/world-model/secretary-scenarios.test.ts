import { describe, expect, it } from 'vitest';
import { ALL_SCENARIOS } from '../../fixtures/world-model/secretary-scenarios';
import { classifyEventUtterance } from '@/server/world-model/services/eventLinker';
import { resolveCorrection } from '@/server/world-model/services/correctionResolver';
import { detectTaskCompletion } from '@/server/knowledge/taskTracker';
import { planQuery } from '@/server/world-model/retrieval/queryPlanner';
import { looksLikeResponse } from '@/server/world-model/services/inboundResponseCorrelation';

describe('World-Model secretary reference scenarios', () => {
  it('keeps all nine fixtures structurally complete and deterministically ordered', () => {
    expect(ALL_SCENARIOS).toHaveLength(9);
    expect(new Set(ALL_SCENARIOS.map((scenario) => scenario.id)).size).toBe(9);
    for (const scenario of ALL_SCENARIOS) {
      expect(scenario.messages.length).toBeGreaterThan(0);
      expect(scenario.messages.map((message) => message.seq)).toEqual(
        [...scenario.messages].map((message) => message.seq).sort((a, b) => a - b),
      );
      expect(scenario.expectedState).toMatchObject({ events: expect.any(Array) });
    }
  });

  it('models the cinema-to-dinner replacement as cancellation plus replacement', () => {
    const scenario = ALL_SCENARIOS.find((item) => item.id === 'cinema-dinner')!;
    expect(classifyEventUtterance(scenario.messages[2]!.content)).toBe('change');
    expect(
      resolveCorrection({
        oldEventStatus: 'planned',
        oldEventId: 'cinema-event',
        newEventProposed: true,
        kind: 'change',
      }),
    ).toMatchObject({ action: 'replace', replacedEventId: 'cinema-event' });
  });

  it('detects the task completion fixture only from a completion signal', () => {
    const scenario = ALL_SCENARIOS.find((item) => item.id === 'task-completion')!;
    const task = {
      id: 'task-1',
      userId: 'user-1',
      personaId: 'persona-1',
      title: 'Bericht bis Freitag fertigstellen',
      description: null,
      taskType: 'one_time' as const,
      status: 'open' as const,
      deadline: null,
      recurrence: null,
      location: null,
      relatedEntityId: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
      sourceConversationId: 'conversation-1',
    };
    expect(detectTaskCompletion(scenario.messages[2]!.content, [task])).toBeTruthy();
    expect(detectTaskCompletion(scenario.messages[0]!.content, [task])).toBeNull();
  });

  it('plans retrospective and response scenarios through the production helpers', () => {
    const retrospective = ALL_SCENARIOS.find((item) => item.id === 'retrospective')!;
    const plan = planQuery({ text: retrospective.messages[3]!.content });
    expect(plan.intent).toBe('what_done');
    expect(plan.timeWindow).toBeTruthy();

    const appointment = ALL_SCENARIOS.find((item) => item.id === 'appointment-followup')!;
    expect(looksLikeResponse(appointment.messages[2]!.content)).toBe(true);
  });
});
