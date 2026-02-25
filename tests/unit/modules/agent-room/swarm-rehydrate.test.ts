import { describe, expect, it } from 'vitest';
import { shouldFallbackToSessionSnapshot } from '@/modules/agent-room/hooks/useAgentRoomRuntime';

describe('swarm rehydrate fallback', () => {
  it('falls back to session.get when replay window expired errors occur', () => {
    expect(shouldFallbackToSessionSnapshot(new Error('REPLAY_WINDOW_EXPIRED'))).toBe(true);
    expect(shouldFallbackToSessionSnapshot(new Error('Replay window expired; use snapshot.'))).toBe(
      true,
    );
  });

  it('does not fallback for unrelated replay errors', () => {
    expect(shouldFallbackToSessionSnapshot(new Error('network timeout'))).toBe(false);
  });
});

