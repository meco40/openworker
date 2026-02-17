# Organizations / Team Collaboration Removal Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
>
> **Status-Hinweis (2026-02-15):** Dieser UI-spezifische Plan ist in den breiteren Single-Principal Security-First Plan ueberfuehrt:
> `docs/plans/2026-02-15-single-user-consolidation-implementation-plan.md`.

**Goal:** Den Bereich `Organizations` / `Team Collaboration` vollstaendig aus der WebUI entfernen, inklusive Navigation, View-Routing, State, Typen und toten Komponenten-Referenzen.

**Architecture:** Entferne die Feature-Flaeche am Einstiegspunkt (`Sidebar` + `AppShellViewContent`) und ziehe den Cleanup bis zu Root-State (`App.tsx`), Shared-Typen (`types.ts`) und Seed-Konstanten (`constants.ts`) durch. Sichere das Verhalten mit gezielten Unit-Tests gegen Regressionen (legacy `defaultView: "teams"` -> Fallback auf `dashboard`).

**Tech Stack:** Next.js/React 19, TypeScript 5, Vitest, ESLint.

---

Skill-Referenzen fuer die Umsetzung: `@superpowers:test-driven-development`, `@superpowers:verification-before-completion`, `@superpowers:requesting-code-review`.

### Entscheidungsnotiz (Brainstorming)

Option A: Nur Sidebar-Eintrag entfernen.
Trade-off: Schnell, aber toter Code bleibt (`View.TEAMS`, `TeamManager`, Team-State), erhoeht Wartungskosten.

Option B: Vollstaendiger Runtime-Cleanup (empfohlen).
Trade-off: Mehr Dateien aendern, dafuer keine Schattenreferenzen und klarere Domain-Grenzen.

Option C: Feature-Flag + verstecken statt loeschen.
Trade-off: Reversibel, aber mehr Komplexitaet und weiterhin Wartungsaufwand fuer ungenutzten Code.

Empfehlung: **Option B**, weil der Auftrag explizit "komplett mit allen Verweisen" ist.

Nicht-Ziel: `ChannelType.TEAMS` (Microsoft Teams Channel) bleibt unveraendert, da fachlich unabhaengig von `Team Collaboration` View.

### Task 1: Regressionstests fuer Entfernung und Legacy-Fallback

**Files:**

- Modify: `tests/unit/components/sidebar-memory-item.test.ts`
- Modify: `tests/unit/app-shell/default-view-config.test.ts`

**Step 1: Write the failing test**

Erweitere `tests/unit/components/sidebar-memory-item.test.ts`:

```ts
expect(html).not.toContain('Team Collaboration');
```

Erweitere `tests/unit/app-shell/default-view-config.test.ts`:

```ts
expect(resolveViewFromConfig('teams')).toBe(View.DASHBOARD);
expect(resolveDefaultViewFromConfig({ ui: { defaultView: 'teams' } })).toBe(View.DASHBOARD);
```

**Step 2: Run test to verify it fails**

Run:

```bash
npm run test -- tests/unit/components/sidebar-memory-item.test.ts tests/unit/app-shell/default-view-config.test.ts
```

Expected: FAIL, weil Sidebar aktuell `Team Collaboration` enthaelt und `teams` derzeit als gueltige View aufgeloest wird.

**Step 3: Write minimal implementation**

Keine Implementierung in diesem Task; Tests bleiben bewusst rot bis Cleanup-Tasks umgesetzt sind.

**Step 4: Run test to verify it still fails for the expected reasons**

Run erneut:

```bash
npm run test -- tests/unit/components/sidebar-memory-item.test.ts tests/unit/app-shell/default-view-config.test.ts
```

Expected: FAIL mit denselben fachlichen Ursachen (keine neuen, unerwarteten Fehler).

**Step 5: Commit**

```bash
git add tests/unit/components/sidebar-memory-item.test.ts tests/unit/app-shell/default-view-config.test.ts
git commit -m "test: add regression coverage for team collaboration removal"
```

### Task 2: Navigation und View-Identifier entfernen

**Files:**

- Modify: `components/Sidebar.tsx`
- Modify: `types.ts`

**Step 1: Write the failing test**

Nutze die roten Tests aus Task 1 als Gate.

**Step 2: Run test to verify it fails**

```bash
npm run test -- tests/unit/components/sidebar-memory-item.test.ts tests/unit/app-shell/default-view-config.test.ts
```

Expected: FAIL.

**Step 3: Write minimal implementation**

In `components/Sidebar.tsx` den `items`-Eintrag mit `id: View.TEAMS` entfernen.

In `types.ts`:

```ts
export enum View {
  DASHBOARD = 'dashboard',
  CHAT = 'chat',
  CONFIG = 'config',
  SKILLS = 'skills',
  EXPOSURE = 'exposure',
  WIZARD = 'wizard',
  CHANNELS = 'channels',
  LOGS = 'logs',
  STATS = 'stats',
  SECURITY = 'security',
  PROFILE = 'profile',
  TASKS = 'tasks',
  MODELS = 'models',
  WORKER = 'worker',
  PERSONAS = 'personas',
  MEMORY = 'memory',
}
```

**Step 4: Run test to verify it passes**

```bash
npm run test -- tests/unit/components/sidebar-memory-item.test.ts tests/unit/app-shell/default-view-config.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add components/Sidebar.tsx types.ts
git commit -m "refactor: remove Team Collaboration navigation view"
```

### Task 3: AppShell-Rendering und Props entkoppeln

**Files:**

- Modify: `src/modules/app-shell/components/AppShellViewContent.tsx`

**Step 1: Write the failing test**

Fuege eine statische Guard-Assertion in `tests/unit/app-shell/default-view-config.test.ts` hinzu, damit keine `View.TEAMS`-Nutzung wieder eingefuehrt wird:

```ts
expect(resolveViewFromConfig('teams')).toBe(View.DASHBOARD);
```

Dieser Check muss gruen bleiben.

**Step 2: Run test to verify baseline**

```bash
npm run test -- tests/unit/app-shell/default-view-config.test.ts
```

Expected: PASS.

**Step 3: Write minimal implementation**

In `src/modules/app-shell/components/AppShellViewContent.tsx`:

- `Team`-Typimport entfernen.
- `TeamManager` Dynamic Import entfernen.
- Props `teams` und `setTeams` entfernen.
- Branch `{currentView === View.TEAMS && ...}` komplett entfernen.

Resultierender Prop-Slice:

```ts
interface AppShellViewContentProps {
  currentView: View;
  gatewayState: GatewayState;
  controlPlaneMetricsState: ControlPlaneMetricsState;
  scheduledTasks: ScheduledTask[];
  tasks: WorkerTask[];
  skills: Skill[];
  setSkills: React.Dispatch<React.SetStateAction<Skill[]>>;
  // ...
}
```

**Step 4: Run test to verify it passes**

```bash
npm run typecheck
```

Expected: FAIL aktuell wegen verbleibender Aufrufer in `App.tsx` (wird in Task 4 bereinigt).  
Direkt danach als enger Check:

```bash
npm run test -- tests/unit/app-shell/default-view-config.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/modules/app-shell/components/AppShellViewContent.tsx
git commit -m "refactor: remove TeamManager view branch from app shell"
```

### Task 4: Root-State, Konstanten und Team-Domain entfernen

**Files:**

- Modify: `App.tsx`
- Modify: `constants.ts`
- Modify: `types.ts`
- Delete: `components/TeamManager.tsx`

**Step 1: Write the failing test**

Nutze `npm run typecheck` als roten Test fuer verbleibende Team-Referenzen nach Task 3.

**Step 2: Run test to verify it fails**

```bash
npm run typecheck
```

Expected: FAIL wegen nicht mehr existierender Props/Typen.

**Step 3: Write minimal implementation**

In `App.tsx`:

- `Team`, `WorkerTask` (nur falls danach ungenutzt) und `INITIAL_TEAMS` Import entfernen.
- `teams`/`setTeams` State entfernen.
- `tasks` State entfernen, falls nur fuer TeamManager genutzt.
- Props `teams`, `setTeams`, `tasks` beim `AppShellViewContent`-Call entfernen.

In `constants.ts`:

- `Team` Import entfernen.
- `INITIAL_TEAMS` Block komplett entfernen.

In `types.ts`:

- `interface Team { ... }` komplett entfernen (wenn keine Referenz mehr vorhanden).

Datei loeschen:

```bash
git rm components/TeamManager.tsx
```

**Step 4: Run test to verify it passes**

```bash
npm run typecheck
npm run test -- tests/unit/components/sidebar-memory-item.test.ts tests/unit/app-shell/default-view-config.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add App.tsx constants.ts types.ts
git commit -m "refactor: remove organizations domain state and component"
```

### Task 5: Verifikation "alle Verweise entfernt" + Qualitaets-Gate

**Files:**

- Modify: `docs/plans/2026-02-15-organizations-team-collaboration-removal-implementation-plan.md` (optional: Haken/Status)

**Step 1: Write the failing test**

Definiere Such-Gates fuer alte Referenzen im produktiven Code.

**Step 2: Run test to verify it fails (falls noch Reste)**

```bash
rg -n "View\\.TEAMS|Team Collaboration|TeamManager|INITIAL_TEAMS|interface Team" App.tsx components src/modules/app-shell types.ts constants.ts
```

Expected: Keine Treffer.

**Step 3: Write minimal implementation**

Bereinige verbleibende Treffer in den genannten Dateien.

**Step 4: Run test to verify it passes**

```bash
npm run check
npm run test
```

Expected: PASS.

**Step 5: Commit**

```bash
git add -A
git commit -m "chore: verify and finalize organizations/team collaboration removal"
```

### Abschluss-Checkliste

- `Team Collaboration` erscheint nicht mehr in der Sidebar.
- `Organizations` UI ist nicht mehr renderbar.
- `View.TEAMS` existiert nicht mehr.
- `TeamManager.tsx` ist entfernt.
- `INITIAL_TEAMS` und `Team`-Domain-Typ sind entfernt.
- Legacy config value `ui.defaultView = "teams"` faellt auf `dashboard` zurueck.
- `npm run check` und `npm run test` laufen gruen.
