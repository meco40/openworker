import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('master view utility flow', () => {
  it('contains task input and run control actions for practical usage', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/modules/master/components/MasterView.tsx'),
      'utf8',
    );
    expect(source).toContain('Create Master Run');
    expect(source).toContain('/api/master/runs');
    expect(source).toContain('run.start');
    expect(source).toContain('run.export');
    expect(source).toContain('approve_once');
    expect(source).toContain('approve_always');
    expect(source).toContain('deny');
  });
});
