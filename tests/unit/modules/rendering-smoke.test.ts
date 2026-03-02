import { describe, expect, it } from 'vitest';
import TelemetryLogsView from '@/components/LogsView';
import TasksManagerView from '@/modules/tasks/task-manager/TaskManagerView';
import ConfigEditor from '@/components/ConfigEditor';
import ExposureManager from '@/components/ExposureManager';

describe('module rendering smoke', () => {
  it('resolves feature modules', () => {
    expect(TelemetryLogsView).toBeDefined();
    expect(TasksManagerView).toBeDefined();
    expect(ConfigEditor).toBeDefined();
    expect(ExposureManager).toBeDefined();
  });
});
