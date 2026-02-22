import { ModelHubService } from '@/server/model-hub/service';
import { SqliteModelHubRepository } from '@/server/model-hub/repositories/sqliteModelHubRepository';
import type { GatewayRequest, GatewayResponse } from '@/server/model-hub/gateway';

const DEV_FALLBACK_KEY = '0123456789abcdef0123456789abcdef';

declare global {
  var __modelHubRepository: SqliteModelHubRepository | undefined;
  var __modelHubService: ModelHubService | undefined;
}

function isModelHubTestMode(): boolean {
  return String(process.env.MODEL_HUB_TEST_MODE || '').trim() === '1';
}

function createAbortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

async function delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  const stepMs = 25;
  const maxIterations = Math.ceil(ms / stepMs);
  for (let i = 0; i < maxIterations; i += 1) {
    if (signal?.aborted) {
      throw createAbortError();
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

function getLastUserMessage(request: Omit<GatewayRequest, 'model'>): string {
  const messages = Array.isArray(request.messages) ? request.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const entry = messages[i];
    if (entry?.role === 'user' && typeof entry.content === 'string') {
      return entry.content;
    }
  }
  return '';
}

function buildTestModeService(): ModelHubService {
  const runtime = {
    async dispatchWithFallback(
      profileId: string,
      _encryptionKey: string,
      request: Omit<GatewayRequest, 'model'>,
      options?: {
        signal?: AbortSignal;
        modelOverride?: string;
        onStreamDelta?: (delta: string) => void;
      },
    ): Promise<GatewayResponse> {
      if (options?.signal?.aborted) {
        throw createAbortError();
      }

      const lastUserMessage = getLastUserMessage(request);
      const hasParallelToolResult = lastUserMessage.includes('Tool "multi_tool_use.parallel"');

      if (lastUserMessage.includes('parallel-check') && !hasParallelToolResult) {
        return {
          ok: true,
          text: '',
          provider: 'test-mode',
          model: options?.modelOverride || 'test-mode-model',
          functionCalls: [
            {
              name: 'multi_tool_use.parallel',
              args: {
                tool_uses: [
                  {
                    recipient_name: 'functions.shell_execute',
                    parameters: { command: 'echo parallel-nexus' },
                  },
                ],
              },
            },
          ],
        };
      }

      if (lastUserMessage.includes('E2E_ABORT_WAIT')) {
        await delayWithAbort(2_000, options?.signal);
      }

      if (options?.onStreamDelta) {
        options.onStreamDelta('fixture ');
        await delayWithAbort(40, options.signal);
        options.onStreamDelta('response');
      }

      return {
        ok: true,
        text: hasParallelToolResult
          ? '[test-mode] parallel flow complete'
          : `[test-mode:${profileId}] ${lastUserMessage || 'ok'}`,
        provider: 'test-mode',
        model: options?.modelOverride || 'test-mode-model',
      };
    },
  };

  return runtime as unknown as ModelHubService;
}

export function getModelHubEncryptionKey(): string {
  const key = process.env.MODEL_HUB_ENCRYPTION_KEY?.trim();
  if (key && key.length > 0) return key;

  if (process.env.NODE_ENV !== 'production') {
    return DEV_FALLBACK_KEY;
  }

  throw new Error('Missing MODEL_HUB_ENCRYPTION_KEY');
}

function getModelHubRepository(): SqliteModelHubRepository {
  if (!globalThis.__modelHubRepository) {
    globalThis.__modelHubRepository = new SqliteModelHubRepository();
  }
  return globalThis.__modelHubRepository;
}

export function getModelHubService(): ModelHubService {
  if (isModelHubTestMode()) {
    if (!globalThis.__modelHubService) {
      globalThis.__modelHubService = buildTestModeService();
    }
    return globalThis.__modelHubService;
  }

  if (!globalThis.__modelHubService) {
    globalThis.__modelHubService = new ModelHubService(getModelHubRepository());
  }
  return globalThis.__modelHubService;
}
