import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteMasterRepository } from '@/server/master/repository/sqliteMasterRepository';
import { MasterCronBridge } from '@/server/master/cronBridge';
import { MasterRemindersService } from '@/server/master/reminders';

interface MockAutomationRule {
  id: string;
  userId: string;
  name: string;
  cronExpression: string;
  timezone: string;
  prompt: string;
  enabled: boolean;
  nextRunAt: string | null;
}

const automationState: { rules: MockAutomationRule[] } = { rules: [] };

vi.mock('@/server/automation/runtime', () => ({
  getAutomationService: () => ({
    createRule(input: {
      userId: string;
      name: string;
      cronExpression: string;
      timezone: string;
      prompt: string;
      enabled: boolean;
    }) {
      const rule: MockAutomationRule = {
        id: `rule-${automationState.rules.length + 1}`,
        userId: input.userId,
        name: input.name,
        cronExpression: input.cronExpression,
        timezone: input.timezone,
        prompt: input.prompt,
        enabled: input.enabled,
        nextRunAt: input.enabled ? '2026-03-07T03:00:00.000Z' : null,
      };
      automationState.rules.push(rule);
      return rule;
    },
    updateRule(ruleId: string, userId: string, patch: Partial<MockAutomationRule>) {
      const rule = automationState.rules.find(
        (entry) => entry.id === ruleId && entry.userId === userId,
      );
      if (!rule) return null;
      Object.assign(rule, patch);
      if (patch.enabled === false && patch.nextRunAt === undefined) {
        rule.nextRunAt = null;
      }
      return rule;
    },
    deleteRule(ruleId: string, userId: string) {
      const index = automationState.rules.findIndex(
        (entry) => entry.id === ruleId && entry.userId === userId,
      );
      if (index < 0) return false;
      automationState.rules.splice(index, 1);
      return true;
    },
    listRules(userId: string) {
      return automationState.rules.filter((entry) => entry.userId === userId);
    },
  }),
}));

describe('master reminders service', () => {
  const scope = { userId: 'u-reminders', workspaceId: 'w-reminders' };

  beforeEach(() => {
    automationState.rules = [];
  });

  it('creates reminders, projects cron rules, and records pause/cancel transitions', () => {
    const repo = new SqliteMasterRepository(':memory:');
    const bridge = new MasterCronBridge(repo);
    const service = new MasterRemindersService(repo, {
      scheduler: bridge,
      now: () => new Date('2026-03-06T10:00:00.000Z'),
    });

    const reminder = service.create(scope, {
      title: 'Renew certificate',
      message: 'Rotate before expiry',
      remindAt: '2026-03-07T03:00:00.000Z',
      cronExpression: '0 3 * * *',
    });

    expect(bridge.list(scope)).toMatchObject([
      {
        id: reminder.id,
        cronExpression: '0 3 * * *',
        enabled: true,
      },
    ]);

    const paused = service.pause(scope, reminder.id);
    expect(paused?.status).toBe('paused');
    expect(bridge.list(scope)[0]?.enabled).toBe(false);

    const cancelled = service.cancel(scope, reminder.id);
    expect(cancelled?.status).toBe('cancelled');
    expect(bridge.list(scope)[0]?.enabled).toBe(false);

    const auditActions = repo.listAuditEvents(scope).map((entry) => entry.action);
    expect(auditActions).toEqual(expect.arrayContaining(['created', 'paused', 'cancelled']));
    repo.close();
  });

  it('marks one-shot reminders as fired once and ignores duplicate fire requests', () => {
    const repo = new SqliteMasterRepository(':memory:');
    const service = new MasterRemindersService(repo, {
      now: () => new Date('2026-03-06T12:00:00.000Z'),
    });

    const reminder = service.create(scope, {
      title: 'Send follow-up',
      message: 'Email procurement',
      remindAt: '2026-03-06T12:30:00.000Z',
    });

    const firstFire = service.fire(scope, reminder.id, {
      firedAt: '2026-03-06T12:30:00.000Z',
      source: 'manual',
    });
    expect(firstFire?.duplicate).toBe(false);
    expect(firstFire?.reminder.status).toBe('fired');

    const duplicateFire = service.fire(scope, reminder.id, {
      firedAt: '2026-03-06T12:31:00.000Z',
      source: 'manual',
    });
    expect(duplicateFire?.duplicate).toBe(true);
    expect(repo.listAuditEvents(scope).filter((entry) => entry.action === 'fired')).toHaveLength(1);
    repo.close();
  });

  it('records cron-triggered fires through the cron bridge and suppresses duplicate callbacks', () => {
    const repo = new SqliteMasterRepository(':memory:');
    const bridge = new MasterCronBridge(repo);
    const service = new MasterRemindersService(repo, {
      scheduler: bridge,
      now: () => new Date('2026-03-06T13:00:00.000Z'),
    });

    const reminder = service.create(scope, {
      title: 'Daily backup check',
      message: 'Verify last backup result',
      remindAt: '2026-03-07T01:00:00.000Z',
      cronExpression: '0 1 * * *',
    });
    const automationRuleId = bridge.list(scope)[0]?.automationRuleId;
    expect(automationRuleId).toBeTruthy();

    const firstFire = bridge.completeReminderRun(scope, {
      automationRuleId: automationRuleId as string,
      firedAt: '2026-03-07T01:00:00.000Z',
      summary: 'Backup rule executed',
    });
    expect(firstFire?.duplicate).toBe(false);
    expect(firstFire?.reminder.id).toBe(reminder.id);
    expect(firstFire?.reminder.status).toBe('fired');

    const duplicateFire = bridge.completeReminderRun(scope, {
      automationRuleId: automationRuleId as string,
      firedAt: '2026-03-07T01:00:00.000Z',
      summary: 'Backup rule executed again',
    });
    expect(duplicateFire?.duplicate).toBe(true);
    expect(repo.listAuditEvents(scope).filter((entry) => entry.action === 'fired')).toHaveLength(1);
    repo.close();
  });
});
