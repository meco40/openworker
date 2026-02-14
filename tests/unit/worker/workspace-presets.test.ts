import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_PRESET_OPTIONS,
  resolveWorkspaceTypeForTask,
} from '../../../src/modules/worker/services/workspacePresets';

describe('workspace presets', () => {
  it('includes auto plus exactly four presets', () => {
    const values = WORKSPACE_PRESET_OPTIONS.map((o) => o.value);
    expect(values).toEqual(['auto', 'research', 'webapp', 'data', 'general']);
    expect(values).not.toContain('creative');
  });

  it('maps auto mode to undefined workspaceType', () => {
    expect(resolveWorkspaceTypeForTask('auto')).toBeUndefined();
  });

  it('passes preset workspace types through unchanged', () => {
    expect(resolveWorkspaceTypeForTask('research')).toBe('research');
    expect(resolveWorkspaceTypeForTask('webapp')).toBe('webapp');
    expect(resolveWorkspaceTypeForTask('data')).toBe('data');
    expect(resolveWorkspaceTypeForTask('general')).toBe('general');
  });
});
