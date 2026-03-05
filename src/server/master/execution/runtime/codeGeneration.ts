import { getModelHubEncryptionKey, getModelHubService } from '@/server/model-hub/runtime';
import { getMasterRuntimePersonaConfig } from '@/server/master/runtimePersona';
import { extractJsonObjectFromText } from '@/server/master/execution/runtime/jsonParsing';
import type { MasterRun } from '@/server/master/types';
import type { RuntimeMode } from '@/server/master/execution/runtime/types';

export async function buildCodeGenerationContent(input: {
  run: MasterRun;
  filePath: string;
  scope: { userId: string; personaId?: string | null };
}): Promise<{ content: string; mode: RuntimeMode; degradedMode: boolean }> {
  const fallbackContent = [
    '# Master Generated Program Draft',
    '',
    `Contract: ${input.run.contract}`,
    '',
    '## Proposed implementation',
    '- Define a small module boundary first.',
    '- Add automated tests for the critical path.',
    '- Verify with typecheck, lint, and focused test runs.',
  ].join('\n');

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
              runtimePersona.preferredModelId
                ? `Preferred model hint: ${runtimePersona.preferredModelId}`
                : null,
              'You generate implementation drafts for coding tasks.',
              'Return JSON only with keys:',
              '- files: [{ path: string, content: string }]',
              '- patchPlan: string[]',
              '- testPlan: string[]',
              '- summary: string',
              'Do not return markdown fences.',
            ]
              .filter(Boolean)
              .join('\n\n'),
          },
          {
            role: 'user',
            content: `Contract:\n${input.run.contract}`,
          },
        ],
        temperature: 0.3,
        max_tokens: 1000,
        auditContext: { kind: 'worker_executor', taskId: input.run.id },
      },
    );
    if (!response.ok) {
      throw new Error(response.error || 'code generation model call failed');
    }
    const parsed = extractJsonObjectFromText(response.text);
    const files = Array.isArray(parsed?.files) ? parsed.files : [];
    const firstFile = files.find(
      (entry) =>
        entry &&
        typeof entry === 'object' &&
        typeof (entry as { content?: unknown }).content === 'string',
    ) as { path?: string; content: string } | undefined;
    const fileContent = String(firstFile?.content || '').trim();
    if (!fileContent) {
      throw new Error('model returned empty code generation content');
    }
    const summary = String(parsed?.summary || '').trim();
    return {
      content: summary.length > 0 ? `${fileContent}\n\n---\n\nSummary: ${summary}` : fileContent,
      mode: 'model',
      degradedMode: false,
    };
  } catch {
    return {
      content: fallbackContent,
      mode: 'fallback',
      degradedMode: true,
    };
  }
}
