import { describe, expect, it } from 'vitest';
import { pushArtifactSnapshot, restoreArtifactSnapshot } from '@/modules/agent-room/artifactHistory';

describe('artifact history projection', () => {
  it('keeps bounded history and avoids duplicate snapshots', () => {
    let history: string[] = [];
    history = pushArtifactSnapshot(history, 'A');
    history = pushArtifactSnapshot(history, 'A');
    history = pushArtifactSnapshot(history, 'B');
    history = pushArtifactSnapshot(history, 'C', 2);

    expect(history).toEqual(['B', 'C']);
  });

  it('restores snapshot by index', () => {
    const restored = restoreArtifactSnapshot(['v1', 'v2', 'v3'], 1);
    expect(restored.artifact).toBe('v2');
    expect(restored.history).toEqual(['v1', 'v2', 'v3']);
  });
});

