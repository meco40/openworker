import {
  computeNextRunAt,
  validateCronExpression,
  validateTimezone,
} from '@/server/automation/cronEngine';
import { executeAgentRunAction } from '@/server/automation/executor';
import type { AutomationRepository } from '@/server/automation/repository';
import type {
  AutomationRule,
  AutomationRun,
  CreateAutomationRuleInput,
  SchedulerLeaseState,
  UpdateAutomationRuleInput,
} from '@/server/automation/types';

export interface AutomationServiceDeps {
  runPrompt: (input: {
    userId: string;
    prompt: string;
    conversationId?: string | null;
    signal?: AbortSignal;
  }) => Promise<{ summary?: string }>;
}

export interface ProcessTickOptions {
  nowIso?: string;
  maxAttempts: number;
  retryBackoffMs: number[];
  autoPauseFailureThreshold: number;
}

export class AutomationService {
  constructor(
    private readonly repo: AutomationRepository,
    private readonly deps: AutomationServiceDeps,
  ) {}

  createRule(input: CreateAutomationRuleInput): AutomationRule {
    if (!validateTimezone(input.timezone)) {
      throw new Error(`Invalid timezone: ${input.timezone}`);
    }

    if (!validateCronExpression(input.cronExpression, input.timezone)) {
      throw new Error('Invalid cron expression');
    }

    const nextRunAt =
      input.nextRunAt !== undefined
        ? input.nextRunAt
        : input.enabled
          ? computeNextRunAt(input.cronExpression, input.timezone)
          : null;

    return this.repo.createRule({ ...input, nextRunAt });
  }

  updateRule(
    ruleId: string,
    userId: string,
    patch: UpdateAutomationRuleInput,
  ): AutomationRule | null {
    const existing = this.repo.getRule(ruleId, userId);
    if (!existing) {
      return null;
    }

    const timezone = patch.timezone ?? existing.timezone;
    const cronExpression = patch.cronExpression ?? existing.cronExpression;

    if (patch.timezone !== undefined && !validateTimezone(timezone)) {
      throw new Error(`Invalid timezone: ${timezone}`);
    }
    if (patch.cronExpression !== undefined || patch.timezone !== undefined) {
      if (!validateCronExpression(cronExpression, timezone)) {
        throw new Error('Invalid cron expression');
      }
    }

    let nextRunAt = patch.nextRunAt;
    if (
      nextRunAt === undefined &&
      (patch.cronExpression !== undefined || patch.timezone !== undefined)
    ) {
      nextRunAt = existing.enabled
        ? computeNextRunAt(cronExpression, timezone, new Date().toISOString())
        : null;
    }

    if (patch.enabled !== undefined) {
      if (patch.enabled) {
        nextRunAt =
          nextRunAt ?? computeNextRunAt(cronExpression, timezone, new Date().toISOString());
      } else {
        nextRunAt = null;
      }
    }

    return this.repo.updateRule(ruleId, userId, {
      ...patch,
      nextRunAt,
      lastError: patch.enabled === true ? null : patch.lastError,
    });
  }

  deleteRule(ruleId: string, userId: string): boolean {
    return this.repo.deleteRule(ruleId, userId);
  }

  getRule(ruleId: string, userId: string): AutomationRule | null {
    return this.repo.getRule(ruleId, userId);
  }

  listRules(userId: string): AutomationRule[] {
    return this.repo.listRules(userId);
  }

  createManualRun(ruleId: string, userId: string): AutomationRun {
    const rule = this.repo.getRule(ruleId, userId);
    if (!rule) {
      throw new Error('Automation rule not found');
    }

    const scheduledFor = new Date().toISOString();
    const runKey = `${rule.id}:${scheduledFor}:manual`;
    return this.repo.createOrGetRun({
      ruleId: rule.id,
      userId: rule.userId,
      triggerSource: 'manual',
      scheduledFor,
      runKey,
      nextAttemptAt: scheduledFor,
      attempt: 0,
    });
  }

  listRuns(ruleId: string, userId: string, limit?: number): AutomationRun[] {
    return this.repo.listRuns(ruleId, userId, limit);
  }

  acquireLease(instanceId: string, ttlMs: number, nowIso?: string): boolean {
    return this.repo.acquireLease(instanceId, ttlMs, nowIso);
  }

  releaseLease(instanceId: string): void {
    this.repo.releaseLease(instanceId);
  }

  getLeaseState(): SchedulerLeaseState | null {
    return this.repo.getLeaseState();
  }

  getMetrics(): {
    activeRules: number;
    queuedRuns: number;
    runningRuns: number;
    deadLetterRuns: number;
    leaseAgeSeconds: number | null;
  } {
    const lease = this.repo.getLeaseState();
    const now = Date.now();
    const leaseAgeSeconds = lease
      ? Math.floor((now - new Date(lease.updatedAt).getTime()) / 1000)
      : null;

    return {
      activeRules: this.repo.countActiveRules(),
      queuedRuns: this.repo.countRunsByStatus('queued'),
      runningRuns: this.repo.countRunsByStatus('running'),
      deadLetterRuns: this.repo.countRunsByStatus('dead_letter'),
      leaseAgeSeconds,
    };
  }

  async processTick(options: ProcessTickOptions): Promise<void> {
    const nowIso = options.nowIso || new Date().toISOString();

    this.enqueueDueRules(nowIso);
    await this.executeQueuedRuns(nowIso, options);
  }

  private enqueueDueRules(nowIso: string): void {
    const dueRules = this.repo.listDueRules(nowIso, 100);

    for (const rule of dueRules) {
      if (!rule.nextRunAt) {
        continue;
      }

      const runKey = `${rule.id}:${rule.nextRunAt}`;
      this.repo.createOrGetRun({
        ruleId: rule.id,
        userId: rule.userId,
        triggerSource: 'cron',
        scheduledFor: rule.nextRunAt,
        runKey,
        attempt: 0,
        nextAttemptAt: nowIso,
      });

      // Misfire policy: at most one catch-up on restart, then schedule from "now".
      const nextRunAt = computeNextRunAt(rule.cronExpression, rule.timezone, nowIso);
      this.repo.updateRule(rule.id, rule.userId, { nextRunAt });
    }
  }

  private async executeQueuedRuns(nowIso: string, options: ProcessTickOptions): Promise<void> {
    const runs = this.repo.listQueuedRunsDue(nowIso, 100);

    for (const run of runs) {
      const rule = this.repo.getRuleById(run.ruleId);
      if (!rule) {
        const finishedAt = new Date().toISOString();
        this.repo.markRunDeadLetter(run.id, 'Rule no longer exists.', finishedAt);
        this.repo.recordDeadLetter(run.id, run.ruleId, 'Rule no longer exists.');
        continue;
      }

      const startedAt = new Date().toISOString();
      this.repo.markRunRunning(run.id, startedAt);

      try {
        const result = await executeAgentRunAction(
          {
            userId: rule.userId,
            prompt: rule.prompt,
            timeoutMs: 60_000,
          },
          { runPrompt: this.deps.runPrompt },
        );

        const finishedAt = new Date().toISOString();
        this.repo.markRunSucceeded(run.id, finishedAt, result.summary);
        this.repo.updateRule(rule.id, rule.userId, {
          consecutiveFailures: 0,
          lastError: null,
          lastRunAt: run.scheduledFor,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unknown automation execution error';
        const attempt = run.attempt + 1;

        if (attempt >= options.maxAttempts) {
          const finishedAt = new Date().toISOString();
          this.repo.markRunDeadLetter(run.id, message, finishedAt);
          this.repo.recordDeadLetter(run.id, run.ruleId, message);

          const failures = rule.consecutiveFailures + 1;
          const shouldPause = failures >= options.autoPauseFailureThreshold;
          this.repo.updateRule(rule.id, rule.userId, {
            consecutiveFailures: failures,
            lastError: message,
            enabled: shouldPause ? false : rule.enabled,
            nextRunAt: shouldPause ? null : rule.nextRunAt,
          });
          continue;
        }

        const backoffMs =
          options.retryBackoffMs[Math.min(attempt - 1, options.retryBackoffMs.length - 1)] || 1_000;
        const nextAttemptAt = new Date(Date.now() + backoffMs).toISOString();
        this.repo.markRunForRetry(run.id, attempt, message, nextAttemptAt);
      }
    }
  }
}
