import { describe, expect, it } from 'vitest';
import TelemetryLogsView from '@/components/LogsView';
import TasksManagerView from '@/modules/tasks/task-manager/TaskManagerView';
import ConfigEditor from '@/components/ConfigEditor';

describe('module rendering smoke', () => {
  it('resolves feature modules', () => {
    expect(TelemetryLogsView).toBeDefined();
    expect(TasksManagerView).toBeDefined();
    expect(ConfigEditor).toBeDefined();
  });
});
