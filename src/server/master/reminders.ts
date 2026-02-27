import type { MasterRepository } from '@/server/master/repository';
import type { MasterReminder, WorkspaceScope } from '@/server/master/types';

export class MasterRemindersService {
  constructor(private readonly repo: MasterRepository) {}

  create(
    scope: WorkspaceScope,
    input: {
      title: string;
      message: string;
      remindAt: string;
      cronExpression?: string | null;
    },
  ): MasterReminder {
    return this.repo.createReminder(scope, {
      title: input.title,
      message: input.message,
      remindAt: input.remindAt,
      cronExpression: input.cronExpression ?? null,
      status: 'pending',
    });
  }

  list(scope: WorkspaceScope): MasterReminder[] {
    return this.repo.listReminders(scope);
  }
}
