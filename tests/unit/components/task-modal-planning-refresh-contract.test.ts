import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('task modal planning refresh contract', () => {
  it('removes hard page reload and uses planning refresh callbacks', () => {
    const source = read('src/components/TaskModal.tsx');

    expect(source).not.toContain('window.location.reload()');
    expect(source).toContain('onPlanningComplete={handlePlanningComplete}');
    expect(source).toContain('onFallbackRefresh={handleFallbackRefresh}');
    expect(source).toContain('const refreshMissionControlData = useCallback(');
    expect(source).toContain("await refreshMissionControlData('planning-complete');");
  });
});
