import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('wave2 dispatch route modularization contracts', () => {
  it('keeps the api route as a thin adapter to server dispatch service', () => {
    const routeSource = read('app/api/tasks/[id]/dispatch/route.ts');

    expect(routeSource).toContain("from '@/server/tasks/dispatch'");
    expect(routeSource).toContain('dispatchTask(');
    expect(routeSource).not.toContain('function classifyDispatchFailure(');
    expect(routeSource).not.toContain('TASK_COMPLETE:');
    expect(routeSource).not.toContain('openclaw_sessions');
  });

  it('splits dispatch flow into prepare, execute and finalize use-cases', () => {
    const serviceEntry = read('src/server/tasks/dispatch/index.ts');

    expect(serviceEntry).toContain("from './prepareDispatch'");
    expect(serviceEntry).toContain("from './executeDispatch'");
    expect(serviceEntry).toContain("from './finalizeDispatch'");
  });
});
