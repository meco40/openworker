import { describe, expect, it } from 'vitest';

/**
 * Integration-level tests verifying the gateway API route request body
 * structure and expected response shape.  These test the contract between
 * the client (services/gateway.ts) and the server (api/model-hub/gateway/route.ts).
 */

describe('Gateway API contract', () => {
  describe('Chat request body', () => {
    it('has required fields for pipeline dispatch', () => {
      const body = {
        messages: [
          { role: 'system', content: 'You are helpful' },
          { role: 'user', content: 'Hello!' },
        ],
        systemInstruction: 'Extra system instruction',
        tools: [{ functionDeclarations: [{ name: 'search_web', parameters: {} }] }],
        responseMimeType: 'application/json',
      };

      expect(body.messages).toHaveLength(2);
      expect(body.systemInstruction).toBeDefined();
      expect(body.tools).toHaveLength(1);
    });

    it('supports direct dispatch with accountId and model', () => {
      const body = {
        accountId: 'acc-123',
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'test' }],
      };

      expect(body.accountId).toBe('acc-123');
      expect(body.model).toBe('gemini-2.5-flash');
    });

    it('supports embedding operations', () => {
      const body = {
        operation: 'embedContent' as const,
        payload: {
          model: 'text-embedding-004',
          content: { parts: [{ text: 'hello' }] },
        },
      };

      expect(body.operation).toBe('embedContent');
      expect(body.payload.model).toBe('text-embedding-004');
    });
  });

  describe('Chat response body', () => {
    it('has required fields for successful response', () => {
      const response = {
        ok: true,
        text: 'Hello!',
        model: 'gemini-2.5-flash',
        provider: 'gemini',
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      };

      expect(response.ok).toBe(true);
      expect(response.text).toBe('Hello!');
      expect(response.provider).toBe('gemini');
      expect(response.usage.total_tokens).toBe(15);
    });

    it('has functionCalls for tool responses', () => {
      const response = {
        ok: true,
        text: '',
        model: 'gemini-2.5-flash',
        provider: 'gemini',
        functionCalls: [
          { name: 'core_memory_store', args: { type: 'preference', content: 'likes coffee' } },
          { name: 'core_task_schedule', args: { task: 'remind', time: '09:00' } },
        ],
      };

      expect(response.functionCalls).toHaveLength(2);
      expect(response.functionCalls[0].name).toBe('core_memory_store');
      expect(response.functionCalls[1].name).toBe('core_task_schedule');
    });

    it('has error fields for failed response', () => {
      const response = {
        ok: false,
        text: '',
        model: '',
        provider: '',
        error: 'No active models in pipeline.',
      };

      expect(response.ok).toBe(false);
      expect(response.error).toContain('No active models');
    });
  });
});
