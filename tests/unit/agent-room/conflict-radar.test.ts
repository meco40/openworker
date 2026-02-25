import { describe, expect, it } from 'vitest';
import { deriveConflictRadar } from '@/modules/agent-room/conflictRadar';

describe('conflict radar projection', () => {
  it('returns low friction for neutral artifact', () => {
    const friction = deriveConflictRadar('Stable and clear solution');
    expect(friction.level).toBe('low');
    expect(friction.hold).toBe(false);
  });

  it('escalates to hold on severe conflict signals', () => {
    const friction = deriveConflictRadar('Critical blocker, fatal conflict, stop deployment');
    expect(friction.level).toBe('high');
    expect(friction.hold).toBe(true);
    expect(friction.confidence).toBeGreaterThanOrEqual(65);
  });
});

