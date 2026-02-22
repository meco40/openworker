export interface AgentRunExecutionInput {
  userId: string;
  prompt: string;
  conversationId?: string | null;
  timeoutMs?: number;
}

export interface AgentRunExecutionResult {
  summary: string;
}

export interface AgentRunExecutorDeps {
  runPrompt: (input: {
    userId: string;
    prompt: string;
    conversationId?: string | null;
    signal?: AbortSignal;
  }) => Promise<{ summary?: string }>;
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;

function normalizeTimeoutMs(timeoutMs: number | undefined): number {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }

  return Math.max(1, Math.floor(timeoutMs));
}

export async function executeAgentRunAction(
  input: AgentRunExecutionInput,
  deps: AgentRunExecutorDeps,
): Promise<AgentRunExecutionResult> {
  const timeoutMs = normalizeTimeoutMs(input.timeoutMs);
  const abortController = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      abortController.abort();
      reject(new TimeoutError(`Automation run exceeded timeout (${timeoutMs}ms)`));
    }, timeoutMs);
    timeoutHandle.unref?.();
  });

  try {
    const result = await Promise.race([
      deps.runPrompt({
        userId: input.userId,
        prompt: input.prompt,
        conversationId: input.conversationId,
        signal: abortController.signal,
      }),
      timeoutPromise,
    ]);

    return { summary: result.summary || 'Automation run completed.' };
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}
