import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('planning view fallback refresh contract', () => {
  it('renders Neu laden fallback UI and wires callback/error states', () => {
    const source = read('src/components/planning/PlanningTabView.tsx');

    expect(source).toContain('onClick={onFallbackRefresh}');
    expect(source).toContain("'Neu laden'");
    expect(source).toContain('isRefreshingFallback');
    expect(source).toContain('fallbackRefreshError');
    expect(source).toContain('Neu laden...');
  });
});
