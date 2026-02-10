import type { WorkerQuestion } from '../../../../types';

interface AnalyzeTaskPayload {
  usePlanMode: boolean;
  plan: string[];
  questions: WorkerQuestion[];
  directResult?: string;
}

export function buildAnalyzeTaskPrompt(taskPrompt: string, activeSkillNames: string[]): string {
  return `Task: "${taskPrompt}". Available Tools: ${activeSkillNames.join(', ')}.\nReturn JSON: {"usePlanMode": boolean, "plan": string[], "questions": [{"id": string, "text": string, "options": string[]}], "directResult": string}`;
}

export function parseAnalyzeTaskPayload(raw: string): AnalyzeTaskPayload {
  try {
    const parsed = JSON.parse(raw || '{}') as Partial<AnalyzeTaskPayload>;
    return {
      usePlanMode: Boolean(parsed.usePlanMode),
      plan: Array.isArray(parsed.plan) ? parsed.plan : [],
      questions: Array.isArray(parsed.questions) ? parsed.questions : [],
      directResult: typeof parsed.directResult === 'string' ? parsed.directResult : undefined,
    };
  } catch {
    return {
      usePlanMode: false,
      plan: [],
      questions: [],
      directResult: undefined,
    };
  }
}
