import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('master view utility flow', () => {
  it('contains task input and run control contracts across modularized master view files', () => {
    const createRunFormSource = fs.readFileSync(
      path.join(process.cwd(), 'src/modules/master/components/CreateRunForm.tsx'),
      'utf8',
    );
    const apiSource = fs.readFileSync(
      path.join(process.cwd(), 'src/modules/master/api.ts'),
      'utf8',
    );
    const masterViewHookSource = fs.readFileSync(
      path.join(process.cwd(), 'src/modules/master/hooks/useMasterView.ts'),
      'utf8',
    );
    const approvalDecisionFormSource = fs.readFileSync(
      path.join(process.cwd(), 'src/modules/master/components/ApprovalDecisionForm.tsx'),
      'utf8',
    );

    expect(createRunFormSource).toContain('Create Master Run');
    expect(apiSource).toContain('/api/master/runs');
    expect(masterViewHookSource).toContain('run.start');
    expect(masterViewHookSource).toContain('run.export');
    expect(approvalDecisionFormSource).toContain('approve_once');
    expect(approvalDecisionFormSource).toContain('approve_always');
    expect(approvalDecisionFormSource).toContain('deny');
  });
});
