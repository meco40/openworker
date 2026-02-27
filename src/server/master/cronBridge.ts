import type { MasterRepository } from '@/server/master/repository';
import type { MasterReminder, WorkspaceScope } from '@/server/master/types';
import { getAutomationService } from '@/server/automation/runtime';

export interface CronJobDefinition {
  id: string;
  cronExpression: string;
  title: string;
  message: string;
  enabled: boolean;
  automationRuleId?: string | null;
}

function ruleName(scope: WorkspaceScope, reminderId: string): string {
  return `master-reminder:${scope.workspaceId}:${reminderId}`;
}

export class MasterCronBridge {
  constructor(private readonly repo: MasterRepository) {}

  private findRule(scope: WorkspaceScope, reminderId: string) {
    const name = ruleName(scope, reminderId);
    return getAutomationService()
      .listRules(scope.userId)
      .find((rule) => rule.name === name);
  }

  syncReminder(scope: WorkspaceScope, reminder: MasterReminder): void {
    const service = getAutomationService();
    const existing = this.findRule(scope, reminder.id);

    if (!reminder.cronExpression) {
      if (existing) {
        service.updateRule(existing.id, scope.userId, { enabled: false, nextRunAt: null });
      }
      return;
    }

    const prompt = `Master reminder (${scope.workspaceId}/${reminder.id}): ${reminder.message}`;
    if (!existing) {
      service.createRule({
        userId: scope.userId,
        name: ruleName(scope, reminder.id),
        cronExpression: reminder.cronExpression,
        timezone: 'UTC',
        prompt,
        enabled: reminder.status !== 'paused' && reminder.status !== 'cancelled',
      });
      return;
    }

    service.updateRule(existing.id, scope.userId, {
      cronExpression: reminder.cronExpression,
      prompt,
      enabled: reminder.status !== 'paused' && reminder.status !== 'cancelled',
    });
  }

  pauseReminder(scope: WorkspaceScope, reminderId: string): void {
    const existing = this.findRule(scope, reminderId);
    if (!existing) return;
    getAutomationService().updateRule(existing.id, scope.userId, {
      enabled: false,
      nextRunAt: null,
    });
  }

  resumeReminder(scope: WorkspaceScope, reminderId: string): void {
    const existing = this.findRule(scope, reminderId);
    if (!existing) return;
    getAutomationService().updateRule(existing.id, scope.userId, { enabled: true });
  }

  removeReminder(scope: WorkspaceScope, reminderId: string): void {
    const existing = this.findRule(scope, reminderId);
    if (!existing) return;
    getAutomationService().deleteRule(existing.id, scope.userId);
  }

  list(scope: WorkspaceScope): CronJobDefinition[] {
    const service = getAutomationService();
    const rulesByName = new Map(
      service.listRules(scope.userId).map((rule) => [rule.name, rule] as const),
    );

    return this.repo
      .listReminders(scope)
      .filter((entry) => Boolean(entry.cronExpression))
      .map((entry) => {
        const linked = rulesByName.get(ruleName(scope, entry.id));
        return {
          id: entry.id,
          cronExpression: entry.cronExpression || '',
          title: entry.title,
          message: entry.message,
          enabled: linked?.enabled ?? (entry.status !== 'paused' && entry.status !== 'cancelled'),
          automationRuleId: linked?.id || null,
        };
      });
  }
}
