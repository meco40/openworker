import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests for services/gateway.ts — the client-side AI gateway service.
 *
 * We mock global.fetch to verify requests go to /api/model-hub/gateway
 * with the correct payload structure.
 */

// ── Dynamic import so we can mock fetch before the module loads ─

describe('services/gateway', () => {
  let ai: typeof import('../../../services/gateway').ai;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    // Reset module registry for fresh import each test
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockFetch(responseBody: unknown, status = 200) {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => responseBody,
    }) as unknown as typeof fetch;
  }

  async function loadGateway() {
    const mod = await import('../../../services/gateway');
    ai = mod.ai;
    return mod;
  }

  // ── ai.models.generateContent ───────────────────────────────

  describe('ai.models.generateContent', () => {
    it('sends request to /api/model-hub/gateway', async () => {
      mockFetch({
        ok: true,
        text: 'Hello from gateway',
        model: 'gemini-2.5-flash',
        provider: 'gemini',
      });
      await loadGateway();

      const result = await ai.models.generateContent({
        contents: 'What is 2+2?',
      });

      expect(result.text).toBe('Hello from gateway');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/model-hub/gateway',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });

    it('passes systemInstruction and tools in the request body', async () => {
      mockFetch({ ok: true, text: 'OK', model: 'test', provider: 'test' });
      await loadGateway();

      await ai.models.generateContent({
        contents: 'test',
        config: {
          systemInstruction: 'You are helpful',
          tools: [{ functionDeclarations: [{ name: 'test_tool' }] }],
          responseMimeType: 'application/json',
        },
      });

      const callBody = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
      expect(callBody.systemInstruction).toBe('You are helpful');
      expect(callBody.tools).toHaveLength(1);
      expect(callBody.responseMimeType).toBe('application/json');
    });

    it('returns functionCalls from gateway response', async () => {
      mockFetch({
        ok: true,
        text: '',
        model: 'test',
        provider: 'test',
        functionCalls: [{ name: 'core_memory_store', args: { type: 'fact', content: 'hi' } }],
      });
      await loadGateway();

      const result = await ai.models.generateContent({ contents: 'remember this' });
      expect(result.functionCalls).toHaveLength(1);
      expect(result.functionCalls![0].name).toBe('core_memory_store');
    });

    it('throws on gateway error response', async () => {
      mockFetch({ ok: false, error: 'No active models in pipeline.' }, 502);
      await loadGateway();

      await expect(ai.models.generateContent({ contents: 'test' })).rejects.toThrow(
        'No active models in pipeline.',
      );
    });

    it('handles contents array (multi-turn format)', async () => {
      mockFetch({ ok: true, text: 'response', model: 'test', provider: 'test' });
      await loadGateway();

      await ai.models.generateContent({
        contents: [
          { role: 'user', parts: [{ text: 'Hello' }] },
          { role: 'model', parts: [{ text: 'Hi there!' }] },
          { role: 'user', parts: [{ text: 'How are you?' }] },
        ],
      });

      const callBody = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
      expect(callBody.messages).toHaveLength(3);
      expect(callBody.messages[0].role).toBe('user');
      expect(callBody.messages[1].role).toBe('assistant');
      expect(callBody.messages[2].role).toBe('user');
    });
  });

  // ── ai.models.embedContent ─────────────────────────────────

  describe('ai.models.embedContent', () => {
    it('sends embedContent operation to gateway', async () => {
      mockFetch({ embedding: { values: [0.1, 0.2, 0.3] } });
      await loadGateway();

      const result = await ai.models.embedContent({
        model: 'text-embedding-004',
        content: { parts: [{ text: 'test' }] },
      });

      expect(result.embedding?.values).toEqual([0.1, 0.2, 0.3]);

      const callBody = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
      expect(callBody.operation).toBe('embedContent');
    });
  });

  // ── ai.chats.create ────────────────────────────────────────

  describe('ai.chats.create', () => {
    it('creates a chat with history management', async () => {
      mockFetch({ ok: true, text: 'Hi there!', model: 'test', provider: 'test' });
      await loadGateway();

      const chat = ai.chats.create({
        config: {
          systemInstruction: 'You are helpful.',
          tools: [],
        },
      });

      const stream = await chat.sendMessageStream({ message: 'Hello!' });
      const chunks: any[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0].text).toBe('Hi there!');
    });

    it('accumulates conversation history across messages', async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        callCount++;
        return {
          ok: true,
          json: async () => ({
            ok: true,
            text: `Response ${callCount}`,
            model: 'test',
            provider: 'test',
          }),
        };
      }) as unknown as typeof fetch;

      await loadGateway();

      const chat = ai.chats.create({
        config: { systemInstruction: 'System msg' },
      });

      // First message
      const stream1 = await chat.sendMessageStream({ message: 'First' });
      for await (const _ of stream1) {
        /* consume */
      }

      // Second message — should include history
      const stream2 = await chat.sendMessageStream({ message: 'Second' });
      for await (const _ of stream2) {
        /* consume */
      }

      const secondCallBody = JSON.parse((globalThis.fetch as any).mock.calls[1][1].body);
      expect(secondCallBody.messages).toHaveLength(4); // system + user1 + assistant1 + user2
      expect(secondCallBody.messages[0].role).toBe('system');
      expect(secondCallBody.messages[1].role).toBe('user');
      expect(secondCallBody.messages[1].content).toBe('First');
      expect(secondCallBody.messages[2].role).toBe('assistant');
      expect(secondCallBody.messages[2].content).toBe('Response 1');
      expect(secondCallBody.messages[3].role).toBe('user');
      expect(secondCallBody.messages[3].content).toBe('Second');
    });

    it('does not set model when not provided (pipeline selects)', async () => {
      mockFetch({ ok: true, text: 'OK', model: 'auto-selected', provider: 'test' });
      await loadGateway();

      const chat = ai.chats.create({ config: {} });
      const stream = await chat.sendMessageStream({ message: 'test' });
      for await (const _ of stream) {
        /* consume */
      }

      const callBody = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
      expect(callBody.model).toBeUndefined();
    });
  });

  // ── ai.live.connect ────────────────────────────────────────

  describe('ai.live.connect', () => {
    it('throws error since live mode is not supported via gateway', async () => {
      await loadGateway();
      await expect(ai.live.connect()).rejects.toThrow('Live audio mode is not available');
    });
  });
});
