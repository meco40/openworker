import type { MasterRepository } from '@/server/master/repository';
import type { WorkspaceScope } from '@/server/master/types';

export interface CronJobDefinition {
  id: string;
  cronExpression: string;
  title: string;
  message: string;
}

export class MasterCronBridge {
  constructor(private readonly repo: MasterRepository) {}

  list(scope: WorkspaceScope): CronJobDefinition[] {
    return this.repo
      .listReminders(scope)
      .filter((entry) => Boolean(entry.cronExpression))
      .map((entry) => ({
        id: entry.id,
        cronExpression: entry.cronExpression || '',
        title: entry.title,
        message: entry.message,
      }));
  }
}
