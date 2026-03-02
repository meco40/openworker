import { getModelHubEncryptionKey, getModelHubService } from '@/server/model-hub/runtime';
import { extractJsonObjectFromText } from '@/server/master/execution/runtime/jsonParsing';
import type { Capability, ExecutionPlan } from '@/server/master/execution/runtime/types';

function normalizeCapabilities(input: unknown): Capability[] {
  const raw = Array.isArray(input) ? input : [];
  const normalized: Capability[] = [];
  for (const entry of raw) {
    const value = String(entry || '')
      .trim()
      .toLowerCase();
    if (
      value === 'web_search' ||
      value === 'code_generation' ||
      value === 'notes' ||
      value === 'reminders' ||
      value === 'system_ops'
    ) {
      if (!normalized.includes(value)) {
        normalized.push(value);
      }
    }
  }
  return normalized;
}

export function buildFallbackExecutionPlan(contract: string): ExecutionPlan {
  const normalized = contract.toLowerCase();
  const capabilities: Capability[] = [];

  if (/\b(code|program|script|implement|implementation|module|function)\b/.test(normalized)) {
    capabilities.push('code_generation');
  }
  if (/\b(note|notiz|document|memo)\b/.test(normalized)) {
    capabilities.push('notes');
  }
  if (/\b(remind|reminder|erinner|cron|schedule)\b/.test(normalized)) {
    capabilities.push('reminders');
  }
  if (/\b(system|terminal|command|shell)\b/.test(normalized)) {
    capabilities.push('system_ops');
  }
  if (/\b(search|research|latest|docs|news|source|web)\b/.test(normalized)) {
    capabilities.unshift('web_search');
  }
  if (capabilities.length === 0) {
    capabilities.push('web_search');
  }

  const selected = capabilities.filter((entry, index) => capabilities.indexOf(entry) === index);
  return {
    capabilities: selected.slice(0, 3),
    rationale: 'Fallback planner selected capabilities from rule-based contract analysis.',
    verificationChecks: ['non_empty_outputs', 'structured_outputs', 'capability_phase_coverage'],
    riskProfile: selected.includes('system_ops')
      ? 'high'
      : selected.includes('code_generation')
        ? 'medium'
        : 'low',
    requiresApproval: selected.includes('system_ops') || selected.includes('code_generation'),
    source: 'fallback',
  };
}

export async function buildExecutionPlanWithModel(contract: string): Promise<ExecutionPlan> {
  try {
    const response = await getModelHubService().dispatchWithFallback(
      'p1',
      getModelHubEncryptionKey(),
      {
        messages: [
          {
            role: 'system',
            content: [
              'You are a strict runtime planner for an autonomous execution engine.',
              'Return JSON only with keys:',
              '- capabilities: array of web_search|code_generation|notes|reminders|system_ops',
              '- rationale: string',
              '- verificationChecks: string[]',
              '- riskProfile: low|medium|high',
              '- requiresApproval: boolean',
              'Never return markdown fences.',
            ].join('\n'),
          },
          {
            role: 'user',
            content: `Contract:\n${contract}`,
          },
        ],
        temperature: 0.2,
        max_tokens: 500,
        auditContext: { kind: 'worker_planner' },
      },
    );
    if (!response.ok) {
      throw new Error(response.error || 'planner model call failed');
    }
    const parsed = extractJsonObjectFromText(response.text);
    const capabilities = normalizeCapabilities(parsed?.capabilities);
    if (!capabilities.length) {
      throw new Error('planner model returned no supported capabilities');
    }
    const riskProfileRaw = String(parsed?.riskProfile || '').toLowerCase();
    const riskProfile: ExecutionPlan['riskProfile'] =
      riskProfileRaw === 'high' || riskProfileRaw === 'medium' || riskProfileRaw === 'low'
        ? (riskProfileRaw as ExecutionPlan['riskProfile'])
        : capabilities.includes('system_ops')
          ? 'high'
          : capabilities.includes('code_generation')
            ? 'medium'
            : 'low';
    const verificationChecks = Array.isArray(parsed?.verificationChecks)
      ? parsed.verificationChecks
          .map((entry) => String(entry || '').trim())
          .filter((entry) => entry.length > 0)
      : ['non_empty_outputs', 'structured_outputs', 'capability_phase_coverage'];
    return {
      capabilities: capabilities.slice(0, 3),
      rationale: String(parsed?.rationale || 'Model-generated runtime plan.'),
      verificationChecks,
      riskProfile,
      requiresApproval: Boolean(parsed?.requiresApproval),
      source: 'model',
    };
  } catch {
    return buildFallbackExecutionPlan(contract);
  }
}
