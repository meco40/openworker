import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('useGrokVoiceAgent lazy connect contract', () => {
  it('does not auto-connect on mount and connects on user actions', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/modules/master/hooks/useGrokVoiceAgent.ts'),
      'utf8',
    );

    // No eager connect in lifecycle mount effect.
    expect(source).not.toMatch(/unmountedRef\.current = false;\r?\n\s*connect\(\);/);

    // Connection is established on demand for mic and text submit.
    const connectCalls = source.match(/await connect\(\);/g) ?? [];
    expect(connectCalls.length).toBeGreaterThanOrEqual(2);
  });
});
