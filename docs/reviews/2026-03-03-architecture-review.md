# Architecture & Code Review — OpenClaw Gateway Control Plane

**Datum:** 2026-03-03  
**Reviewer:** Senior Staff Engineer (AI-Assisted Review)  
**Basis:** Static Code Analysis · Vollständige Codebase-Inspektion  
**Scope:** Next.js 16 App Router · TypeScript · React 19 · SQLite · WebSocket Gateway

---

## 1 · Executive Summary

| #   | Typ             | Befund                                                                                                                  |
| --- | --------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 🔴  | **Security**    | `proxy.ts` ist totes Code — kein `middleware.ts` existiert; API-Token-Schutz für 7 Route-Gruppen ist inaktiv            |
| 🔴  | **Security**    | `LoginForm.tsx` pre-populiert Standardzugangsdaten (`admin@local.dev` / `admin1234`) als React-State-Defaults           |
| 🔴  | **Security**    | `REQUIRE_AUTH=false` als Systemstandard — alle API-Routen ohne Login erreichbar                                         |
| 🔴  | **Security**    | Hardcoded JWT-Fallback-Secret (`openclaw-local-nextauth-secret`) in `src/auth.ts` + `server.ts`                         |
| 🟡  | **Architektur** | `App.tsx` ist eine ~323-Zeilen Monolith-Clientkomponente mit 10+ Hooks + direktem Prop-Drilling; fehlende State-Schicht |
| 🟡  | **Bundle**      | `mermaid`, `three`, `@xyflow/react`, `recharts` ohne Dynamic Import — laden immer, egal welcher View aktiv ist          |
| 🟡  | **Reliability** | In-Memory Rate-Limiting und SSE-Client-Registry (Module-Level `Set`) — nicht multi-process-sicher                       |
| 🟡  | **Testing**     | Coverage-Ausschlüsse praktisch alle UI-Module und mehrere Kern-API-Layer — reale Coverage deutlich unter 60%            |
| 🟡  | **DX**          | Kein strukturiertes Logging (alles `console.log/warn/error`) — kein Tracing, kein Sentry-Hook                           |
| 🟢  | **Chance**      | `withUserContext`-Wrapper ist sauber abstrahiert; konsequente `runtime = 'nodejs'`-Annotationen                         |
| 🟢  | **Chance**      | Architektur-Guard-Tests (`no-explicit-any`, `sqlite-dependency-guard`) als CI-Gate sind vorbildlich                     |
| 🟢  | **Chance**      | Gateway-Protokoll (JSON-RPC-Frames, Keepalive, Rate-Limit, Seq-Tracking) solide implementiert                           |

---

## 2 · Architecture Map

```
Browser (React 19, CSR nach Initial Load)
  │
  ├─ AppShell.tsx (RSC) ──► App.tsx ('use client', Monolith)
  │     └─ 10 Custom Hooks ──► ws-client.ts ──► /ws (WebSocket)
  │
  ├─ /login  ──► LoginForm.tsx ('use client')
  └─ /mission-control/__  ──► WorkspaceDashboard (Client)

HTTP API Layer (Next.js App Router)
  │
  ├─ app/api/**  ──► withUserContext() ──► src/server/ Services
  │     └─ ~30 Verzeichnisse · runtime='nodejs' · force-dynamic
  │
  └─ [KEIN middleware.ts]  ◄── proxy.ts existiert aber ist nie aktiv!

Custom Server (server.ts)
  ├─ Next.js HTTP request handler
  ├─ WebSocketServer (/ws, /ws-agent-v2)
  │     └─ JWT-Auth ──► handleConnection ──► dispatchMethod
  │            └─ methods/{chat,logs,presence,sessions,channels,agent-v2}
  └─ Runtimes: telegram poller, swarm orchestrator, task workspace cleanup

Scheduler (scheduler.ts) — separater Prozess
  └─ automation, knowledge ingestion, optional swarm

Persistence: SQLite (better-sqlite3)
  ├─ Auth DB (.local/auth.db)
  ├─ Core-Memory DB (MEMORY_DB_PATH)
  └─ Model-Hub / Channels / Tasks / etc. per Domain

AI Layer
  └─ src/services/gateway.ts → /api/model-hub/gateway (dispatch + fallback)
       └─ Provider-Agnostic: Gemini, OpenAI, OpenRouter
```

---

## 3 · Findings (Priorisiert)

### A — Architektur & Projektstruktur

| Titel                                   | Pfad / Ort                                              | Impact | Aufwand | Risiko |
| --------------------------------------- | ------------------------------------------------------- | ------ | ------- | ------ |
| App.tsx Monolith                        | `src/modules/app-shell/App.tsx`                         | High   | M       | Med    |
| Missionscontrol-Page ohne RSC-Nutzen    | `app/mission-control/page.tsx`                          | Low    | S       | Low    |
| `src/services/gateway.ts` nur 1 Datei   | `src/services/`                                         | Low    | S       | Low    |
| Zwei parallele SSE/WS-Broadcast-Systeme | `src/lib/events.ts` + `src/server/gateway/broadcast.ts` | Med    | L       | Med    |

---

#### A-1 · App.tsx ist ein 323-Zeilen Client-Monolith

**Problem:** `App.tsx` enthält alle lokalen State-Variablen (View, Conversations, Messages, Channels, DebugState, ScheduledTasks, Metrics), 10+ Custom-Hook-Instanziierungen und eine vollausgebaute `sendChatMessage`-Funktion (~80 Zeilen). Alle Props werden manuell `AppShellViewContent` übergeben (15+ Props).

**Auswirkung:** Jede State-Mutation triggert potenziell Re-Renders des gesamten Trees. Neues Feature = Änderung dieser Datei. Schwer testbar.

**Empfehlung:** Aufteilen in Zustand-Schicht (Zustand Store ist bereits im Projekt verfügbar!), Hook-Komposition und reine View-Komponenten.

```typescript
// Vorher: lokaler State in App.tsx
const [messages, setMessages] = useState<Message[]>([]);

// Nachher: Zustand Store
// src/modules/app-shell/store/chatStore.ts
import { create } from 'zustand';
export const useChatStore = create<ChatState>((set) => ({
  messages: [],
  addMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
  // ...
}));
```

**Nächster Schritt:** `useConversationSync`, `useGatewayState`, `useTaskScheduler` in einen Zustand-Store extrahieren; `App.tsx` auf <100 Zeilen reduzieren.

---

#### A-2 · Zwei parallele Event-Broadcast-Systeme

**Problem:** `src/lib/events.ts` implementiert einen eigenen SSE-Client-Broadcaster (module-level `Set<ReadableStreamDefaultController>`). `src/server/gateway/broadcast.ts` ist das WebSocket-Broadcast-System. Beide existieren parallel ohne Koordination.

**Auswirkung:** Duplizierter Infra-Code; SSE-System skaliert nicht (statischer In-Memory-State; resets bei jedem Server-Restart oder in Multi-Worker-Setups).

```typescript
// src/lib/events.ts — Zeile 7: Problem
const clients = new Set<ReadableStreamDefaultController>(); // module-global!
```

**Empfehlung:** SSE-Route auf das bestehende Gateway-Event-System aufbauen (oder per Server-Sent-Events als Wrapper des WebSocket-Feeds anbieten). Kurzfristig: Kommentar, dass dies single-process only ist.

---

### B — Routing, Rendering & Next.js Best Practices

| Titel                                                     | Pfad / Ort                              | Impact | Aufwand | Risiko |
| --------------------------------------------------------- | --------------------------------------- | ------ | ------- | ------ |
| Root `page.tsx` macht DB-Call direkt                      | `app/page.tsx`                          | Med    | S       | Low    |
| Keine `loading.tsx` / `error.tsx` im App Router           | `app/`                                  | Med    | S       | Low    |
| `app/mission-control/page.tsx` nutzt keinen RSC-Vorteil   | `app/mission-control/page.tsx`          | Low    | S       | Low    |
| `WorkspaceDashboard` ist reine Client-Komponente ohne RSC | `src/components/WorkspaceDashboard.tsx` | Low    | M       | Low    |
| SSE Route fehlt `export const runtime = 'nodejs'`         | `app/api/events/stream/route.ts`        | Med    | S       | Low    |

---

#### B-1 · Fehlende App-Router-Konventionen (loading.tsx / error.tsx)

**Problem:** Im gesamten `app/`-Verzeichnis gibt es weder `loading.tsx` noch `error.tsx` Dateien. Next.js App Router nutzt diese für automatisches Streaming (Suspense) und Fehlermanagement auf Route-Ebene.

**Auswirkung:** Kein natives Streaming/Suspense. Bei Server-Fehlern erhält der User einen leeren Screen oder einen unstrukturierten Fehler statt einer kontrollierten Fallback-Seite.

**Empfehlung:**

```
app/
├── loading.tsx          ← Globaler Loading-State (Skeleton / Spinner)
├── error.tsx            ← Globaler Error-Handler (mit reset())
├── not-found.tsx        ← 404-Seite
└── mission-control/
    └── loading.tsx      ← Segment-spezifischer Loading
```

```tsx
// app/loading.tsx
export default function Loading() {
  return (
    <div className="flex h-screen items-center justify-center bg-[#0a0a0a] text-zinc-400">
      Loading…
    </div>
  );
}

// app/error.tsx
('use client');
export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="flex h-screen flex-col items-center justify-center bg-[#0a0a0a]">
      <p className="text-red-400">{error.message}</p>
      <button onClick={reset}>Retry</button>
    </div>
  );
}
```

---

#### B-2 · SSE Route fehlt `runtime = 'nodejs'`

**Problem:** `app/api/events/stream/route.ts` importiert `src/lib/events.ts` (Node.js Globals), deklariert aber kein `export const runtime = 'nodejs'`.

**Auswirkung:** In zukünftigen Next.js-Deployments (Vercel Edge Runtime, etc.) könnte der Build fehlschlagen.

**Fix (S, 2 Zeilen):**

```typescript
// app/api/events/stream/route.ts — ergänzen:
export const runtime = 'nodejs';
```

---

### C — Performance & Bundle

| Titel                                               | Pfad / Ort                                      | Impact | Aufwand | Risiko |
| --------------------------------------------------- | ----------------------------------------------- | ------ | ------- | ------ |
| Schwere Deps ohne Dynamic Import                    | `package.json` · `src/modules/**`               | High   | M       | Low    |
| `playwright` in `dependencies`                      | `package.json`                                  | Med    | S       | Low    |
| `useAgentRuntime` lädt Skills-Code im Client-Bundle | `src/modules/app-shell/useAgentRuntime.ts` L6–9 | Med    | M       | Med    |
| Kein Image-Optimierungslayer                        | Keine `<Image>` aus `next/image` sichtbar       | Low    | S       | Low    |

---

#### C-1 · `mermaid`, `three`, `@xyflow/react`, `recharts` immer im Bundle

**Problem:** Alle diese schweren Bibliotheken sind in `dependencies` und werden implizit in den Client-Bundle eingebunden, egal welcher View aktiv ist:

- `mermaid`: ~1MB
- `three` + `@met4citizen/talkinghead`: mehrere MB (3D-Avatar)
- `@xyflow/react`: ~300KB
- `recharts`: ~300KB

**Auswirkung:** Stark erhöhter Initial-Load (geschätzt +2-4MB Bundle) auch für User, die z.B. nur den Chat nutzen.

**Empfehlung:** Dynamic Imports mit `next/dynamic` pro View:

```typescript
// src/modules/app-shell/components/AppShellViewContent.tsx
const MermaidView = dynamic(() => import('@/modules/flow-builder/MermaidView'), {
  loading: () => <Skeleton />,
  ssr: false,
});

const AvatarView = dynamic(() => import('@/modules/personas/AvatarRenderer'), {
  ssr: false,
});
```

---

#### C-2 · Skills-Code im Client-Bundle via `useAgentRuntime`

**Problem:** `useAgentRuntime.ts` importiert direkt:

```typescript
import { mapSkillsToTools } from '@/skills/definitions';
import { executeSkillFunctionCall } from '@/skills/execute';
import { subscribeClawHubChanged } from '@/skills/clawhub-events';
import { CORE_MEMORY_TOOLS, handleCoreMemoryCall } from '@/core/memory';
```

Diese Module werden in den Client-Bundle gezogen. `executeSkillFunctionCall` insbesondere kann Imports von node-spezifischen Skills (`shell-access`, `filesystem` etc.) transitiv einbeziehen.

**Empfehlung:** Skill-Ausführung über `chat.stream` WebSocket-Methode serverseitig halten. Client sendet nur Message + Attachments; Gateway führt Skills aus und streamt Ergebnisse zurück. Dies ist bereits das Pattern — `executeSkillFunctionCall` im Client ist ein Duplikat.

---

### D — State, Forms, Data Models

| Titel                                         | Pfad / Ort                            | Impact | Aufwand | Risiko |
| --------------------------------------------- | ------------------------------------- | ------ | ------- | ------ |
| `window.confirm()` für Destructive Actions    | 10+ Stellen in `src/modules/**`       | Med    | M       | Low    |
| Kein optimistisches Update bei Message-Delete | `App.tsx` `handleDeleteMessage`       | Low    | S       | Low    |
| Mixed-Language UI-Strings (DE/EN)             | `src/modules/**`, `src/components/**` | Low    | M       | Low    |
| `callbackUrl` in Login nicht validiert        | `app/login/LoginForm.tsx` L10         | Med    | S       | Med    |

---

#### D-1 · `window.confirm()` ist kein barrierefreies UX-Pattern

**Problem:** Mindestens 10 Stellen nutzen `window.confirm()` für destruktive Aktionen (Löschen, Disconnect, Reject):

- `src/modules/ops/components/NodesView.tsx`
- `src/modules/cron/hooks/useCronRules.ts`
- `src/modules/app-shell/App.tsx`
- `src/components/personas/hooks/usePersonaCRUD.ts`
- `src/components/memory/hooks/*.ts`
- u.a.

**Auswirkung:** Blockierender synchroner Dialog, in vielen Test-Environments (`jsdom`) nicht verfügbar, nicht themebar, nicht barrierefreiheitskonform.

**Empfehlung:** Gemeinsame `ConfirmDialog`-Komponente (Headless-Modal):

```typescript
// src/components/shared/ConfirmDialog.tsx
export function useConfirm() {
  // Returns a Promise<boolean> — triggered by modal, not window.confirm
}
```

---

#### D-2 · Open-Redirect-Risiko bei `callbackUrl`

**Problem:** In `LoginForm.tsx` Zeile 10:

```typescript
const callbackUrl = searchParams.get('callbackUrl') || '/';
```

Nach erfolgreichem Login wird `router.push(result.url || callbackUrl)` aufgerufen. `result.url` kommt von NextAuth, das normalerweise den Origin validiert — aber `callbackUrl` direkt zu vertrauen (ohne eigene URL-Validierung vor der Übergabe an `signIn`) kann ein Open-Redirect erzeugen, wenn ein Angreifer eine externe URL einschmuggelt.

**Fix:**

```typescript
function sanitizeCallbackUrl(raw: string | null): string {
  if (!raw) return '/';
  try {
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin) return '/';
    return url.pathname + url.search;
  } catch {
    return '/';
  }
}
const callbackUrl = sanitizeCallbackUrl(searchParams.get('callbackUrl'));
```

---

### E — Security ⚠️

| Titel                                             | Pfad / Ort                          | Impact   | Aufwand | Risiko   |
| ------------------------------------------------- | ----------------------------------- | -------- | ------- | -------- |
| **proxy.ts ist dead code** (kein middleware.ts)   | `proxy.ts` root                     | **High** | **S**   | **High** |
| Hardcoded Default-Credentials in LoginForm UI     | `app/login/LoginForm.tsx` L14–15    | **High** | **S**   | **High** |
| `REQUIRE_AUTH=false` als Default                  | `src/server/auth/userContext.ts`    | **High** | S       | High     |
| Hardcoded JWT-Secret-Fallback                     | `src/auth.ts` L5 · `server.ts` L41  | **High** | S       | High     |
| Default Admin-Passwort in DB-Init                 | `src/server/auth/userStore.ts` L123 | High     | S       | High     |
| `MC_API_TOKEN` ohne middleware nicht durchgesetzt | `proxy.ts` L3                       | High     | S       | High     |
| Kein CSRF-Schutz auf Mutations (Custom-Server)    | `server.ts`, API-Routes             | Med      | M       | Med      |
| SSE-Token als URL Query-Param                     | `proxy.ts` L109                     | Med      | S       | Med      |

---

#### E-1 · 🔴 KRITISCH: `proxy.ts` ist nie aktiv

**Problem:** `proxy.ts` exportiert eine `proxy()`-Funktion und ein Next.js-Middleware-`config`-Objekt — aber es existiert **keine `middleware.ts`**-Datei im Projekt-Root. Next.js sucht ausschließlich nach `middleware.ts` (oder `middleware.js`) im Root. Die exportierte Schutzlogik für folgende Route-Gruppen wird **nie ausgeführt**:

```typescript
export const config = {
  matcher: [
    '/api/tasks/:path*', // ← UNGESCHÜTZT
    '/api/agents/:path*', // ← UNGESCHÜTZT
    '/api/openclaw/:path*', // ← UNGESCHÜTZT
    '/api/events/:path*', // ← UNGESCHÜTZT
    '/api/files/:path*', // ← UNGESCHÜTZT
    '/api/workspaces/:path*', // ← UNGESCHÜTZT
    '/api/webhooks/:path*', // ← UNGESCHÜTZT
  ],
};
```

**Fix (S — 15 Minuten):** `proxy.ts` in `middleware.ts` umbenennen und die `proxy`-Funktion als Default-Export exponieren:

```typescript
// middleware.ts (Root-Ebene)
import { proxy } from './proxy';
export default proxy;
export { config } from './proxy';
```

**Nächster Schritt:** Sofort umsetzen. Sicherheitskritisch.

---

#### E-2 · 🔴 Hardcoded Credentials in Login-UI

**Problem:** `LoginForm.tsx` pre-populiert Standardzugangsdaten als React-State-Defaults, die im Browser sichtbar sind:

```typescript
const [email, setEmail] = useState('admin@local.dev'); // ← im Bundle!
const [password, setPassword] = useState('admin1234'); // ← im Bundle!
```

Zusätzlich zeigt die UI explizit: `Standard lokal: admin@local.dev / admin1234`.

**Auswirkung:** Jeder, der die Seite aufruft, sieht sofort die Standard-Credentials. In einem Produktions-Deploy mit `REQUIRE_AUTH=true` ist dies ein ernsthaftes Credential-Leak.

**Fix:**

```typescript
// Nur in Development pre-populieren:
const isDev = process.env.NODE_ENV === 'development';
const [email, setEmail] = useState(isDev ? 'admin@local.dev' : '');
const [password, setPassword] = useState(isDev ? 'admin1234' : '');
// Hinweis-Text nur in Dev anzeigen:
{isDev && <p>Standard lokal: <code>admin@local.dev</code> / <code>admin1234</code></p>}
```

---

#### E-3 · 🔴 Hardcoded JWT-Secret-Fallback

**Problem:** In `src/auth.ts` Zeile 5 und `server.ts` Zeile 41:

```typescript
const LOCAL_DEVELOPMENT_AUTH_SECRET = 'openclaw-local-nextauth-secret';
// server.ts:
const SECRET =
  process.env.NEXTAUTH_SECRET?.trim() ||
  process.env.AUTH_SECRET?.trim() ||
  'openclaw-local-nextauth-secret';
```

Wenn weder `NEXTAUTH_SECRET` noch `AUTH_SECRET` gesetzt sind, werden JWTs mit einem **bekannten, öffentlichen** String signiert. Ein Angreifer kann gültige Session-Tokens fälschen.

**Fix:** Startup fehlschlagen lassen, wenn kein Secret gesetzt ist (außer explizitem Dev-Override):

```typescript
function resolveNextAuthSecret(): string {
  const secret = process.env.NEXTAUTH_SECRET?.trim() || process.env.AUTH_SECRET?.trim();
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('NEXTAUTH_SECRET must be set in production!');
    }
    console.warn('[auth] WARNING: Using insecure dev-only JWT secret.');
    return 'openclaw-local-nextauth-secret';
  }
  return secret;
}
```

---

#### E-4 · SSE-Token als URL Query-Parameter

**Problem:** `proxy.ts` Zeile 109 erlaubt Token-Authentifizierung via URL-Query-Parameter (`?token=…`) für `/api/events/stream`. Query-Parameter erscheinen in Server-Logs, Browser-History, Referrer-Headern und Proxy-Caches.

**Empfehlung:** Token im `Authorization`-Header senden oder kurzlebiges Session-Token via POST generieren und dann für den SSE-Stream verwenden.

---

### F — Reliability & Observability

| Titel                                                                       | Pfad / Ort                                 | Impact | Aufwand | Risiko |
| --------------------------------------------------------------------------- | ------------------------------------------ | ------ | ------- | ------ |
| Rate-Limiting in-process (nicht multi-process-safe)                         | `src/server/gateway/connection-handler.ts` | Med    | L       | Med    |
| SSE-Client-Set global (nicht multi-process-safe)                            | `src/lib/events.ts` L7                     | Med    | M       | Med    |
| Kein strukturiertes Logging / Tracing                                       | Codebase-weit                              | Med    | L       | Low    |
| `src/modules/app-shell/useAgentRuntime.ts` schreibt blankes `console.error` | Zeile 251                                  | Low    | S       | Low    |
| Force-Exit nach 10s in Shutdown-Handler                                     | `server.ts` L190                           | Low    | S       | Low    |
| ErrorBoundary meldet nicht extern (kein Sentry)                             | `src/components/ErrorBoundary.tsx` L50     | Med    | M       | Low    |

---

#### F-1 · Kein strukturiertes Logging

**Problem:** Über die gesamte Codebase wird `console.log/warn/error` verwendet ohne einheitliches Format, Log-Level-Kontrolle oder strukturierte Metadaten (keine Request-IDs, keine User-IDs, keine Trace-IDs).

**Auswirkung:** Produktions-Debugging ist schwierig. Kein zentrales Log-Aggregation möglich ohne Post-Processing.

**Empfehlung:** Minimales strukturiertes Logger-Interface einführen:

```typescript
// src/shared/lib/logger.ts
export const logger = {
  info: (msg: string, meta?: Record<string, unknown>) =>
    console.log(JSON.stringify({ level: 'info', msg, ...meta, ts: Date.now() })),
  warn: (msg: string, meta?: Record<string, unknown>) =>
    console.warn(JSON.stringify({ level: 'warn', msg, ...meta, ts: Date.now() })),
  error: (msg: string, meta?: Record<string, unknown>) =>
    console.error(JSON.stringify({ level: 'error', msg, ...meta, ts: Date.now() })),
};
```

---

### G — DX & Codequalität

| Titel                                                       | Pfad / Ort                | Impact | Aufwand | Risiko |
| ----------------------------------------------------------- | ------------------------- | ------ | ------- | ------ |
| Coverage-Ausschlüsse decken ~70% der kritischen UI-Pfade ab | `vitest.config.ts` L51–67 | High   | L       | Med    |
| `playwright` in `dependencies` (nicht devDependencies)      | `package.json`            | Low    | S       | Low    |
| Kein `middleware.ts` verhindert Proxy-Tests                 | Testlücke E2E             | Med    | M       | Med    |
| Kein CI-Test für Auth-Flows                                 | `tests/unit/auth/` fehlt  | High   | M       | Med    |
| Gemisch aus Deutsch/Englisch in UI-Strings                  | gesamte `src/`            | Low    | L       | Low    |

---

#### G-1 · Coverage-Ausschlüsse zu weit

**Problem:** `vitest.config.ts` schließt aus der Coverage aus:

```typescript
exclude: [
  'components/**', // ← gesamte UI
  'src/modules/**', // ← gesamte Frontend-Module
  'app/api/model-hub/**', // ← kritischer AI-Gateway
  'src/server/skills/**', // ← alle Skill-Handlers
  'src/server/personas/**',
  'src/server/channels/messages/service.ts',
  // ...
];
```

Die tatsächlich gecoverte Basis ist deutlich kleiner als die gemeldeten 60%-Schwellenwerte vermuten lassen.

**Empfehlung:** Ausschlüsse auf echte Unverifiable-Cases reduzieren (z.B. WebSocket-Integration-Tests die laufenden Server benötigen). Für `channels/messages/service.ts` und `model-hub`-Routen Unit-Tests mit getrennten Mock-Adaptern schreiben.

---

#### G-2 · `playwright` in production `dependencies`

**Problem:**

```json
"dependencies": {
  "playwright": "^1.58.2", // ← ~80MB, gehört in devDependencies!
```

**Fix:** `playwright` nach `devDependencies` verschieben. Hat Auswirkung auf `standalone`-Output-Größe.

---

### H — Accessibility & UI/UX

| Titel                                             | Pfad / Ort                         | Impact | Aufwand | Risiko |
| ------------------------------------------------- | ---------------------------------- | ------ | ------- | ------ |
| `window.confirm()` (nicht ARIA-konform)           | 10+ Stellen                        | Med    | M       | Low    |
| Kein `aria-label` auf Icon-Only Buttons erkennbar | `src/components/**`                | Med    | M       | Low    |
| Kein `<html lang="...">` i18n                     | `app/layout.tsx` — nur `lang="en"` | Low    | S       | Low    |
| Kein Skip-to-Content Link                         | `app/layout.tsx`                   | Low    | S       | Low    |

---

#### H-1 · `app/layout.tsx` — fehlende Basis-Accessibility

**Problem:** `app/layout.tsx` setzt `lang="en"`, aber UI-Strings sind gemischt DE/EN. Kein Skip-Navigation-Link.

```tsx
// app/layout.tsx — Empfehlung
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="de">
      <body>
        <a href="#main-content" className="sr-only focus:not-sr-only">
          Zum Inhalt springen
        </a>
        <main id="main-content">{children}</main>
      </body>
    </html>
  );
}
```

---

### I — Code Health / "Stop Doing"

| Titel                                                  | Pfad / Ort                                 | Impact | Aufwand | Risiko |
| ------------------------------------------------------ | ------------------------------------------ | ------ | ------- | ------ |
| `window.confirm()` System-Dialog pattern               | 10+ Stellen                                | Med    | M       | Low    |
| Deutsch/Englisch Mix in UI-Strings                     | Codebase-weit                              | Low    | L       | Low    |
| Module-Level State in SSE-Handler                      | `src/lib/events.ts`                        | Med    | M       | Med    |
| Fallback-Secrets die niemals aussteigen                | `src/auth.ts`                              | High   | S       | High   |
| Skills-Code im Client-Bundle (durch `useAgentRuntime`) | `src/modules/app-shell/useAgentRuntime.ts` | Med    | M       | Med    |

---

## 4 · Quick Wins / Short Projects / Initiativen

### ⚡ Quick Wins (≤ 1 Stunde, sofort)

| #    | Aktion                                                                | Datei                            | Aufwand |
| ---- | --------------------------------------------------------------------- | -------------------------------- | ------- |
| QW-1 | **proxy.ts → middleware.ts** umbenennen + default export              | `proxy.ts`                       | 15 min  |
| QW-2 | Credentials im LoginForm nur in `NODE_ENV=development` pre-populieren | `app/login/LoginForm.tsx`        | 20 min  |
| QW-3 | JWT-Secret in Prod-Modus require (throw bei fehlendem Secret)         | `src/auth.ts`                    | 20 min  |
| QW-4 | `playwright` von `dependencies` → `devDependencies`                   | `package.json`                   | 5 min   |
| QW-5 | `export const runtime = 'nodejs'` in SSE-Route ergänzen               | `app/api/events/stream/route.ts` | 5 min   |
| QW-6 | `callbackUrl` in LoginForm gegen Open-Redirect sanitizen              | `app/login/LoginForm.tsx`        | 20 min  |
| QW-7 | `app/loading.tsx` + `app/error.tsx` + `app/not-found.tsx` anlegen     | `app/`                           | 30 min  |

---

### 📅 Short Projects (1–2 Tage)

| #    | Titel                                   | Beschreibung                                                                   | Wert                   |
| ---- | --------------------------------------- | ------------------------------------------------------------------------------ | ---------------------- |
| SP-1 | **Strukturiertes Logging**              | `src/shared/lib/logger.ts` einführen, alle `console.*` migrieren               | Observability          |
| SP-2 | **ConfirmDialog-Komponente**            | Ersatz für alle `window.confirm()` Calls                                       | A11y + UX              |
| SP-3 | **Dynamic Imports für schwere UI-Deps** | `mermaid`, `three`, `recharts`, `@xyflow/react` per `next/dynamic` lazy-loaden | Bundle -30-50%         |
| SP-4 | **Auth-Unit-Tests**                     | `AuthUserStore`, `userContext`, `resolveUserIdFromSession` testen              | Coverage + Reliability |
| SP-5 | **middleware.ts Integration-Test**      | E2E-Test dass geschützte Routes ohne Token 401 zurückgeben                     | Security Regression    |

---

### 🚀 Initiativen (1–2 Wochen)

| #   | Titel                               | Beschreibung                                                                                                   | Wert              |
| --- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------- |
| I-1 | **App.tsx → Zustand-Store**         | Conversations, Messages, Channels, GatewayState in dedizierte Zustand-Stores extrahieren                       | DX + Testbarkeit  |
| I-2 | **Skills Client/Server Split**      | `executeSkillFunctionCall` aus Client-Bundle entfernen; nur serverseitige Ausführung via WebSocket             | Bundle + Security |
| I-3 | **Error-Tracking Integration**      | Sentry oder gleichwertiges Tool; `ErrorBoundary.onError` und Server-Routen-catch; Structured Logging als Basis | Observability     |
| I-4 | **Coverage-Ausschlüsse reduzieren** | Integration-Tests für `channels/messages/service.ts`, `model-hub/gateway`, mind. 1 E2E-Auth-Flow               | Reliability       |
| I-5 | **SSE-System refactoren**           | SSE-Client-Registry auf Redis-Pub/Sub oder Gateway-Event-Subscription umstellen (multi-process-safe)           | Scalability       |

---

## 5 · Konkreter 14-Tage-Maßnahmenplan

### Woche 1 — Security & Critical Fixes

| Tag     | Task                                                            | Owner-Hinweis | Abhängigkeit |
| ------- | --------------------------------------------------------------- | ------------- | ------------ |
| Tag 1   | **QW-1** proxy.ts → middleware.ts (SOFORT)                      | —             | —            |
| Tag 1   | **QW-2** LoginForm: Credentials nur in Dev                      | —             | —            |
| Tag 1   | **QW-3** JWT-Secret: throw in Prod                              | —             | —            |
| Tag 1   | **QW-4–6** Kleinst-Fixes (playwright, SSE runtime, callbackUrl) | —             | —            |
| Tag 2   | **SP-5** Integration-Test: geschützte Routes ohne Token         | —             | QW-1         |
| Tag 2   | **SP-4** Auth-Unit-Tests schreiben                              | —             | —            |
| Tag 3   | **QW-7** loading.tsx / error.tsx / not-found.tsx                | —             | —            |
| Tag 3   | **SP-2** ConfirmDialog-Komponente (erste Version)               | —             | —            |
| Tag 4–5 | **SP-1** Strukturiertes Logging einführen                       | —             | —            |

### Woche 2 — Performance & DX

| Tag       | Task                                                              | Owner-Hinweis | Abhängigkeit |
| --------- | ----------------------------------------------------------------- | ------------- | ------------ |
| Tag 6–7   | **SP-3** Dynamic Imports für schwere Deps                         | —             | —            |
| Tag 8–9   | **I-1 (Start)** Zustand-Store für Conversations + Messages        | —             | —            |
| Tag 10    | Coverage-Ausschlüsse reduzieren (channels/messages)               | —             | SP-4         |
| Tag 11–14 | **I-2 (Planung)** Skills-Client-Server-Split Design-Doc schreiben | —             | —            |

---

## 6 · "Stop Doing"-Liste

| Anti-Pattern                                              | Warum aufhören                                          | Alternative                                                     |
| --------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------- |
| `window.confirm()` für Destructive Actions                | Blockierend, nicht a11y, nicht testbar                  | Eigene `<ConfirmDialog>`-Komponente                             |
| Hardcoded Secrets / Default-Credentials im Code           | Credential-Leak in Prod-Bundles                         | Env-Var-Pflicht mit Startup-Guard                               |
| Module-level Singleton State für HTTP-Request-Scoped Data | Multi-Worker / Hot-Reload bricht es                     | Request-Scope-Daten via Context/Store, nicht Modul-Globals      |
| `console.*` als Logging-System                            | Keine Strukturierung, kein Level, kein Aggregation      | Strukturierter Logger mit JSON-Output                           |
| Skills-Execution-Code im Client-Bundle                    | Bundle-Bloat, Server-Logik im Browser                   | Nur über Gateway-WS-Method `chat.stream`                        |
| Coverage-Ausschlüsse als "Technical Debt Papier"          | Gibt falsches Sicherheitsgefühl                         | Echte Tests oder explizit dokumentierte Testlücken              |
| Gemischte DE/EN UI-Strings ohne i18n                      | Unübersetzte Produktions-UI                             | Unified i18n-System (z.B. `next-intl`) oder konsequent Englisch |
| `callbackUrl` ohne Origin-Validierung                     | Open-Redirect                                           | Origin-Check vor Router-Push                                    |
| Funktionen mit Namen `proxy` als Next.js Middleware       | Middleware muss Default-Export von `middleware.ts` sein | Korrekte Datei-Platzierung + Export                             |

---

## 7 · Annahmen & Offene Punkte (UNCONFIRMED)

> Annahmen, die aus dem Code abgeleitet wurden, aber ohne Runtime-Verifikation:

- **[ASSUMPTION]** `REQUIRE_AUTH=false` ist der produktive Default aufgrund Feature-Flag-Design. Falls dies bewusst so gewollt ist für Self-Hosted-Szenarien, sollte dies explizit in der README dokumentiert werden.
- **[ASSUMPTION]** `src/lib/events.ts` SSE-System wird möglicherweise nur für einen spezifischen nicht-core Use-Case genutzt und ist bewusst einfach gehalten. SSE-Skalierungsproblem ist nur relevant bei Multi-Process-Deployment.
- **[UNCONFIRMED]** Kein `@typescript-eslint` im `devDependencies` — das über `oxlint` abgedeckt wird. TypeScript-Strict-Modus ist konfiguriert (`"strict": true`), aber ob alle Dateien vollständig strict sind wurde nicht bei jeder Datei geprüft.
- **[ASSUMPTION]** `recharts` und `@xyflow/react` werden nur im Stats- bzw. Flow-Builder-View genutzt. Bundle-Impact-Messung über `npm run analyze` wurde nicht ausgeführt — Größenschätzungen sind konservativ.

---

_Generiert: 2026-03-03 · OpenClaw Gateway Control Plane Review_
