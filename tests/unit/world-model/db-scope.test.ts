import { describe, expect, it } from 'vitest';
import { getWorldModelScope, runWithWorldModelScope } from '@/server/world-model/db';

describe('world-model database scope context', () => {
  it('keeps the RLS scope isolated to the async operation', async () => {
    expect(getWorldModelScope()).toBeUndefined();

    await runWithWorldModelScope(
      { userId: 'user-1', personaId: 'persona-1', workspaceId: 'workspace-1' },
      async () => {
        expect(getWorldModelScope()).toEqual({
          userId: 'user-1',
          personaId: 'persona-1',
          workspaceId: 'workspace-1',
        });
        await Promise.resolve();
        expect(getWorldModelScope()?.workspaceId).toBe('workspace-1');
      },
    );

    expect(getWorldModelScope()).toBeUndefined();
  });
});
