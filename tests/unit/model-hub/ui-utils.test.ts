import { describe, expect, it } from 'vitest';
import { filterLiveModels, getDefaultActiveModel } from '../../../components/model-hub/utils';

describe('model-hub ui utils', () => {
  it('returns active model with the lowest priority as default', () => {
    const pipeline = [
      { id: 'm1', modelName: 'alpha', status: 'offline', priority: 1 },
      { id: 'm2', modelName: 'beta', status: 'active', priority: 2 },
      { id: 'm3', modelName: 'gamma', status: 'active', priority: 1 },
    ];

    const result = getDefaultActiveModel(pipeline as never);
    expect(result?.id).toBe('m3');
  });

  it('returns null when no active model exists', () => {
    const pipeline = [{ id: 'm1', modelName: 'alpha', status: 'offline', priority: 1 }];
    const result = getDefaultActiveModel(pipeline as never);
    expect(result).toBeNull();
  });

  it('filters live models by id and name case-insensitively', () => {
    const models = [
      { id: 'gpt-4.1-mini', name: 'GPT Mini' },
      { id: 'claude-sonnet', name: 'Claude Sonnet' },
    ];

    expect(filterLiveModels(models as never, 'gPt')).toHaveLength(1);
    expect(filterLiveModels(models as never, 'sonnet')).toHaveLength(1);
    expect(filterLiveModels(models as never, '   ')).toHaveLength(2);
  });
});
