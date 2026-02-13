import { describe, expect, it } from 'vitest';

/**
 * We test the extractGeminiFunctionCalls helper directly by importing it
 * from the Gemini adapter module.  Since that function is not exported
 * by the adapter (it is file-scoped), we extract the same logic here and
 * validate it against representative Gemini SDK response shapes.
 */

// ─── Inline the extraction logic for unit testing ─────────────

function extract(result: unknown): Array<{ name: string; args?: unknown }> {
  if (!result || typeof result !== 'object') return [];
  const typed = result as {
    functionCalls?: Array<{ name: string; args?: unknown }>;
    candidates?: Array<{
      content?: {
        parts?: Array<{ functionCall?: { name: string; args?: unknown } }>;
      };
    }>;
  };

  if (Array.isArray(typed.functionCalls) && typed.functionCalls.length > 0) {
    return typed.functionCalls;
  }

  const parts = typed.candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((part) => part.functionCall)
    .filter((call): call is { name: string; args?: unknown } => Boolean(call && call.name));
}

// ─── Tests ────────────────────────────────────────────────────

describe('extractGeminiFunctionCalls', () => {
  it('extracts from top-level functionCalls array', () => {
    const result = {
      functionCalls: [{ name: 'core_memory_store', args: { type: 'fact', content: 'test' } }],
    };
    const calls = extract(result);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('core_memory_store');
    expect(calls[0].args).toEqual({ type: 'fact', content: 'test' });
  });

  it('extracts from candidates[].content.parts[].functionCall', () => {
    const result = {
      candidates: [
        {
          content: {
            parts: [
              { functionCall: { name: 'search_web', args: { query: 'hello' } } },
              { text: 'some text' },
              { functionCall: { name: 'core_memory_recall', args: { query: 'test' } } },
            ],
          },
        },
      ],
    };
    const calls = extract(result);
    expect(calls).toHaveLength(2);
    expect(calls[0].name).toBe('search_web');
    expect(calls[1].name).toBe('core_memory_recall');
  });

  it('returns empty array for plain text responses', () => {
    const result = {
      text: 'Hello!',
      candidates: [{ content: { parts: [{ text: 'Hello!' }] } }],
    };
    expect(extract(result)).toHaveLength(0);
  });

  it('prefers top-level functionCalls over candidates', () => {
    const result = {
      functionCalls: [{ name: 'top_level', args: {} }],
      candidates: [
        {
          content: {
            parts: [{ functionCall: { name: 'candidate_level', args: {} } }],
          },
        },
      ],
    };
    const calls = extract(result);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('top_level');
  });

  it('handles null/undefined result gracefully', () => {
    expect(extract(null)).toHaveLength(0);
    expect(extract(void 0)).toHaveLength(0);
    expect(extract({})).toHaveLength(0);
  });
});
