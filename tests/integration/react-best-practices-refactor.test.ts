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
    expect(viewContent).not.toContain("dynamic(() => import('../../../../WorkerView'))");
    expect(viewContent).toContain("dynamic(() => import('@/components/model-hub/ModelHub')");
    expect(viewContent).toContain("dynamic(() => import('@/components/Dashboard')");
    expect(viewContent).toContain("dynamic(() => import('@/components/ChatInterface')");
    expect(viewContent).toContain(
      "dynamic(() => import('@/messenger/channel-pairing/ChannelPairing')",
    );
    expect(viewContent).not.toContain("import Dashboard from '@/components/Dashboard';");
    expect(viewContent).not.toContain("import ChatInterface from '@/components/ChatInterface';");
    expect(viewContent).not.toContain(
      "import ChannelPairing from '@/messenger/channel-pairing/ChannelPairing';",
    );
  });

  it('does not load chart and graph libraries in the initial global bundle', () => {
    const dashboard = read('src/components/Dashboard.tsx');
    const globalsCss = read('app/globals.css');
    const knowledgeGraph = read('src/components/knowledge/graph/KnowledgeGraphPanel.tsx');

    expect(dashboard).not.toContain("from 'recharts'");
    expect(dashboard).toContain("dynamic(() => import('@/components/dashboard/PersonalityRadar')");
    expect(globalsCss).not.toContain('@xyflow/react/dist/style.css');
    expect(knowledgeGraph).toContain("import '@xyflow/react/dist/style.css';");
  });

  it('uses local system font stacks and avoids Google font runtime dependencies', () => {
    const layout = read('app/layout.tsx');
    const globalsCss = read('app/globals.css');

    expect(layout).not.toContain("from 'next/font/google'");
    expect(layout).not.toContain('fonts.googleapis.com');
    expect(layout).not.toContain('fonts.gstatic.com');
    expect(globalsCss).toContain('--font-sans:');
    expect(globalsCss).toContain('--font-mono:');
    expect(globalsCss).toContain('var(--font-sans)');
    expect(globalsCss).toContain('var(--font-mono)');
  });

  it('parallelizes independent skill function calls', () => {
    const runtime = read('src/modules/app-shell/useAgentRuntime.ts');
    expect(runtime).toContain('Promise.all(');
  });

  it('keeps PersonasView decoupled from deprecated rooms runtime', () => {
    const personasView = read('src/components/PersonasView.tsx');
    expect(personasView).not.toContain('useRoomManagement');
    expect(personasView).not.toContain('useRoomSync');
    expect(personasView).not.toContain('RoomDetailPanel');
    expect(personasView).not.toContain('CreateRoomModal');
  });

  it('parallelizes independent async work in skill and metrics routes', () => {
    const skillRoute = read('app/api/skills/[id]/route.ts');
    const metricsRoute = read('app/api/control-plane/metrics/route.ts');

    expect(skillRoute).toContain('const [body, repo] = await Promise.all([');
    expect(metricsRoute).toContain('const optionalImportsPromise = Promise.allSettled([');
    expect(metricsRoute).toMatch(
      /await Promise\.all\(\[\s*vectorNodeCountPromise,\s*optionalImportsPromise,\s*worldModelMetricsPromise,?\s*\]\)/,
    );
  });

  it('memoizes PersonaContext value to avoid unnecessary consumer rerenders', () => {
    const personaContext = read('src/modules/personas/PersonaContext.tsx');
    expect(personaContext).toContain('const value = React.useMemo<PersonaContextValue>(');
  });

  it('avoids mutating sort in Dashboard render path', () => {
    const dashboard = read('src/components/Dashboard.tsx');
    expect(dashboard).not.toContain('scheduled.sort(');
    expect(dashboard).toContain('[...scheduledTasks].sort(');
  });

  it('keeps worker view detached from the main app shell', () => {
    const appShellViewContent = read('src/modules/app-shell/components/AppShellViewContent.tsx');
    expect(appShellViewContent).not.toContain('View.WORKER');
    expect(appShellViewContent).not.toContain('Autonomous Worker');
  });

  it('uses lazy state initialization for expensive initial values', () => {
    const app = read('src/modules/app-shell/App.tsx');
    const conversationSync = read('src/modules/app-shell/useConversationSync.ts');
    const gatewayState = read('src/modules/app-shell/useGatewayState.ts');

    expect(app).toMatch(
      /useState<View>\(\s*\(\)\s*=>\s*buildInitialShellState\(initialView\)\.currentView,?\s*\)/,
    );
    expect(app).toContain('useState<Record<string, CoupledChannel>>(() => {');
    expect(conversationSync).toContain('useState<Message[]>(() => [])');
    expect(gatewayState).toContain('useState<GatewayState>(() => createInitialGatewayState())');
    expect(gatewayState).not.toContain('cpuUsage:');
    expect(gatewayState).not.toContain('trafficData:');
  });

  it('uses static-export client view and avoids startup config fetch in client app shell', () => {
    const app = read('src/modules/app-shell/App.tsx');
    const page = read('app/page.tsx');
    const appShell = read('src/modules/app-shell/AppShell.tsx');

    expect(app).not.toContain("fetch('/api/config'");
    expect(page).toContain("'use client'");
    expect(page).toContain("fetch('/api/config')");
    expect(page).toContain(
      "import { resolveDefaultViewFromConfig } from '@/shared/config/uiRuntimeConfig';",
    );
    expect(appShell).toContain('initialView');
    expect(app).toContain('initialView: View');
  });

  it('refreshes shell metrics only while the document is visible', () => {
    const metricsHook = read('src/modules/app-shell/useControlPlaneMetrics.ts');

    expect(metricsHook).toContain('METRICS_REFRESH_INTERVAL_MS = 30_000');
    expect(metricsHook).toContain("document.visibilityState === 'visible'");
    expect(metricsHook).toContain("document.addEventListener('visibilitychange'");
    expect(metricsHook).toContain("window.addEventListener('focus'");
    expect(metricsHook).toContain('window.clearInterval(intervalId)');
  });

  it('loads chat/persona/skills data only when required by active view', () => {
    const app = read('src/modules/app-shell/App.tsx');
    const conversationSync = read('src/modules/app-shell/useConversationSync.ts');
    const agentRuntime = read('src/modules/app-shell/useAgentRuntime.ts');
    const personaContext = read('src/modules/personas/PersonaContext.tsx');

    expect(app).toContain('const shouldEnableChatData = currentView === View.CHAT;');
    expect(app).toContain('loadMemory: currentView === View.DASHBOARD,');
    expect(app).toContain('enabled: shouldEnableChatData');
    expect(conversationSync).toContain('enabled: boolean');
    expect(conversationSync).toContain('if (!enabled) {');
    expect(agentRuntime).toContain('enabled: boolean');
    expect(agentRuntime).toContain('if (!enabled) {');
    expect(personaContext).toContain('setDataEnabled: (enabled: boolean) => void;');
    expect(personaContext).toContain('const [dataEnabled, setDataEnabled] = useState(false);');
  });
});
