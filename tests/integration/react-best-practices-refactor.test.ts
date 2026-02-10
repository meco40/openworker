import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  const absolutePath = path.join(process.cwd(), relativePath);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- controlled test fixture paths
  return fs.readFileSync(absolutePath, 'utf-8');
}

describe('react/next best-practices refactor', () => {
  it('uses local tailwind setup instead of CDN runtime script', () => {
    const layout = read('app/layout.tsx');
    const globalsCss = read('app/globals.css');
    const pkg = JSON.parse(read('package.json')) as {
      devDependencies?: Record<string, string>;
      dependencies?: Record<string, string>;
    };

    expect(layout).not.toContain('cdn.tailwindcss.com');
    expect(globalsCss).toContain('@import "tailwindcss";');
    expect(fs.existsSync(path.join(process.cwd(), 'postcss.config.mjs'))).toBe(true);
    expect(pkg.devDependencies?.tailwindcss || pkg.dependencies?.tailwindcss).toBeDefined();
    expect(pkg.devDependencies?.['@tailwindcss/postcss']).toBeDefined();
  });

  it('uses dynamic imports for heavy optional views', () => {
    const viewContent = read('src/modules/app-shell/components/AppShellViewContent.tsx');
    expect(viewContent).toContain("import dynamic from 'next/dynamic';");
    expect(viewContent).toContain("dynamic(() => import('../../../../WorkerView'))");
    expect(viewContent).toContain("dynamic(() => import('../../../../components/ModelHub'))");
  });

  it('parallelizes independent skill function calls', () => {
    const runtime = read('src/modules/app-shell/useAgentRuntime.ts');
    expect(runtime).toContain('Promise.all(');
  });

  it('avoids mutating sort in Dashboard render path', () => {
    const dashboard = read('components/Dashboard.tsx');
    expect(dashboard).not.toContain('scheduled.sort(');
    expect(dashboard).toContain('[...scheduled].sort(');
  });

  it('uses functional setState update for new worker task creation', () => {
    const workerView = read('WorkerView.tsx');
    expect(workerView).toContain('setTasks(prev => [newTask, ...prev]);');
  });

  it('uses lazy state initialization for expensive initial values', () => {
    const app = read('App.tsx');
    const conversationSync = read('src/modules/app-shell/useConversationSync.ts');
    const gatewayState = read('src/modules/app-shell/useGatewayState.ts');

    expect(app).toContain('useState<View>(() => buildInitialShellState().currentView)');
    expect(app).toContain('useState<Record<string, CoupledChannel>>(() => {');
    expect(conversationSync).toContain('useState<Message[]>(() => [])');
    expect(gatewayState).toContain('useState<GatewayState>(() => createInitialGatewayState())');
  });
});
