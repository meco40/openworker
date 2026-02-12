import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  const absolutePath = path.join(process.cwd(), relativePath);
   
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
    expect(globalsCss).toMatch(/@import\s+["']tailwindcss["'];/);
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

  it('loads fonts via next/font self-hosting instead of Google stylesheet links', () => {
    const layout = read('app/layout.tsx');
    const globalsCss = read('app/globals.css');

    expect(layout).toContain("from 'next/font/google'");
    expect(layout).toContain('Inter(');
    expect(layout).toContain('Fira_Code(');
    expect(layout).not.toContain('fonts.googleapis.com');
    expect(layout).not.toContain('fonts.gstatic.com');
    expect(globalsCss).toContain('var(--font-sans)');
    expect(globalsCss).toContain('var(--font-mono)');
  });

  it('parallelizes independent skill function calls', () => {
    const runtime = read('src/modules/app-shell/useAgentRuntime.ts');
    expect(runtime).toContain('Promise.all(');
  });

  it('parallelizes independent room refresh actions in PersonasView', () => {
    const personasView = read('components/PersonasView.tsx');
    expect(personasView).toContain('await Promise.all([loadRoomDetail(selectedRoomId), refreshRooms()]);');
  });

  it('parallelizes independent async work in skill and metrics routes', () => {
    const skillRoute = read('app/api/skills/[id]/route.ts');
    const metricsRoute = read('app/api/control-plane/metrics/route.ts');

    expect(skillRoute).toContain('const [resolvedParams, body, repo] = await Promise.all([');
    expect(metricsRoute).toContain('const [automationImport, roomImport] = await Promise.allSettled([');
  });

  it('avoids re-sorting the full room message list on every websocket event', () => {
    const roomSync = read('src/modules/rooms/useRoomSync.ts');
    expect(roomSync).not.toContain('.sort((a, b) => a.seq - b.seq)');
  });

  it('memoizes PersonaContext value to avoid unnecessary consumer rerenders', () => {
    const personaContext = read('src/modules/personas/PersonaContext.tsx');
    expect(personaContext).toContain('const value = React.useMemo<PersonaContextValue>(');
  });

  it('avoids mutating sort in Dashboard render path', () => {
    const dashboard = read('components/Dashboard.tsx');
    expect(dashboard).not.toContain('scheduled.sort(');
    expect(dashboard).toContain('[...scheduled].sort(');
  });

  it('uses API-based hook for worker task management', () => {
    const workerView = read('WorkerView.tsx');
    // WorkerView now delegates to useWorkerTasks hook via API instead of client-side setTasks
    expect(workerView).toContain('useWorkerTasks');
    expect(workerView).not.toContain('ai(');
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
