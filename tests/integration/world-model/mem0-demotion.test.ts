import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { isMem0FactualWriteBlocked, allowedMem0Types } from '@/server/world-model/mem0Policy';
import { getWorldModelConfig } from '@/server/world-model/config';

const enabled = process.env.WORLD_MODEL_E2E === 'true';

describe.skipIf(!enabled)('world-model mem0 demotion behavior', () => {
  beforeAll(() => {
    vi.stubEnv('WORLD_MODEL_MODE', 'canonical');
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it('blocks factual writes in canonical mode', () => {
    const config = getWorldModelConfig();
    expect(config.mode).toBe('canonical');
    expect(isMem0FactualWriteBlocked()).toBe(true);
  });

  it('allows only preference types when factual writes are blocked', () => {
    const allowed = allowedMem0Types();
    expect(allowed).not.toContain('fact');
    expect(allowed).not.toContain('lesson');
  });

  it('correctly enumerates preference types', () => {
    const allowed = allowedMem0Types();
    expect(allowed).toEqual(['preference', 'avoidance', 'personality_trait', 'workflow_pattern']);
  });
});
