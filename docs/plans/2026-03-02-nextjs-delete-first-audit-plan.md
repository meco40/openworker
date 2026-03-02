# Next.js Delete-First Refactor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Ist-Validiert am:** 2026-03-02T23:25:29+01:00 (`main@a164be3`)
**Implementiert am:** 2026-03-03T00:03:46+01:00 (lokaler Arbeitsstand)
**Status:** ✅ Abgeschlossen (alle 10 Simplification-Items umgesetzt)

**Goal:** Unnötigen Code im Next.js-Stack systematisch löschen und Datenfluss/Fetching vereinfachen, ohne Funktionsverlust.

**Architecture:** Delete-first Vorgehen mit Priorität auf Entfernen statt Umorganisieren. Jede Maßnahme muss mindestens eines der Ziele A-E erfüllen (Delete, SSOT, Dependency-Reduktion, State-Flow-Vereinfachung, Render-/Fetch-Overhead-Reduktion). Änderungen erfolgen in kleinen, verifizierbaren Schritten.

**Tech Stack:** Next.js App Router, TypeScript, React, Zustand, fetch-basierte API-Routen.

---

## Abschnitt A: Kern-Flows

- `Core` Einstieg und Auth: `/` ([app/page.tsx](../../app/page.tsx)), `/login` ([app/login/page.tsx](../../app/login/page.tsx)), NextAuth Route.
- `Core` App-Shell Navigation: [src/modules/app-shell/App.tsx](../../src/modules/app-shell/App.tsx), [src/modules/app-shell/components/AppShellViewContent.tsx](../../src/modules/app-shell/components/AppShellViewContent.tsx).
- `Core` Chat/Conversations: WS `chat.stream`, `/api/channels/messages`, `/api/channels/conversations`.
- `Core` Personas: `/api/personas`, `/api/personas/[id]`, Persona-Editor-Flow.
- `Core` Model-Hub: `/api/model-hub/providers|accounts|pipeline`, `src/components/model-hub/hooks/*`.
- `Core` Ops: `/api/ops/instances|sessions|nodes|agents` + `useOps*` Hooks.
- `Core` Stats/Logs: `/api/stats`, `/api/stats/prompt-logs`, `StatsView`.
- `Optional` Mission-Control Subapp: `/mission-control*`, Zustand-Store.
- `Optional` Debug/Experimente: Conversation Debugger, Agent Room, Master.

## Abschnitt B: Delete List

| Pfad/Export                                                                   | Warum Kandidat?                         | Entfernen wie?                                                             |
| ----------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------- |
| `src/lib/events.ts#getActiveConnectionCount`                                  | Keine produktiven Import-Treffer        | Export/Funktion löschen                                                    |
| `src/logging/logService.ts#logFromSystemEvent`                                | Produktiv genutzt in `/api/logs/ingest` | **Nicht löschen** (aus Delete-List ausnehmen)                              |
| `src/server/skills/runtimeConfig.ts#getRuntimeConfigCatalog`                  | Keine produktiven Import-Treffer        | Export/Funktion löschen                                                    |
| `src/server/agents/subagentRegistry.ts#getSubagentRun`                        | Keine produktiven Import-Treffer        | Export/Funktion löschen                                                    |
| `src/server/channels/telegram/modelSelection.ts#resolveActivePipelineEntries` | Keine produktiven Import-Treffer        | Export/Funktion löschen                                                    |
| `src/lib/persona-templates.ts#getPersonaTemplate`                             | Keine produktiven Import-Treffer        | Export/Funktion löschen                                                    |
| `src/services/gateway.ts#LIVE_MODE_SUPPORTED`                                 | Keine produktiven Import-Treffer        | Konstante löschen                                                          |
| `src/services/gateway.ts#SYSTEM_INSTRUCTION`                                  | Keine produktiven Import-Treffer        | Konstante/Export löschen                                                   |
| `src/lib/config.ts#expandPath`                                                | Keine produktiven Import-Treffer        | Funktion löschen                                                           |
| `src/lib/config.ts#getWorkspaceBasePath`                                      | Keine produktiven Import-Treffer        | Funktion löschen                                                           |
| `src/lib/config.ts#getProjectPath`                                            | Keine produktiven Import-Treffer        | Funktion löschen                                                           |
| `src/modules/config/components/ConfigEditor.tsx`                              | Reiner Pass-through Wrapper             | Importe auf `@/components/ConfigEditor`, Datei löschen                     |
| `src/modules/exposure/components/ExposureManager.tsx`                         | Reiner Pass-through Wrapper             | Importe auf `@/components/ExposureManager`, Datei löschen                  |
| `src/modules/telemetry/components/LogsView.tsx`                               | Reiner Pass-through Wrapper             | Importe auf `@/components/LogsView`, Datei löschen                         |
| `src/components/personas/PersonaEditorPane.tsx`                               | Reiner Backward-Compat Re-export        | Import auf `@/components/personas/editor/PersonaEditorPane`, Datei löschen |

## Abschnitt C: Dupes -> Single Source

| Dupe                         | Ort                                                                     | Neue Quelle                           | Schritte                                           |
| ---------------------------- | ----------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------- |
| `readJson` + Error Handling  | `useOpsAgents`, `useOpsInstances`, `useOpsNodes`, `useOpsSessions`      | `src/modules/ops/hooks/http.ts`       | Shared Helper anlegen, lokale Duplikate entfernen  |
| Query-Int Parsing            | `app/api/ops/nodes/route.ts` + `app/api/ops/_shared/query.ts`           | `parseClampedInt`                     | `parseChannelLimit` löschen, Shared Helper nutzen  |
| `formatDateTime` Helfer      | Ops-Views + PromptLogsTab                                               | `src/shared/lib/dateFormat.ts`        | Formatter zentralisieren, lokale Varianten löschen |
| Pipeline DTO Typen           | `src/components/personas/hooks/usePipelineModels.ts` vs Model-Hub Typen | `@/components/model-hub/types`        | Lokales Interface entfernen, Typ importieren       |
| Persona Settings Update Flow | doppelte PUT-Logik in `PersonasView`                                    | lokaler `updatePersonaSetting` Helper | 2 Codepfade zusammenführen                         |

## Abschnitt D: Simplification Items (priorisiert)

1. `A` Dead Exports löschen (nur ohne produktive Nutzung). Aufwand: `S`, Risiko: `Low`, Effekt: kleinere API-Oberfläche, weniger LOC.
2. `A+C` Pass-through Wrapper (`config/exposure/telemetry`) entfernen. Aufwand: `S`, Risiko: `Low`, Effekt: weniger Indirection.
3. `A+C` PersonaEditorPane Compat entfernen. Aufwand: `S`, Risiko: `Low`, Effekt: klarerer Importgraph.
4. `B+D` `parseChannelLimit` Duplikat entfernen. Aufwand: `S`, Risiko: `Low`, Effekt: 1 Query-Parsing-Quelle.
5. `B+D+E` Ops-Hooks auf Shared HTTP-Helper konsolidieren. Aufwand: `M`, Risiko: `Low-Med`, Effekt: deutlich weniger Duplikate.
6. `D+E` Refresh-Flow in Ops-Hooks stabilisieren (keine `loading`-abhängige Callback-Neuerstellung). Aufwand: `S`, Risiko: `Low`, Effekt: weniger Effekt-Churn.
7. `B+D` DateTime-Formatter zentralisieren. Aufwand: `M`, Risiko: `Low`, Effekt: konsistente UI-Ausgabe, weniger LOC.
8. `D` Triviale `useMemo`s in PromptLogsTab entfernen. Aufwand: `S`, Risiko: `Low`, Effekt: weniger Hook-Komplexität.
9. `D` Persona-Update-Flow vereinfachen. Aufwand: `M`, Risiko: `Low`, Effekt: weniger duplizierte Fetch-Logik.
10. `E` `app/mission-control/page.tsx` als Server Component. Aufwand: `S`, Risiko: `Low`, Effekt: weniger Client-Overhead.

## Abschnitt D1: Umsetzungs-IST

| Item | Status | IST-Evidenz                                                                                                                                                                                                                                                                        |
| ---- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | ✅     | Dead Exports/Constants/Funktionen entfernt in `src/lib/events.ts`, `src/server/skills/runtimeConfig.ts`, `src/server/agents/subagentRegistry.ts`, `src/server/channels/telegram/modelSelection.ts`, `src/lib/persona-templates.ts`, `src/services/gateway.ts`, `src/lib/config.ts` |
| 2    | ✅     | Wrapper-Importe migriert in `src/modules/app-shell/components/AppShellViewContent.tsx`; Wrapper-Dateien gelöscht (`src/modules/config/components/ConfigEditor.tsx`, `src/modules/exposure/components/ExposureManager.tsx`, `src/modules/telemetry/components/LogsView.tsx`)        |
| 3    | ✅     | Compat-Reexport entfernt: `src/components/personas/PersonaEditorPane.tsx` gelöscht; Import auf `@/components/personas/editor/PersonaEditorPane` umgestellt                                                                                                                         |
| 4    | ✅     | `app/api/ops/nodes/route.ts` nutzt `parseClampedInt`; lokales `parseChannelLimit` entfernt                                                                                                                                                                                         |
| 5    | ✅     | Shared HTTP-Helper angelegt: `src/modules/ops/hooks/http.ts`; `useOpsAgents/useOpsInstances/useOpsNodes/useOpsSessions` darauf umgestellt                                                                                                                                          |
| 6    | ✅     | Ops-Refresh stabilisiert: `initialLoadRef` in allen vier `useOps*` Hooks, `loading` aus Callback-Dependencies entfernt                                                                                                                                                             |
| 7    | ✅     | `src/shared/lib/dateFormat.ts` eingeführt; Ops-Views + Prompt-Logs auf zentrale Formatter umgestellt                                                                                                                                                                               |
| 8    | ✅     | Triviale `useMemo`-Ableitungen in `src/components/stats/prompt-logs/PromptLogsTab.tsx` entfernt                                                                                                                                                                                    |
| 9    | ✅     | Persona-Update-Flow dedupliziert: zentraler `updatePersonaSetting`-Pfad in `src/components/PersonasView.tsx`; Pipeline-Typ auf Model-Hub-SSOT umgestellt                                                                                                                           |
| 10   | ✅     | `app/mission-control/page.tsx` ohne `'use client'` (Server Component)                                                                                                                                                                                                              |

## Abschnitt E: Top-5 Patchvorschläge

### Patch 1: Toten Export entfernen

```diff
--- a/src/lib/events.ts
+++ b/src/lib/events.ts
@@
-export function getActiveConnectionCount(): number {
-  return clients.size;
-}
```

### Patch 2: Wrapper-Importe entfernen + Dateien löschen

```diff
--- a/src/modules/app-shell/components/AppShellViewContent.tsx
+++ b/src/modules/app-shell/components/AppShellViewContent.tsx
@@
-const LogsView = dynamic(() => import('@/modules/telemetry/components/LogsView'), {
+const LogsView = dynamic(() => import('@/components/LogsView'), {
@@
-const ConfigEditor = dynamic(() => import('@/modules/config/components/ConfigEditor'), {
+const ConfigEditor = dynamic(() => import('@/components/ConfigEditor'), {
@@
-const ExposureManager = dynamic(() => import('@/modules/exposure/components/ExposureManager'), {
+const ExposureManager = dynamic(() => import('@/components/ExposureManager'), {
```

### Patch 3: PersonaEditorPane Compat entfernen

```diff
--- a/src/components/PersonasView.tsx
+++ b/src/components/PersonasView.tsx
@@
-import { PersonaEditorPane } from '@/components/personas/PersonaEditorPane';
+import { PersonaEditorPane } from '@/components/personas/editor/PersonaEditorPane';
```

### Patch 4: Nodes Query Parsing konsolidieren

```diff
--- a/app/api/ops/nodes/route.ts
+++ b/app/api/ops/nodes/route.ts
@@
+import { parseClampedInt } from '../_shared/query';
@@
-channelLimit: parseChannelLimit(request),
+channelLimit: parseClampedInt(request, 'limit', DEFAULT_CHANNEL_LIMIT, MIN_CHANNEL_LIMIT, MAX_CHANNEL_LIMIT),
```

### Patch 5: Mission Control Seite als Server Component

```diff
--- a/app/mission-control/page.tsx
+++ b/app/mission-control/page.tsx
@@
-'use client';
```

## Korrekturen zur Audit-Analyse

- `logFromSystemEvent` ist kein Dead Export, da produktiv in `app/api/logs/ingest/route.ts` importiert und aufgerufen.
- Der DTO-Dupe-Eintrag bezieht sich konkret auf `src/components/personas/hooks/usePipelineModels.ts` (nicht auf einen gleichnamigen Model-Hub-Hook).

## Verifikation nach Umsetzung

1. `npm run typecheck`
2. `npm run lint`
3. `npm test`
4. `npm run build`

### Verifiziert am 2026-03-03

- ✅ `npm run check` erfolgreich (`typecheck`/`lint`/`format:check`; lint mit bekannten Warnungen, 0 Fehler)
- ✅ `npm test` erfolgreich (`471/471` Dateien, `2094/2094` Tests)
- ✅ `npm run build` erfolgreich (Next.js Production Build grün)

## Abschlusskriterien

- Delete-List Einträge sind entfernt oder als bewusst `UNCONFIRMED` dokumentiert.
- Simplification Items 1-10 sind umgesetzt oder begründet verschoben.
- Keine Regression in typecheck/lint/tests/build.
- Änderungen sind in kleinen Commits nachvollziehbar.
