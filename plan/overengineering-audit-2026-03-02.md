# Next.js Overengineering Audit (Planungsgrundlage)

Stand: 2026-03-02
Scope: `app/**`, `src/**` (App Router + TypeScript + React)

## Abschnitt A: Architektur-Skizze

- Routing läuft ausschließlich über den App Router (`app/**`); kein `pages/`-Router vorhanden.
- UI ist in modulare Domains geschnitten (`src/modules/*`), zusätzlich existieren ältere Querschnitts-Komponenten unter `src/components/*`.
- API-Layer liegt in `app/api/**` mit vielen Route-Handlern pro Feature (Tasks, Memory, Model Hub, Personas, Channels, Ops).
- Serverseitige Fachlogik sitzt in `src/server/**` (Repositories, Orchestrierung, Channel-/Task-/Memory-Services).
- Datenzugriffe sind überwiegend repository-/service-basiert (SQLite + Feature-Repositories).
- State-Management ist primär Hook-/Context-getrieben (kein dominanter globaler Redux-Store sichtbar).
- Viele Client-Seiten nutzen große Controller-Hooks (z. B. Agent Room, Master, Planning, Model Hub).
- Der App-Shell-Bereich lädt Views teils dynamisch (Split-Potential genutzt, aber nicht überall konsistent).
- Auth in API-Routen wird häufig lokal wiederholt (`resolveRequestUserContext` + 401-Response).
- DTOs/Response-Typen sind teilweise UI-seitig dupliziert statt zentralisiert.
- Task- und Memory-Flows enthalten mehrere dicke Route-Dateien mit gemischten Verantwortlichkeiten.
- In mehreren Bereichen existiert weiterhin Monolith-Charakter trotz vorheriger Modularisierung.

## Abschnitt B: Findings (priorisiert)

### 1) God-Function im Inbound-Message-Flow

- **Pfad:** `src/server/channels/messages/service/inbound/handleInbound.ts` (`handleInboundMessage`)
- **Warum unnötig komplex:** Eine einzelne Funktion orchestriert Parsing, Sicherheits-/Policy-Checks, Dispatch, Eventing und Fehlerbehandlung in einem Stück.
- **Risiko/Cost:** Hohe Änderungsrisiken (Regressionen), schwer isoliert testbar, Onboarding-Kosten steigen.
- **Vereinfachung:** Pipeline in Stage-Module schneiden (`parse -> guard -> enrich -> dispatch -> persist -> emit`).
- **Schritte:**
  1. `InboundContext`-Typ zentralisieren.
  2. Reine Stage-Funktionen in `inbound/stages/*` auslagern.
  3. Hauptfunktion auf linearen Orchestrator reduzieren.
  4. Stage-Contract-Tests ergänzen.

### 2) Überladene Memory-API mit 5 Verben + lokaler Validierung

- **Pfad:** `app/api/memory/route.ts` (`GET/POST/PUT/PATCH/DELETE`, lokale Parser/`ValidationError`)
- **Warum unnötig komplex:** Viele HTTP-Aktionen, Parsing-Helfer und Fehler-Mapping in einer Datei; zu viel lokaler Boilerplate.
- **Risiko/Cost:** Höhere Defect-Rate bei Änderungen, inkonsistente Validation über Endpunkte.
- **Vereinfachung:** Pro Verb Feature-Handler auslagern und Schemas zentralisieren (z. B. Zod + gemeinsamer `withUserContext`).
- **Schritte:**
  1. `memory/schemas.ts` anlegen.
  2. Handler in `memory/handlers/{get,post,put,patch,delete}.ts` splitten.
  3. Einheitliches Error-Mapping (`badRequest`, `unauthorized`, `internal`) einführen.
  4. Route-Datei als dünner Router belassen.

### 3) Test-Route mit Playwright/CSS-Validation/Workflow-Mutationen kombiniert

- **Pfad:** `app/api/tasks/[id]/test/route.ts` (`POST`, `validateCss`, Workflow-Statuslogik)
- **Warum unnötig komplex:** Heavy-Testing, Parsing, Status-Mutationen und Reporting laufen synchron in einem Route-Handler.
- **Risiko/Cost:** Lange Request-Laufzeiten, Timeouts, schweres Retry-/Fehlerverhalten, hoher Maintenance-Aufwand.
- **Vereinfachung:** Asynchronen Job-Flow verwenden (`enqueue test job`), Route liefert nur Job-ID.
- **Schritte:**
  1. Test-Execution in Worker-Service auslagern.
  2. Route auf Input-Validierung + Job-Erstellung reduzieren.
  3. Polling/Webhook-Status separat lesen.
  4. CSS-Validation als eigenständiges Modul mit Unit-Tests halten.

### 4) `useSwarmActions` ist ein God-Hook

- **Pfad:** `src/modules/agent-room/hooks/useSwarmActions.ts` (`useSwarmActions`)
- **Warum unnötig komplex:** Hook bündelt Catalog-Load, CRUD, Lifecycle-Actions, Event-Reaktionen und UI-Nebenwirkungen.
- **Risiko/Cost:** Viele Re-Renders, schweres Mocking, hohe Kopplung zwischen UI und API-Details.
- **Vereinfachung:** In spezialisierte Hooks splitten (`useSwarmCatalog`, `useSwarmMutations`, `useSwarmLifecycle`, `useSwarmEvents`).
- **Schritte:**
  1. API-Client-Funktionen isolieren.
  2. Je Hook nur eine Verantwortung.
  3. `useSwarmActions` als optionale Facade (kompatibel) belassen.
  4. Contracts pro Hook testen.

### 5) Rendering/Input/Runtime im Canvas-Monolith vermischt

- **Pfad:** `src/modules/master/components/MasterFaceCanvasThree.tsx`
- **Warum unnötig komplex:** UI-Rendering, Audio/Voice, Interaktionszustand und Three.js-spezifische Logik sind eng verflochten.
- **Risiko/Cost:** Bundle/Render-Kosten, hohe Fehlersensitivität bei Feature-Erweiterungen.
- **Vereinfachung:** Container/View trennen + spezialisierte Hooks für Animation/Audio/Input.
- **Schritte:**
  1. `useFaceAnimation`, `useFaceAudioBridge`, `useFaceInteraction` extrahieren.
  2. Presentational-Komponenten unter `components/canvas/*` splitten.
  3. Teure Teile lazy laden.

### 6) Fragiles Monkey-Patching im Model-Hub-Hook

- **Pfad:** `src/components/model-hub/hooks/useModelHub.ts` (`handleRunConnectionProbe` überschreibt temporär `providers.setProbeResult`)
- **Warum unnötig komplex:** Temporäres Überschreiben von Funktionsreferenzen ist implizit und fehleranfällig.
- **Risiko/Cost:** Race-Conditions, schwer nachvollziehbares Verhalten bei parallelen Probes.
- **Vereinfachung:** Explizites Probe-Result-Event oder Rückgabewertmodell statt Funktionspatching.
- **Schritte:**
  1. `runConnectionProbe` soll strukturiertes Resultat zurückgeben.
  2. Session-Stats rein auf Resultat ableiten.
  3. Mutierende Hook-Overrides entfernen.

### 7) Duplizierte Task-Hydration in zwei Task-Routen

- **Pfad:** `app/api/tasks/route.ts` + `app/api/tasks/[id]/route.ts` (`hydrateTaskRelations`)
- **Warum unnötig komplex:** Gleiche Mapping-Logik in zwei Dateien erzeugt Drift-Risiko.
- **Risiko/Cost:** Inkompatible API-Antworten nach Änderungen.
- **Vereinfachung:** Gemeinsame `taskHydration.ts` im Server-Layer.
- **Schritte:**
  1. `src/server/tasks/taskHydration.ts` extrahieren.
  2. Beide Routen auf shared Mapper umstellen.
  3. Snapshot/Contract-Test für Response-Konsistenz ergänzen.

### 8) Auth-Boilerplate in API-Routen wiederholt

- **Pfad:** verteilt in `app/api/**` (viele Vorkommen von `resolveRequestUserContext` + `Unauthorized`)
- **Warum unnötig komplex:** Quasi identischer Vorbau in Dutzenden Routen.
- **Risiko/Cost:** Inkonsistente 401-Formate und unnötige Wartungskosten.
- **Vereinfachung:** HOF-Wrapper `withUserContext(handler)`.
- **Schritte:**
  1. `app/api/_shared/withUserContext.ts` einführen.
  2. 5-10 kritische Routen zuerst migrieren.
  3. Danach übergreifend umstellen.

### 9) Kleine Utility-Duplikate (`parsePositiveInt`) in mehreren Layern

- **Pfad:** `app/api/memory/route.ts`, `app/api/knowledge/graph/route.ts`, `app/api/debug/conversations/[id]/turns/route.ts`, `src/components/profile/utils/profileHelpers.ts`
- **Warum unnötig komplex:** Derselbe Parser in Varianten verteilt.
- **Risiko/Cost:** Inkonsistentes Validierungsverhalten.
- **Vereinfachung:** Shared Parsing-Utilities je Layer (`server/http/params.ts`, `ui/number.ts`).
- **Schritte:**
  1. Utility zentralisieren.
  2. Altnutzungen ersetzen.
  3. Edge-Case-Tests an einer Stelle pflegen.

### 10) Unnötiges `use client` in reinen Type-Dateien

- **Pfad:** `src/components/stats/prompt-logs/types.ts`, `src/components/profile/types.ts`, `src/components/personas/editor/types.ts`
- **Warum unnötig komplex:** Reine Typdateien brauchen keine Client-Boundary.
- **Risiko/Cost:** Unnötige Client-Transitivität/Bundle-Signaling.
- **Vereinfachung:** `use client` aus Typdateien entfernen.
- **Schritte:**
  1. Direktiven entfernen.
  2. Importgraph kurz prüfen.
  3. Build/Typecheck verifizieren.

### 11) Dispatch-Route mit zu vielen Verantwortlichkeiten

- **Pfad:** `app/api/tasks/[id]/dispatch/route.ts`
- **Warum unnötig komplex:** Session-Ensure, Retry, Skill-Prüfung, Statuswechsel, Event-/Activity-Logging in einem Handler.
- **Risiko/Cost:** Fehlerbehandlung wird unübersichtlich; Änderungen brechen leicht Nebenpfade.
- **Vereinfachung:** Use-Case-Services (`prepareDispatch`, `executeDispatch`, `finalizeDispatch`).
- **Schritte:**
  1. Transaktionale Statuswechsel kapseln.
  2. Retry-Policy zentralisieren.
  3. Route auf Orchestrierung reduzieren.

### 12) Verbleibende Compat-/Reexport-Wrapper ohne aktiven Nutzen

- **Pfad:** `src/server/knowledge/retrieval/service.ts` (deprecated Reexport)
- **Warum unnötig komplex:** Zusätzliche Schicht ohne aktuellen Import-Nutzen.
- **Risiko/Cost:** Mehr Pfadoberfläche, unklare „source of truth“.
- **Vereinfachung:** Wrapper entfernen, nur modulare Service-API beibehalten.
- **Schritte:**
  1. Rest-Imports aufspüren (derzeit keine Treffer).
  2. Datei löschen.
  3. Typecheck + Tests laufen lassen.

## Quick Wins (<= 1 Stunde)

- `use client` aus reinen Typdateien entfernen.
- `ConfigResponse` duplizierten Typ konsolidieren (`src/components/config/types.ts` + `src/components/profile/types.ts`).
- `parsePositiveInt` auf 1 Shared-Implementierung pro Layer konsolidieren.
- `hydrateTaskRelations` extrahieren und in beiden Task-Routen verwenden.
- `withUserContext` als Shared-Helfer anlegen und zuerst 3-5 Routen migrieren.

## Größere Refactors (>= 1 Tag)

- `handleInboundMessage` in Stage-Pipeline schneiden.
- `app/api/memory/route.ts` in modulare Handler + zentrale Schemas splitten.
- `app/api/tasks/[id]/test/route.ts` auf asynchronen Job-Flow umbauen.
- `useSwarmActions` in mehrere Domain-Hooks aufteilen.
- `MasterFaceCanvasThree.tsx` in Controller/Hooks/View-Teile zerlegen.
- `app/api/tasks/[id]/dispatch/route.ts` in Use-Case-Module mit klaren Transaktionsgrenzen auslagern.

## Zusatzaufgaben: Inventar

### Top-5 größte Dateien (LOC)

| Rang | Datei                                                           | LOC |
| ---- | --------------------------------------------------------------- | --: |
| 1    | `src/modules/master/components/MasterFaceCanvasThree.tsx`       | 561 |
| 2    | `app/api/tasks/[id]/test/route.ts`                              | 522 |
| 3    | `app/api/memory/route.ts`                                       | 520 |
| 4    | `src/modules/agent-room/hooks/useSwarmActions.ts`               | 502 |
| 5    | `src/server/channels/messages/service/inbound/handleInbound.ts` | 497 |

### Komponenten > 200 LOC (vollständige Liste)

```text
561  src/modules/master/components/MasterFaceCanvasThree.tsx
454  src/components/model-hub/sections/PipelineSection.tsx
431  src/components/TaskModal.tsx
423  src/components/knowledge/graph/KnowledgeGraphPanel.tsx
422  src/modules/master/components/MasterEntryPage.tsx
414  src/modules/rooms/components/RoomDetailPanel.tsx
414  src/modules/ops/components/AgentsView.tsx
412  src/modules/ops/components/NodesView.tsx
410  src/modules/master/components/MasterFaceCanvas.tsx
405  src/modules/master/components/RunList.tsx
396  src/modules/master/components/MasterView.tsx
379  src/modules/chat/components/ChatMainPane.tsx
376  src/modules/agent-room/components/layout/AgentRoomDetailPage.tsx
374  src/modules/agent-room/components/NewSwarmModal.tsx
372  src/modules/ops/components/InstancesView.tsx
371  src/components/AgentModal.tsx
360  src/components/AgentsSidebar.tsx
358  src/components/WorkspaceDashboard.tsx
351  src/components/planning/PlanningTabView.tsx
338  src/modules/app-shell/App.tsx
332  src/components/SecurityView.tsx
317  src/modules/tasks/task-manager/TaskManagerView.tsx
315  src/modules/app-shell/components/AppShellViewContent.tsx
310  src/components/DiscoverAgentsModal.tsx
310  src/components/stats/OverviewTabContent.tsx
289  src/modules/conversation-debugger/ConversationDebuggerView.tsx
282  src/modules/agent-room/components/AgentRoomView.tsx
266  src/components/ErrorBoundary.tsx
262  src/components/MissionQueue.tsx
258  src/components/model-hub/modals/AddModelModal.tsx
253  src/components/PersonasView.tsx
250  app/mission-control/settings/page.tsx
249  src/modules/conversation-debugger/components/ReplayModal.tsx
249  src/components/model-hub/sections/SidebarSection.tsx
243  src/modules/conversation-debugger/components/ui-helpers.tsx
237  src/modules/agent-room/components/InlineMarkdown.tsx
236  src/modules/cron/components/CronRuleForm.tsx
235  src/modules/agent-room/components/sidebar/SwarmSidebar.tsx
235  src/messenger/telegram/TelegramHandler.tsx
233  src/modules/agent-room/components/SwarmChatFeed.tsx
228  src/components/model-hub/components/AddProviderModal.tsx
227  src/messenger/shared/GenericChannelHandler.tsx
226  src/modules/rooms/components/CreateRoomModal.tsx
225  src/modules/personas/PersonaContext.tsx
223  src/skills/SkillsRegistry.tsx
223  src/modules/conversation-debugger/components/TurnDetailPanel.tsx
222  src/components/MemoryView.tsx
221  src/components/Dashboard.tsx
220  src/modules/agent-room/components/UserChatInput.tsx
219  src/components/DeliverablesList.tsx
214  src/modules/chat/components/ChatInputArea.tsx
213  src/modules/agent-room/components/layout/AgentRoomEntryPage.tsx
212  app/mission-control/workspace/[slug]/page.tsx
210  src/modules/cron/components/CronRuleTable.tsx
209  src/components/Sidebar.tsx
209  src/components/SessionsList.tsx
208  src/components/logs/components/DiagnosticsPanel.tsx
207  src/modules/ops/components/SessionsView.tsx
205  src/components/model-hub/ModelHub.tsx
203  src/modules/master/components/CreateRunForm.tsx
201  src/modules/master/components/RunControls.tsx
201  src/components/logs/components/LogsToolbar.tsx
```

### Split-Hinweise für >200-Komponenten (cluster-basiert)

- `master/*`: Rendering, Controls, Data-Fetch, Runtime-Actions strikt trennen (Container/View + Hooks).
- `agent-room/*`: Catalog/Selection, Chat-Feed, Action-Toolbar, Modals in getrennte Teilkomponenten + Hooks.
- `ops/*`: Tabellen-View generisch machen (`EntityTable` + spalten-/action-config), statt pro Entität Vollkopien.
- `model-hub/*`: Probe/Provider/Pipeline-Bereiche konsequent in Section-Controller splitten.
- `conversation-debugger/*`: Replay-Engine, Turn-Inspector, Filter/Navigation entkoppeln.

### Custom Hooks > 80 LOC (vollständige Liste)

```text
502  src/modules/agent-room/hooks/useSwarmActions.ts
487  src/modules/cron/hooks/useCronRules.ts
476  src/modules/master/hooks/useVoiceAgent.ts
459  src/modules/master/hooks/useMasterView.ts
423  src/messenger/channel-pairing/useChannelPairingController.ts
403  src/components/planning/usePlanningTabController.ts
393  src/components/model-hub/hooks/useModelHub.ts
386  src/components/model-hub/hooks/useProviders.ts
352  src/modules/agent-room/hooks/useSwarmMessages.ts
340  src/modules/master/voice/grok/useGrokVoiceAgent.ts
323  src/components/logs/hooks/useLogs.ts
301  src/modules/chat/hooks/useChatInterfaceState.ts
279  src/modules/app-shell/useAgentRuntime.ts
271  src/components/config/hooks/useConfig.ts
268  src/components/personas/hooks/useRoomManagement.ts
250  src/modules/ops/hooks/useOpsSessions.ts
231  src/modules/conversation-debugger/useConversationDebugger.ts
229  src/components/memory/hooks/useMemoryEdit.ts
220  src/modules/agent-room/components/UserChatInput.tsx
207  src/skills/hooks/useClawHub.ts
203  src/skills/hooks/useSkillActions.ts
199  src/modules/app-shell/useConversationSync.ts
196  src/components/stats/prompt-logs/hooks/usePromptLogs.ts
193  src/server/auth/userStore.ts
188  src/modules/agent-room/hooks/useAgentRoomRuntime.ts
180  src/components/profile/hooks/useProfile.ts
165  src/modules/ops/hooks/useOpsNodes.ts
165  src/components/model-hub/hooks/usePipeline.ts
154  src/components/logs/hooks/useDiagnostics.ts
151  src/hooks/useSSE.ts
151  src/modules/flow-builder/useFlowEditor.ts
145  src/modules/app-shell/useChatMessageActions.ts
136  src/components/memory/hooks/useHistory.ts
126  src/modules/app-shell/useConversationActions.ts
126  src/components/memory/hooks/useBulkOperations.ts
122  src/components/memory/hooks/useMemory.ts
121  src/modules/agent-room/hooks/useSwarmConnection.ts
109  src/skills/hooks/useRuntimeConfigs.ts
108  src/modules/app-shell/useChannelStateSync.ts
106  src/components/personas/hooks/usePersonaCRUD.ts
106  src/modules/agent-room/hooks/useSwarmExport.ts
104  src/modules/rooms/useRoomSync.ts
103  src/modules/gateway/useGatewayConnection.ts
103  src/modules/tasks/task-manager/useTaskCatalog.ts
96   src/components/personas/hooks/usePersonaSelection.ts
88   src/components/knowledge/hooks/useKnowledgeGraph.ts
```

### Hooks mit zu breiter Verantwortung (priorisiert)

- `useSwarmActions`, `useMasterView`, `useVoiceAgent`, `useModelHub`, `useProviders`, `usePlanningTabController`, `useLogs`.
- Zielbild: je Hook maximal eine Kernverantwortung (Datenzugriff, Orchestrierung oder UI-State).

### Doppelte Datenmodelle/DTOs/Schemas

- `ConfigResponse` doppelt:
  - `src/components/config/types.ts`
  - `src/components/profile/types.ts`
- Task-Hydration (`hydrateTaskRelations`) doppelt:
  - `app/api/tasks/route.ts`
  - `app/api/tasks/[id]/route.ts`
- Parser-Duplikat `parsePositiveInt` mehrfach:
  - `app/api/memory/route.ts`
  - `app/api/knowledge/graph/route.ts`
  - `app/api/debug/conversations/[id]/turns/route.ts`
  - `src/components/profile/utils/profileHelpers.ts`

## Abschnitt C: Top-10 Hebel

| Maßnahme                                                       | Aufwand | Nutzen  | Risiko |
| -------------------------------------------------------------- | ------- | ------- | ------ |
| `handleInboundMessage` in Stage-Pipeline splitten              | L       | High    | Med    |
| Memory-Route in Handler + Schemas aufteilen                    | L       | High    | Med    |
| Task-Test-Route auf Job/Worker-Modell umbauen                  | L       | High    | Med    |
| `useSwarmActions` in Domain-Hooks zerlegen                     | M       | High    | Med    |
| `MasterFaceCanvasThree` in Container/Hooks/View splitten       | L       | High    | Med    |
| Dispatch-Route (`/tasks/[id]/dispatch`) in Use-Cases schneiden | L       | High    | Med    |
| `withUserContext` für API-Auth-Boilerplate einführen           | M       | High    | Low    |
| Task-Hydration deduplizieren                                   | S       | Med     | Low    |
| `parsePositiveInt` und kleine Parser zentralisieren            | S       | Med     | Low    |
| `use client` aus reinen Typdateien entfernen                   | S       | Low-Med | Low    |

## Abschnitt D: Stop-doing-Liste

- Keine neuen 400+ LOC Route-Handler mehr ohne Modulgrenzen.
- Keine God-Hooks, die API, UI-State und Event-Reaktion zugleich enthalten.
- Keine Duplikation von DTO-/Mapper-Logik zwischen benachbarten Routen.
- Kein Monkey-Patching von Hook-APIs (Funktionsreferenzen temporär überschreiben).
- Keine lokalen Parse-/Validation-Helfer kopieren, wenn Shared-Utilities möglich sind.
- Keine `use client`-Direktiven in reinen `types.ts`-/Konstanten-Dateien.
- Keine neuen Compat-Reexport-Dateien ohne klaren Migrationsplan mit Sunset-Datum.
- Keine Status-/Event-/DB-Mutationen quer im Handler verteilen; transaktional kapseln.
- Keine Copy-Paste-Views für ähnliche Tabellen/Listen (Ops/Agent/Node/Session), stattdessen konfigurierbare generische Views.
- Keine impliziten Netzwerk-/Workflow-Seitenwirkungen in UI-Komponenten ohne explizite Orchestrator-Schicht.
