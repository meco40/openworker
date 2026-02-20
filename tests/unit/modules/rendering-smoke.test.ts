import { describe, expect, it } from 'vitest';
import TelemetryLogsView from '@/modules/telemetry/components/LogsView';
import TasksManagerView from '@/modules/tasks/components/TaskManagerView';
import ConfigEditor from '@/modules/config/components/ConfigEditor';
import ExposureManager from '@/modules/exposure/components/ExposureManager';

describe('module rendering smoke', () => {
  it('resolves feature modules', () => {
    expect(TelemetryLogsView).toBeDefined();
    expect(TasksManagerView).toBeDefined();
    expect(ConfigEditor).toBeDefined();
    expect(ExposureManager).toBeDefined();
  });
});
