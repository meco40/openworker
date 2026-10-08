import { describe, expect, it } from 'vitest';
import { buildRequestBody } from '@/server/model-hub/Models/shared/openai-compatible/request/build';
import { mapPipelineReasoningEffort } from '@/server/model-hub/service/utils';

describe('OpenCode Graphiti reasoning settings', () => {
  it('maps Graphiti off to the OpenCode none value', () => {
    expect(mapPipelineReasoningEffort('off', 'opencode')).toBe('none');
    expect(mapPipelineReasoningEffort('off', 'openai-codex')).toBeUndefined();
  });

  it('keeps low as low for OpenCode', () => {
    expect(mapPipelineReasoningEffort('low', 'opencode')).toBe('low');
  });

  it('serializes the OpenCode reasoning effort in the provider request', () => {
    expect(
      buildRequestBody(
        {
          model: 'x-preview-f-free',
          messages: [{ role: 'user', content: 'Return JSON.' }],
          reasoning_effort: 'none',
        },
        'opencode',
      ),
    ).toMatchObject({
      reasoning_effort: 'none',
      chat_template_kwargs: { enable_thinking: false },
    });

    expect(
      buildRequestBody(
        {
          model: 'x-preview-f-free',
          messages: [{ role: 'user', content: 'Return JSON.' }],
          reasoning_effort: 'low',
        },
        'opencode',
      ),
    ).toMatchObject({
      reasoning_effort: 'low',
      chat_template_kwargs: { enable_thinking: true },
    });
  });
});
