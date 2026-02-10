import { describe, expect, it } from 'vitest';
import TelemetryLogsView from '../../../src/modules/telemetry/components/LogsView';
import TasksManagerView from '../../../src/modules/tasks/components/TaskManagerView';
import ConfigEditor from '../../../src/modules/config/components/ConfigEditor';
import ExposureManager from '../../../src/modules/exposure/components/ExposureManager';

describe('module rendering smoke', () => {
  it('resolves feature modules', () => {
    expect(TelemetryLogsView).toBeDefined();
    expect(TasksManagerView).toBeDefined();
    expect(ConfigEditor).toBeDefined();
    expect(ExposureManager).toBeDefined();
  });
});
