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
  }) => Promise<{ summary?: string }>;
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;

export async function executeAgentRunAction(
  input: AgentRunExecutionInput,
  deps: AgentRunExecutorDeps,
): Promise<AgentRunExecutionResult> {
  const timeoutMs = Math.max(1, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    setTimeout(() => {
      reject(new TimeoutError(`Automation run exceeded timeout (${timeoutMs}ms)`));
    }, timeoutMs).unref();
  });

  const result = await Promise.race([
    deps.runPrompt({
      userId: input.userId,
      prompt: input.prompt,
      conversationId: input.conversationId,
    }),
    timeoutPromise,
  ]);

  return { summary: result.summary || 'Automation run completed.' };
}
