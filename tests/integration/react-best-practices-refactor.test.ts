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
    expect(viewContent).toContain("dynamic(() => import('@/components/ModelHub')");
    expect(viewContent).toContain("dynamic(() => import('@/components/Dashboard')");
    expect(viewContent).toContain("dynamic(() => import('@/components/ChatInterface')");
    expect(viewContent).toContain("dynamic(() => import('@/messenger/ChannelPairing')");
    expect(viewContent).not.toContain("import Dashboard from '@/components/Dashboard';");
    expect(viewContent).not.toContain("import ChatInterface from '@/components/ChatInterface';");
    expect(viewContent).not.toContain("import ChannelPairing from '@/messenger/ChannelPairing';");
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
    const personasView = read('src/components/PersonasView.tsx');
    expect(personasView).toContain(
      'await Promise.all([loadRoomDetail(selectedRoomId), refreshRooms()]);',
    );
  });

  it('parallelizes independent async work in skill and metrics routes', () => {
    const skillRoute = read('app/api/skills/[id]/route.ts');
    const metricsRoute = read('app/api/control-plane/metrics/route.ts');

    expect(skillRoute).toContain('const [resolvedParams, body, repo] = await Promise.all([');
    expect(metricsRoute).toContain(
      'const [automationImport, roomImport, knowledgeImport] = await Promise.allSettled([',
    );
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
    const dashboard = read('src/components/Dashboard.tsx');
    expect(dashboard).not.toContain('scheduled.sort(');
    expect(dashboard).toContain('[...scheduled].sort(');
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
      /useState<View>\(\(\) =>\s*buildInitialShellState\(initialView\)\.currentView,?\s*\)/,
    );
    expect(app).toContain('useState<Record<string, CoupledChannel>>(() => {');
    expect(conversationSync).toContain('useState<Message[]>(() => [])');
    expect(gatewayState).toContain('useState<GatewayState>(() => createInitialGatewayState())');
  });

  it('uses server-derived initial view and avoids startup config fetch in client app shell', () => {
    const app = read('src/modules/app-shell/App.tsx');
    const page = read('app/page.tsx');
    const appShell = read('src/modules/app-shell/AppShell.tsx');

    expect(app).not.toContain("fetch('/api/config'");
    expect(page).toContain("import { loadGatewayConfig } from '@/server/config/gatewayConfig';");
    expect(page).toContain(
      "import { resolveDefaultViewFromConfig } from '@/server/config/uiRuntimeConfig';",
    );
    expect(appShell).toContain('initialView');
    expect(app).toContain('initialView: View');
  });

  it('loads chat/persona/skills data only when required by active view', () => {
    const app = read('src/modules/app-shell/App.tsx');
    const conversationSync = read('src/modules/app-shell/useConversationSync.ts');
    const agentRuntime = read('src/modules/app-shell/useAgentRuntime.ts');
    const personaContext = read('src/modules/personas/PersonaContext.tsx');

    expect(app).toContain('const shouldEnableChatData = currentView === View.CHAT;');
    expect(app).toContain('enabled: shouldEnableChatData');
    expect(conversationSync).toContain('enabled: boolean');
    expect(conversationSync).toContain('if (!enabled) {');
    expect(agentRuntime).toContain('enabled: boolean');
    expect(agentRuntime).toContain('if (!enabled) {');
    expect(personaContext).toContain('setDataEnabled: (enabled: boolean) => void;');
    expect(personaContext).toContain('const [dataEnabled, setDataEnabled] = useState(false);');
  });
});
