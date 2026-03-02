import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('wave3 task test route modularization contracts', () => {
  it('keeps task test route as adapter to server testing service', () => {
    const routeSource = read('app/api/tasks/[id]/test/route.ts');

    expect(routeSource).toContain("from '@/server/tasks/testing'");
    expect(routeSource).toContain('runTaskTests(');
    expect(routeSource).toContain('getTaskTestInfo(');
    expect(routeSource).not.toContain('chromium.launch');
    expect(routeSource).not.toContain('function validateCss(');
    expect(routeSource).not.toContain('async function testDeliverable(');
  });

  it('splits testing concerns into service and helper modules', () => {
    const serviceSource = read('src/server/tasks/testing/service.ts');
    const testerSource = read('src/server/tasks/testing/deliverableTester.ts');
    const cssSource = read('src/server/tasks/testing/cssValidation.ts');

    expect(serviceSource).toContain("from './deliverableTester'");
    expect(serviceSource).toContain('runTaskTests');
    expect(testerSource).toContain('testDeliverable');
    expect(cssSource).toContain('validateCss');
  });
});
