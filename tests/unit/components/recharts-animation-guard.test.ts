import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf-8');
}

describe('recharts animation guard', () => {
  it('disables Radar animation in its lazy dashboard chunk to avoid strict-mode update loops', () => {
    const personalityRadar = read('src/components/dashboard/PersonalityRadar.tsx');
    expect(personalityRadar).toContain('<Radar');
    expect(personalityRadar).toContain('isAnimationActive={false}');
  });

  it('disables Bar animation in StatsView to avoid strict-mode update loops', () => {
    const overviewTab = read('src/components/stats/OverviewTabContent.tsx');
    expect(overviewTab).toContain('<Bar');
    expect(overviewTab).toContain('isAnimationActive={false}');
  });
});
