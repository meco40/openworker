import type { MasterRepository } from '@/server/master/repository';
import type { MasterReminder, WorkspaceScope } from '@/server/master/types';

export interface ReminderSchedulerBridge {
  syncReminder(scope: WorkspaceScope, reminder: MasterReminder): void;
  pauseReminder(scope: WorkspaceScope, reminderId: string): void;
  resumeReminder(scope: WorkspaceScope, reminderId: string): void;
  removeReminder(scope: WorkspaceScope, reminderId: string): void;
}

export interface FireReminderInput {
  firedAt?: string;
  source?: 'manual' | 'cron' | 'api';
  summary?: string | null;
  automationRuleId?: string | null;
}

export interface FireReminderResult {
  reminder: MasterReminder;
  firedAt: string;
  duplicate: boolean;
}

interface MasterRemindersServiceOptions {
  scheduler?: ReminderSchedulerBridge;
  now?: () => Date;
}

interface ReminderAuditMetadata {
  reminderId: string;
  firedAt?: string;
  source?: string;
  summary?: string | null;
  automationRuleId?: string | null;
  patch?: Partial<MasterReminder>;
}

type ReminderPatch = Partial<
  Pick<MasterReminder, 'title' | 'message' | 'remindAt' | 'cronExpression' | 'status'>
>;

function toMetadata(payload: ReminderAuditMetadata): string {
  return JSON.stringify(payload);
}

function fromMetadata(value: string): ReminderAuditMetadata | null {
  try {
    return JSON.parse(value) as ReminderAuditMetadata;
  } catch {
    return null;
  }
}

export class MasterRemindersService {
  private readonly scheduler?: ReminderSchedulerBridge;
  private readonly now: () => Date;

  constructor(
    private readonly repo: MasterRepository,
    options: MasterRemindersServiceOptions = {},
  ) {
    this.scheduler = options.scheduler;
    this.now = options.now ?? (() => new Date());
  }

  create(
    scope: WorkspaceScope,
    input: {
      title: string;
      message: string;
      remindAt: string;
      cronExpression?: string | null;
    },
  ): MasterReminder {
    const reminder = this.repo.createReminder(scope, {
      title: input.title,
      message: input.message,
      remindAt: input.remindAt,
      cronExpression: input.cronExpression ?? null,
      status: 'pending',
    });
    this.scheduler?.syncReminder(scope, reminder);
    this.repo.appendAuditEvent(scope, {
      category: 'reminder',
      action: 'created',
      metadata: toMetadata({ reminderId: reminder.id }),
    });
    return reminder;
  }

  list(scope: WorkspaceScope): MasterReminder[] {
    return this.repo.listReminders(scope);
  }

  get(scope: WorkspaceScope, reminderId: string): MasterReminder | null {
    return this.repo.listReminders(scope, 500).find((entry) => entry.id === reminderId) ?? null;
  }

  update(scope: WorkspaceScope, reminderId: string, patch: ReminderPatch): MasterReminder | null {
    const normalizedPatch = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ) as ReminderPatch;
    if (Object.keys(normalizedPatch).length === 0) {
      return this.get(scope, reminderId);
    }

    const reminder = this.repo.updateReminder(scope, reminderId, normalizedPatch);
    if (!reminder) {
      return null;
    }

    this.scheduler?.syncReminder(scope, reminder);
    if (reminder.status === 'paused' || reminder.status === 'cancelled') {
      this.scheduler?.pauseReminder(scope, reminder.id);
    } else if (reminder.status === 'pending') {
      this.scheduler?.resumeReminder(scope, reminder.id);
    }

    this.repo.appendAuditEvent(scope, {
      category: 'reminder',
      action: this.resolveUpdateAction(normalizedPatch.status),
      metadata: toMetadata({ reminderId: reminder.id, patch: normalizedPatch }),
    });

    return reminder;
  }

  pause(scope: WorkspaceScope, reminderId: string): MasterReminder | null {
    return this.update(scope, reminderId, { status: 'paused' });
  }

  cancel(scope: WorkspaceScope, reminderId: string): MasterReminder | null {
    return this.update(scope, reminderId, { status: 'cancelled' });
  }

  delete(scope: WorkspaceScope, reminderId: string): boolean {
    this.scheduler?.removeReminder(scope, reminderId);
    const deleted = this.repo.deleteReminder(scope, reminderId);
    if (deleted) {
      this.repo.appendAuditEvent(scope, {
        category: 'reminder',
        action: 'deleted',
        metadata: toMetadata({ reminderId }),
      });
    }
    return deleted;
  }

  fire(
    scope: WorkspaceScope,
    reminderId: string,
    input: FireReminderInput = {},
  ): FireReminderResult | null {
    const reminder = this.get(scope, reminderId);
    if (!reminder) {
      return null;
    }

    const firedAt = input.firedAt ?? this.now().toISOString();
    if (this.isDuplicateFire(scope, reminder, firedAt)) {
      return {
        reminder,
        firedAt,
        duplicate: true,
      };
    }

    const updated = this.repo.updateReminder(scope, reminder.id, { status: 'fired' }) ?? reminder;
    this.scheduler?.syncReminder(scope, updated);
    this.repo.appendAuditEvent(scope, {
      category: 'reminder',
      action: 'fired',
      metadata: toMetadata({
        reminderId: updated.id,
        firedAt,
        source: input.source ?? 'manual',
        summary: input.summary ?? null,
        automationRuleId: input.automationRuleId ?? null,
      }),
    });

    return {
      reminder: updated,
      firedAt,
      duplicate: false,
    };
  }

  private resolveUpdateAction(status?: MasterReminder['status']): string {
    if (status === 'paused') return 'paused';
    if (status === 'cancelled') return 'cancelled';
    if (status === 'pending') return 'resumed';
    return 'updated';
  }

  private isDuplicateFire(
    scope: WorkspaceScope,
    reminder: MasterReminder,
    firedAt: string,
  ): boolean {
    if (!reminder.cronExpression && reminder.status === 'fired') {
      return true;
    }

    return this.repo.listAuditEvents(scope, 500).some((entry) => {
      if (entry.category !== 'reminder' || entry.action !== 'fired') {
        return false;
      }
      const metadata = fromMetadata(entry.metadata);
      return metadata?.reminderId === reminder.id && metadata.firedAt === firedAt;
    });
  }
}
