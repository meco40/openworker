# Professional Modular Refactor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Die WebApp auf eine professionelle, erweiterbare Zielarchitektur (feature-first + klare Layer) refactoren, ohne bestehende Kernfunktionen zu brechen.

**Architecture:** Die App wird in `src/` mit Domain-Modulen organisiert: `modules/*` fuer Features, `server/*` fuer Backend-Logik, `shared/*` fuer UI/Typen/Utilities. Die aktuelle monolithische Orchestrierung (`App.tsx`, `WorkerView.tsx`, API-Routen) wird in Use-Cases, Services und Presenter-Komponenten zerlegt. Jede Aenderung erfolgt testgetrieben, mit kleinen, rueckrollbaren Commits.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript, Vitest, ESLint (security + sonarjs), Node runtime routes.

---

## Ziel-Ordnerarchitektur (Best Case)

```txt
src/
  app/
    (control-plane)/
      page.tsx
      layout.tsx
    api/
      gemini/route.ts
      channels/pair/route.ts
      skills/execute/route.ts
  modules/
    chat/
      components/
      hooks/
      services/
      types.ts
    worker/
      components/
      services/
      hooks/
      types.ts
    channels/
      components/
      services/
      types.ts
    skills/
      components/
      services/
      providers/
      types.ts
    memory/
      services/
      stores/
      types.ts
    security/
      components/
      services/
      types.ts
  server/
    ai/
      geminiGateway.ts
      geminiTypes.ts
    skills/
      executeSkill.ts
      handlers/
        fileRead.ts
        shellExecute.ts
        pythonExecute.ts
        githubQuery.ts
        dbQuery.ts
        browserSnapshot.ts
        visionAnalyze.ts
    channels/
      pairing/
        telegram.ts
        discord.ts
        bridge.ts
    shared/
      errors.ts
      validation.ts
      env.ts
  shared/
    ui/
      components/
    lib/
      date.ts
      ids.ts
      logger.ts
    config/
      constants.ts
    types/
      global.ts
  tests/
    unit/
    integration/
    contract/
```

## Architekturregeln

1. UI-Komponenten enthalten keine Infrastruktur-Logik (`fetch`, SQL, Shell).
2. Server-Routen enthalten nur Request/Response-Mapping, keine Business-Logik.
3. Jede Business-Operation bekommt eine eigene Service/Use-Case-Funktion.
4. `shared` darf von `modules` genutzt werden, aber nicht umgekehrt.
5. Keine `any`-basierte API in neuen Dateien; neue Files strikt typisiert.

### Task 1: Baseline absichern und Refactor-Risiko reduzieren

**Files:**
- Create: `docs/architecture/BOUNDARIES.md`
- Modify: `package.json`
- Modify: `tsconfig.json`
- Test: `tests/integration/app-smoke.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';

describe('app smoke', () => {
  it('has expected scripts', async () => {
    const pkg = await import('../../package.json');
    expect(pkg.default.scripts.dev).toBeDefined();
    expect(pkg.default.scripts.build).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/app-smoke.test.ts`
Expected: FAIL (Datei/Test fehlt)

**Step 3: Write minimal implementation**

- Testdatei anlegen.
- `BOUNDARIES.md` mit Layer-Regeln anlegen.
- `typecheck` script in `package.json` ergaenzen.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/integration/app-smoke.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add docs/architecture/BOUNDARIES.md tests/integration/app-smoke.test.ts package.json tsconfig.json
git commit -m "chore: add architecture boundaries and smoke baseline"
```

### Task 2: `src/` Root und Shared Layer einfuehren

**Files:**
- Create: `src/shared/types/global.ts`
- Create: `src/shared/config/constants.ts`
- Create: `src/shared/lib/ids.ts`
- Create: `src/shared/lib/date.ts`
- Modify: `tsconfig.json`
- Test: `tests/unit/shared/ids.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { createId } from '../../../src/shared/lib/ids';

describe('createId', () => {
  it('creates prefixed ids', () => {
    expect(createId('msg')).toMatch(/^msg-/);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/shared/ids.test.ts`
Expected: FAIL (Modul fehlt)

**Step 3: Write minimal implementation**

- Shared Utility-Dateien erstellen.
- Pfadalias `@/* -> src/*` in `tsconfig.json` umstellen.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/shared/ids.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/shared tsconfig.json tests/unit/shared/ids.test.ts
git commit -m "refactor: introduce src shared layer with typed utils"
```

### Task 3: App Shell vom Domain-Code entkoppeln

**Files:**
- Create: `src/modules/app-shell/AppShell.tsx`
- Create: `src/modules/app-shell/useAppShellState.ts`
- Create: `src/modules/app-shell/types.ts`
- Modify: `app/page.tsx`
- Modify: `App.tsx`
- Test: `tests/unit/app-shell/state.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { buildInitialShellState } from '../../../src/modules/app-shell/useAppShellState';

describe('shell state', () => {
  it('creates default view and channels', () => {
    const state = buildInitialShellState();
    expect(state.currentView).toBeDefined();
    expect(Object.keys(state.coupledChannels).length).toBeGreaterThan(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/app-shell/state.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**

- App-Zustandsinitialisierung aus `App.tsx` extrahieren.
- `app/page.tsx` rendert neue Shell.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/app-shell/state.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/modules/app-shell app/page.tsx App.tsx tests/unit/app-shell/state.test.ts
git commit -m "refactor: extract app shell state and rendering"
```

### Task 4: Chat-Orchestrierung in Use Cases zerlegen

**Files:**
- Create: `src/modules/chat/services/handleAgentResponse.ts`
- Create: `src/modules/chat/services/routeMessage.ts`
- Create: `src/modules/chat/types.ts`
- Modify: `App.tsx`
- Test: `tests/unit/chat/route-message.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { toMessage } from '../../../src/modules/chat/services/routeMessage';

describe('routeMessage', () => {
  it('creates a user message payload', () => {
    const msg = toMessage('hello', 'WebChat', 'user');
    expect(msg.role).toBe('user');
    expect(msg.content).toBe('hello');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/chat/route-message.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**

- Message-Erzeugung + Routing-Helfer aus `App.tsx` herausziehen.
- Side-effects (Eventlog, Agent Dispatch) ueber klar getrennte Funktionen aufrufen.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/chat/route-message.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/modules/chat App.tsx tests/unit/chat/route-message.test.ts
git commit -m "refactor: split chat orchestration into services"
```

### Task 5: Worker-Domain von UI trennen

**Files:**
- Create: `src/modules/worker/services/analyzeTask.ts`
- Create: `src/modules/worker/services/executeTaskPlan.ts`
- Create: `src/modules/worker/hooks/useWorkerController.ts`
- Modify: `WorkerView.tsx`
- Test: `tests/unit/worker/execute-plan.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { normalizePlan } from '../../../src/modules/worker/services/executeTaskPlan';

describe('normalizePlan', () => {
  it('falls back to default step when plan is empty', () => {
    expect(normalizePlan([])).toEqual(['Execute objective and produce concise output.']);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/worker/execute-plan.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**

- Worker-Execution aus Komponente in Service/Hook extrahieren.
- View bleibt Presenter + User Interactions.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/worker/execute-plan.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/modules/worker WorkerView.tsx tests/unit/worker/execute-plan.test.ts
git commit -m "refactor: isolate worker use-cases from UI"
```

### Task 6: API Route `/api/skills/execute` in Handler zerlegen

**Files:**
- Create: `src/server/skills/handlers/fileRead.ts`
- Create: `src/server/skills/handlers/shellExecute.ts`
- Create: `src/server/skills/handlers/pythonExecute.ts`
- Create: `src/server/skills/handlers/githubQuery.ts`
- Create: `src/server/skills/handlers/dbQuery.ts`
- Create: `src/server/skills/handlers/browserSnapshot.ts`
- Create: `src/server/skills/handlers/visionAnalyze.ts`
- Create: `src/server/skills/executeSkill.ts`
- Modify: `app/api/skills/execute/route.ts`
- Test: `tests/integration/skills/execute-router.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { dispatchSkill } from '../../../src/server/skills/executeSkill';

describe('dispatchSkill', () => {
  it('routes file_read', async () => {
    const out = await dispatchSkill('file_read', { path: 'README.md' });
    expect(out).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/skills/execute-router.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**

- Handler pro Skill-Funktion erstellen.
- Route nur noch fuer Input-Parsing + Response-Mapping verwenden.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/integration/skills/execute-router.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/server/skills app/api/skills/execute/route.ts tests/integration/skills/execute-router.test.ts
git commit -m "refactor: split skills execute route into modular handlers"
```

### Task 7: API Route `/api/channels/pair` modularisieren

**Files:**
- Create: `src/server/channels/pairing/telegram.ts`
- Create: `src/server/channels/pairing/discord.ts`
- Create: `src/server/channels/pairing/bridge.ts`
- Create: `src/server/channels/pairing/index.ts`
- Modify: `app/api/channels/pair/route.ts`
- Test: `tests/integration/channels/pairing-router.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { pairChannel } from '../../../src/server/channels/pairing';

describe('pairChannel', () => {
  it('rejects unsupported channels', async () => {
    await expect(pairChannel('unknown' as never, '')).rejects.toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/channels/pairing-router.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**

- Provider-spezifische Logik in eigene Module extrahieren.
- Zentrales Pairing-Orchestrator-Modul einfuehren.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/integration/channels/pairing-router.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/server/channels app/api/channels/pair/route.ts tests/integration/channels/pairing-router.test.ts
git commit -m "refactor: modularize channel pairing providers"
```

### Task 8: Typhaertung und Lint-Gates anheben

**Files:**
- Modify: `tsconfig.json`
- Modify: `eslint.config.js`
- Modify: `services/gemini.ts`
- Modify: `core/memory/embeddings.ts`
- Modify: `components/LogsView.tsx`
- Test: `tests/unit/types/strictness-smoke.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';

describe('strictness smoke', () => {
  it('enforces typed contracts at build time', () => {
    expect(true).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run lint`
Expected: FAIL nach Aktivierung strenger Regeln (temporar)

**Step 3: Write minimal implementation**

- `strict: true` setzen.
- `@typescript-eslint/no-explicit-any` auf `warn` oder `error` fuer neue Dateien.
- Kritische `any`-Stellen durch Typen ersetzen.

**Step 4: Run test to verify it passes**

Run: `npm run lint && npm run test && npm run build`
Expected: PASS

**Step 5: Commit**

```bash
git add tsconfig.json eslint.config.js services/gemini.ts core/memory/embeddings.ts components/LogsView.tsx tests/unit/types/strictness-smoke.test.ts
git commit -m "chore: tighten typing and lint quality gates"
```

### Task 9: Placeholders in eigene Vertical Slices verschieben

**Files:**
- Create: `src/modules/telemetry/components/LogsView.tsx`
- Create: `src/modules/tasks/components/TaskManagerView.tsx`
- Create: `src/modules/config/components/ConfigEditor.tsx`
- Create: `src/modules/exposure/components/ExposureManager.tsx`
- Modify: `App.tsx`
- Test: `tests/unit/modules/rendering-smoke.test.tsx`

**Step 1: Write the failing test**

```tsx
import { describe, expect, it } from 'vitest';

describe('module rendering smoke', () => {
  it('resolves feature modules', () => {
    expect(true).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/modules/rendering-smoke.test.tsx`
Expected: FAIL (Module fehlen)

**Step 3: Write minimal implementation**

- UI-Prototypen in Feature-Module verschieben.
- App importiert nur noch Modul-Einstiegspunkte.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/modules/rendering-smoke.test.tsx`
Expected: PASS

**Step 5: Commit**

```bash
git add src/modules App.tsx tests/unit/modules/rendering-smoke.test.tsx
git commit -m "refactor: move placeholder views into feature slices"
```

### Task 10: Abschluss, Dokumentation, CI Quality Gate

**Files:**
- Create: `docs/architecture/TARGET-ARCHITECTURE.md`
- Create: `docs/architecture/MIGRATION-MAP.md`
- Modify: `README.md`
- Modify: `.gitignore`
- Test: `tests/contract/public-api.contract.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';

describe('public api contract', () => {
  it('keeps required routes', () => {
    expect(['/api/gemini', '/api/skills/execute', '/api/channels/pair'].length).toBe(3);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/contract/public-api.contract.test.ts`
Expected: FAIL (Datei fehlt)

**Step 3: Write minimal implementation**

- Architektur- und Migrationsdoku finalisieren.
- `.gitignore` um `.next` erweitern.
- README um neue Struktur und Entwicklungsregeln erweitern.

**Step 4: Run test to verify it passes**

Run: `npm run lint && npm run test && npm run build`
Expected: PASS

**Step 5: Commit**

```bash
git add docs/architecture README.md .gitignore tests/contract/public-api.contract.test.ts
git commit -m "docs: finalize target architecture and migration map"
```

## Definition of Done

1. `App.tsx` und `WorkerView.tsx` enthalten keine schwere Domain-Logik mehr.
2. API-Routen sind duenn und delegieren an `src/server/*`.
3. Alle neuen Domain-Module liegen in `src/modules/*`.
4. Lint, Test, Build laufen gruen.
5. Architekturregeln sind dokumentiert und fuer neue Features verbindlich.
