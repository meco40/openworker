# Next.js Refactoring Audit (Delete-First)

Datum: 2026-03-02  
Scope: `app/**`, `src/**`, `tests/**` (statische Analyse)

## Abschnitt A: Kern-Flows

- `"/"`: Server-seitiges Auth-Gate + Initial-View-Auflösung, danach Client-AppShell.
- `"/login"`: Credentials-Login via NextAuth.
- Chat-Core: Conversation-Sync + WS-Streaming + MessageService.
- Channel-Coupling/Webhooks: Telegram/WhatsApp/Slack/Discord Pairing + Webhooks.
- Task-Flow: Task CRUD, Planning, Dispatch, Testing.
- Personas-Flow: Sidebar + Editor + File/Meta/Model/Memory-Typ.
- Model-Hub-Flow: Provider Accounts + Pipeline + Connectivity.
- Memory/Knowledge-Flow: Memory CRUD + Knowledge Graph + Retrieval.
- Agent-Room-Flow: Swarm-Erstellung/Steuerung/Export.
- Mission-Control-Subapp: eigenes Dashboard/Workspace/SSE.

Core:

- Auth, AppShell-View-Routing, Chat, Tasks, Personas, Model-Hub, Memory/Knowledge.

Optional:

- Agent Room, Mission-Control-Subapp, Debugger/Stats/Logs/Security/Cron/Flow-Builder, Legacy-/Compat-Wrapper.

Form/Auth/Checkout:

- Form- und Auth-Flows vorhanden, Checkout-Flow nicht vorhanden.

## Abschnitt B: Delete List

| Pfad/Export                                                                                                                                         | Warum unused                                                | Entfernen wie?                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------- |
| `src/components/DemoBanner.tsx`                                                                                                                     | Keine Imports; ruft `/api/demo` auf, Route existiert nicht  | Datei löschen                                 |
| `src/modules/master/hooks/useVoiceAgent.ts`                                                                                                         | Keine produktiven Imports; Master nutzt `useGrokVoiceAgent` | Datei löschen                                 |
| `src/components/personas/hooks/useRoomManagement.ts`                                                                                                | Nur Barrel-Export, keine UI-Nutzung                         | Datei + Barrel-Export löschen                 |
| `src/modules/rooms/**`                                                                                                                              | Orphaned Feature; keine `app/api/rooms/**`-Routen           | Kompletten Stack löschen                      |
| `src/modules/app-shell/App.tsx` Onboarding-Branch + `src/components/TerminalWizard.tsx`                                                             | `onboarded` ist immer `true`; Branch unerreichbar           | Branch entfernen + Datei löschen              |
| `src/lib/store.ts` (`selectedBusiness`, `currentConversation`, `openclawMessages`, zugehörige Setter)                                               | Keine Konsumenten außerhalb des Stores                      | Felder/Aktionen entfernen                     |
| `src/components/stats/prompt-logs/hooks/useExport.ts`                                                                                               | Keine Imports                                               | Datei löschen                                 |
| `src/components/stats/prompt-logs/hooks/usePagination.ts`                                                                                           | Keine Imports                                               | Datei löschen                                 |
| `src/modules/agent-room/components/chat/ChatHeader.tsx` + `chat/index.ts`                                                                           | Im aktuellen Agent-Room-Layout ungenutzt                    | Dateien löschen                               |
| `src/modules/agent-room/components/sidebar/SwarmSidebar.tsx` + `sidebar/index.ts`                                                                   | Im aktuellen Agent-Room-Layout ungenutzt                    | Dateien löschen                               |
| `src/server/channels/messages/service/commandHandlers.ts`                                                                                           | Unbenutzter Backward-Compat-Re-Export                       | Datei löschen                                 |
| `src/server/channels/messages/repository/index.ts`                                                                                                  | Unbenutzter Backward-Compat-Re-Export                       | Datei löschen                                 |
| `src/server/channels/messages/service/subagent/lifecycle/index.ts` (+ Wrapper)                                                                      | Unbenutzte Compat-Exports                                   | Dateien löschen                               |
| `src/lib/openclaw/device-identity.ts`                                                                                                               | Keine Referenzen                                            | Datei löschen                                 |
| `src/modules/gateway/index.ts`                                                                                                                      | Keine Referenzen                                            | Datei löschen                                 |
| `src/server/http/unauthorized.ts`                                                                                                                   | Keine Referenzen                                            | Datei löschen                                 |
| Diverse Barrel-Dateien (`config/hooks`, `memory/hooks`, `profile/hooks`, etc.)                                                                      | Keine produktiven Referenzen                                | Dateien löschen                               |
| `coverage/**`                                                                                                                                       | Generierte Artefakte sind im Repo getrackt                  | Verzeichnis entfernen + `.gitignore` ergänzen |
| `check-swarm.cjs`, `check-swarm.js`, `scripts/check-swarm.mjs`, `scripts/e2e/start-e2e-server.ts`, `scripts/generate-hologram-female-face-gltf.mjs` | Keine Script-/Code-Referenzen                               | Löschen oder nach `docs/legacy/` verschieben  |

Nicht löschen trotz knip (dynamisch geladen):

- `scripts/external-skill-host.mjs`
- `public/vendor/headaudio/headworklet.mjs`

## Abschnitt C: Dupes -> Single Source

| Dupe                                                                | Ort                                                                                                                                             | neue Quelle                                                           | Schritte                                                                            |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `parseLimit` (3x identisch)                                         | `app/api/ops/agents/route.ts`, `app/api/ops/instances/route.ts`, `app/api/ops/sessions/route.ts`                                                | `app/api/ops/_shared/query.ts`                                        | Shared `parseClampedInt()` einführen, lokale Funktionen löschen, 3 Routen umstellen |
| `/api/config` Fetch/PUT-Logik doppelt                               | `src/components/config/hooks/useConfig.ts`, `src/components/profile/hooks/useProfile.ts`                                                        | `src/components/config/apiClient.ts`                                  | `loadConfig/saveConfig` zentralisieren, Hooks auf View-State reduzieren             |
| Agent-Room-Flag Parsing doppelt                                     | `src/components/Sidebar.tsx`, `src/modules/app-shell/components/AppShellViewContent.tsx`, `src/modules/agent-room/hooks/useAgentRoomRuntime.ts` | `src/modules/agent-room/featureFlags.ts`                              | `isAgentRoomEnabled()` zentralisieren                                               |
| ModelHub DTOs doppelt (`FetchedModel`, `RateLimit*`)                | `src/components/model-hub/types.ts`, `src/server/model-hub/Models/types.ts`                                                                     | `src/shared/contracts/modelHub.ts` (+ optional `shared/rateLimit.ts`) | Shared Typen exportieren, Client/Server-Typen als Re-Exports                        |
| Compat-Wrapper-Pfade (`components/ModelHub`, `stats/PromptLogsTab`) | Wrapper unter `src/components/*`                                                                                                                | Direkte Modulpfade                                                    | Imports migrieren, Wrapper löschen, testspezifische String-Assertions anpassen      |

## Abschnitt D: Simplification Items (priorisiert)

1. `[A]` Rooms-Feature komplett entfernen (`src/modules/rooms/**`, `useRoomManagement`)  
   Aufwand/Risiko: `M / Med`  
   Effekt: ca. `-1200 LOC`, weniger tote API-Calls.

2. `[A]` Legacy Voice Hook löschen (`src/modules/master/hooks/useVoiceAgent.ts`)  
   Aufwand/Risiko: `S / Low`  
   Effekt: ca. `-476 LOC`.

3. `[A]` Unerreichbaren Onboarding-Zweig entfernen (`App.tsx` + `TerminalWizard.tsx`)  
   Aufwand/Risiko: `S / Low`  
   Effekt: ca. `-110 LOC`.

4. `[A/D]` Mission-Control-Store entschlacken (`src/lib/store.ts`)  
   Aufwand/Risiko: `S / Low`  
   Effekt: `-30..60 LOC`, weniger unnötige Store-Fläche.

5. `[A]` Dead Wrapper/Barrels + tote Hooks löschen (`useExport`, `usePagination`, ungenutzte `index.ts`)  
   Aufwand/Risiko: `M / Med`  
   Effekt: `-150..300 LOC`.

6. `[B]` `parseLimit`-Duplikate konsolidieren (`app/api/ops/*`)  
   Aufwand/Risiko: `S / Low`  
   Effekt: eine Quelle der Wahrheit.

7. `[B]` Config-Client zentralisieren (`useConfig` + `useProfile`)  
   Aufwand/Risiko: `M / Med`  
   Effekt: weniger doppelte Error-/Parsing-Logik.

8. `[C]` Unused Dev-Dependencies entfernen (`package.json`)  
   Aufwand/Risiko: `S / Low`  
   Effekt: kleinere Dependency-Fläche.

9. `[D]` Exportfläche von Message-Service-Compat reduzieren (`src/server/channels/messages/service.ts`)  
   Aufwand/Risiko: `S / Low`  
   Effekt: kleinere API-Oberfläche.

10. `[E]` Stats-Overfetch beim Logs-Tab eliminieren (`src/components/stats/StatsView.tsx`)  
    Aufwand/Risiko: `S / Low`  
    Effekt: weniger Requests.

11. `[E]` ModelHub-Doppelrequest reduzieren (`usePipeline.ts`, `app/api/model-hub/pipeline/route.ts`)  
    Aufwand/Risiko: `M / Med`  
    Effekt: weniger Netzwerkrunden beim Initialload.

12. `[E]` Unnötige Client-Boundaries reduzieren (z. B. reine Wrapper-Dateien mit `'use client'`)  
    Aufwand/Risiko: `S / Low`  
    Effekt: kleinerer Client-Graph.

## Abschnitt E: Top-5 Patches (Diff-Style)

### 1) Dead Onboarding entfernen

```diff
diff --git a/src/modules/app-shell/App.tsx b/src/modules/app-shell/App.tsx
@@
-import dynamic from 'next/dynamic';
@@
-const TerminalWizard = dynamic(() => import('@/components/TerminalWizard'));
@@
-  const [onboarded, setOnboarded] = useState<boolean>(true);
@@
-  if (!onboarded) {
-    return <TerminalWizard onComplete={() => setOnboarded(true)} />;
-  }
```

### 2) Mission-Control-Store von unbenutzten Slices befreien

```diff
diff --git a/src/lib/store.ts b/src/lib/store.ts
@@
-interface MissionControlState {
-  conversations: Conversation[];
-  currentConversation: Conversation | null;
-  messages: Message[];
-  openclawMessages: Message[];
-  selectedBusiness: string;
-  setConversations: (conversations: Conversation[]) => void;
-  setCurrentConversation: (conversation: Conversation | null) => void;
-  setMessages: (messages: Message[]) => void;
-  setSelectedBusiness: (business: string) => void;
-  setOpenclawMessages: (messages: Message[]) => void;
-  addOpenclawMessage: (message: Message) => void;
-}
+interface MissionControlState {
+  // nur genutzte Felder/Aktionen behalten
+}
```

### 3) Orphaned Rooms-Feature entfernen

```diff
diff --git a/src/components/personas/hooks/index.ts b/src/components/personas/hooks/index.ts
@@
-export { useRoomManagement } from '@/components/personas/hooks/useRoomManagement';
```

Zusätzlich löschen:

- `src/components/personas/hooks/useRoomManagement.ts`
- `src/modules/rooms/**`

### 4) Stats-Overfetch im Logs-Tab stoppen

```diff
diff --git a/src/components/stats/StatsView.tsx b/src/components/stats/StatsView.tsx
@@
   const fetchStats = useCallback(async () => {
+    if (activeTab === 'logs') {
+      return;
+    }
@@
   useEffect(() => {
+    if (activeTab === 'logs') {
+      setLoading(false);
+      setError(null);
+      return;
+    }
     void fetchStats();
     return () => {
       abortRef.current?.abort();
     };
-  }, [fetchStats]);
+  }, [activeTab, fetchStats]);
```

### 5) parseLimit in OPS-Routen zusammenführen

```diff
diff --git a/app/api/ops/_shared/query.ts b/app/api/ops/_shared/query.ts
+export function parseClampedInt(
+  request: Request,
+  key: string,
+  fallback: number,
+  min: number,
+  max: number,
+): number {
+  const raw = new URL(request.url).searchParams.get(key);
+  if (raw === null) return fallback;
+  const parsed = Number.parseInt(raw, 10);
+  if (!Number.isFinite(parsed)) return fallback;
+  return Math.min(Math.max(parsed, min), max);
+}
diff --git a/app/api/ops/agents/route.ts b/app/api/ops/agents/route.ts
@@
-function parseLimit(request: Request): number { ... }
+import { parseClampedInt } from '../_shared/query';
@@
-const limit = parseLimit(request);
+const limit = parseClampedInt(request, 'limit', DEFAULT_LIMIT, MIN_LIMIT, MAX_LIMIT);
```
