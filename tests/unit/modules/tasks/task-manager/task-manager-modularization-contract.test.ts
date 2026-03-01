import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('task manager modularization contract', () => {
  it('keeps API mutations in useTaskCatalog and not in view container', () => {
    const viewSource = fs.readFileSync(
      path.join(process.cwd(), 'src/modules/tasks/task-manager/TaskManagerView.tsx'),
      'utf8',
    );
    const hookSource = fs.readFileSync(
      path.join(process.cwd(), 'src/modules/tasks/task-manager/useTaskCatalog.ts'),
      'utf8',
    );

    expect(viewSource).toContain('useTaskCatalog');
    expect(viewSource).not.toContain('fetch(');
    expect(hookSource).toMatch(/const\s+url\s*=\s*`\/api\/tasks/);
    expect(hookSource).toMatch(/fetch\(url\)/);
    expect(hookSource).toMatch(/fetch\(`\/api\/tasks\/\$\{encodeURIComponent\(id\)\}`/);
  });

  it('keeps row/detail/modal as separate components', () => {
    const viewSource = fs.readFileSync(
      path.join(process.cwd(), 'src/modules/tasks/task-manager/TaskManagerView.tsx'),
      'utf8',
    );

    expect(viewSource).toContain('CreateTaskModal');
    expect(viewSource).toContain('TaskRow');
    expect(viewSource).toContain('TaskDetailPanel');
  });
});
