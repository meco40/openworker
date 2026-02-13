import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf-8');
}

describe('recharts animation guard', () => {
  it('disables Radar animation in Dashboard to avoid strict-mode update loops', () => {
    const dashboard = read('components/Dashboard.tsx');
    expect(dashboard).toContain('<Radar');
    expect(dashboard).toContain('isAnimationActive={false}');
  });

  it('disables Bar animation in StatsView to avoid strict-mode update loops', () => {
    const statsView = read('components/StatsView.tsx');
    expect(statsView).toContain('<Bar');
    expect(statsView).toContain('isAnimationActive={false}');
  });
});
