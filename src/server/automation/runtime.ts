import { SqliteAutomationRepository } from './sqliteAutomationRepository';
import { AutomationService } from './service';

interface AutomationRuntimeOptions {
  instanceId: string;
  tickIntervalMs?: number;
  leaseTtlMs?: number;
  maxAttempts?: number;
  retryBackoffMs?: number[];
  autoPauseFailureThreshold?: number;
}

declare global {
  var __automationRepository: SqliteAutomationRepository | undefined;
  var __automationService: AutomationService | undefined;
  var __automationRuntime: AutomationRuntime | undefined;
}

export class AutomationRuntime {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly tickIntervalMs: number;
  private readonly leaseTtlMs: number;
  private readonly maxAttempts: number;
  private readonly retryBackoffMs: number[];
  private readonly autoPauseFailureThreshold: number;

  constructor(
    private readonly service: AutomationService,
    private readonly options: AutomationRuntimeOptions,
  ) {
    this.tickIntervalMs = options.tickIntervalMs ?? 15_000;
    this.leaseTtlMs = options.leaseTtlMs ?? 30_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryBackoffMs = options.retryBackoffMs ?? [30_000, 120_000, 600_000];
    this.autoPauseFailureThreshold = options.autoPauseFailureThreshold ?? 10;
  }

  start(): void {
    if (this.timer) {
      return;
    }

    void this.runOnce();

    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.tickIntervalMs);
    this.timer.unref();
  }

  async runOnce(): Promise<void> {
    const nowIso = new Date().toISOString();
    const hasLease = this.service.acquireLease(this.options.instanceId, this.leaseTtlMs, nowIso);
    if (!hasLease) {
      return;
    }

    try {
      await this.service.processTick({
        nowIso,
        maxAttempts: this.maxAttempts,
        retryBackoffMs: this.retryBackoffMs,
        autoPauseFailureThreshold: this.autoPauseFailureThreshold,
      });
    } catch (error) {
      console.error('[automation] runtime tick failed:', error);
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.service.releaseLease(this.options.instanceId);
  }
}

async function defaultRunPrompt(input: {
  userId: string;
  prompt: string;
  conversationId?: string | null;
}): Promise<{ summary?: string }> {
  const { getMessageService } = await import('../channels/messages/runtime');
  const messageService = getMessageService();
  const conversationId = input.conversationId || messageService.getDefaultWebChatConversation(input.userId).id;
  const result = await messageService.handleWebUIMessage(
    conversationId,
    input.prompt,
    input.userId,
    `automation-${Date.now()}`,
  );

  return {
    summary: result.agentMsg.content.slice(0, 500),
  };
}

export function getAutomationRepository(): SqliteAutomationRepository {
  if (!globalThis.__automationRepository) {
    globalThis.__automationRepository = new SqliteAutomationRepository();
  }
  return globalThis.__automationRepository;
}

export function getAutomationService(): AutomationService {
  if (!globalThis.__automationService) {
    globalThis.__automationService = new AutomationService(getAutomationRepository(), {
      runPrompt: defaultRunPrompt,
    });
  }
  return globalThis.__automationService;
}

export function getAutomationRuntime(instanceId = process.env.SCHEDULER_INSTANCE_ID || 'scheduler-1'): AutomationRuntime {
  if (!globalThis.__automationRuntime) {
    globalThis.__automationRuntime = new AutomationRuntime(getAutomationService(), {
      instanceId,
      tickIntervalMs: Number(process.env.AUTOMATION_TICK_INTERVAL_MS || 15_000),
      leaseTtlMs: Number(process.env.AUTOMATION_LEASE_TTL_MS || 30_000),
      maxAttempts: Number(process.env.AUTOMATION_MAX_ATTEMPTS || 3),
      retryBackoffMs: String(process.env.AUTOMATION_RETRY_BACKOFF_MS || '30000,120000,600000')
        .split(',')
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isFinite(value) && value > 0),
      autoPauseFailureThreshold: Number(process.env.AUTOMATION_AUTO_PAUSE_FAILURES || 10),
    });
  }
  return globalThis.__automationRuntime;
}

export function startAutomationRuntime(instanceId?: string): AutomationRuntime {
  const runtime = getAutomationRuntime(instanceId);
  runtime.start();
  return runtime;
}

export function stopAutomationRuntime(): void {
  globalThis.__automationRuntime?.stop();
}
