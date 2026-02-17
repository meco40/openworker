# Worker Orchestra V1 - Decision Plan

Datum: 2026-02-13  
Status: Decision Freeze (in progress)

## Ziel

V1-Architektur fuer den Worker-Orchestra-Modus festhalten, inklusive Persona-Model-Binding, Routing, Steuerung und Guardrails.

## Getroffene Entscheidungen

1. Orchestrator-Basis: Reuse der bestehenden Rooms-Orchestrator-Mechanik (kein kompletter Neubau).
2. Modus in V1: Manual first (Auto folgt spaeter).
3. Visualisierung: Full Node Graph.
4. Runtime-Steuerung: Zentraler Master-Scheduler.
5. Failure-Policy: Fail-fast.
6. Concurrency: Parallelisierung fuer unabhaengige Nodes erlaubt.
7. Persona-Model-Binding: Auf Persona-Ebene (`preferredModelId`) mit Fallback auf Default-Model.
8. Routing: Statische Kanten + optionale LLM-Entscheidung nur innerhalb erlaubter Kanten.
9. Graph-Bearbeitung in V1: Template-basiert mit begrenzten Edits.
10. Retry-Strategie in V1: Kein Retry, sofort Fail-fast.
11. UI-Informationsarchitektur:

- `Workflow` als Task-Detail-Tab (Run-Ansicht, live, read-only in V1).
- `Orchestra` als globaler Workspace-Tab (Flow-/Routing-Builder, editierbar in V1).

12. Workflow-Scope in V1: Nur aktueller Run (keine Run-Historie in V1).
13. Workflow-Darstellung in V1: Live-Graph mit Knotenstatus (statt nur linearer Ablaufansicht).

## Konkrete V1-Regeln

1. Jeder Run hat genau einen Master, der den Flow steuert.
2. Persona bestimmt standardmaessig das Model ueber `preferredModelId`.
3. Fehlt `preferredModelId`, wird das globale Default-Model aus ModelHub genutzt.
4. Routing darf nur ueber valide, vorher definierte Kanten gehen.
5. LLM-Routing darf nur aus erlaubten Next-Nodes auswaehlen.
6. Bei Node-Fehler wird der Run direkt beendet (keine Wiederholung in V1).
7. User editiert nur erlaubte Felder innerhalb von Templates.
8. Runtime-Ansicht und Konfigurations-Ansicht werden getrennt:

- Task-Ebene: `Workflow`
- Workspace-Ebene: `Orchestra`

9. `Workflow` zeigt in V1 nur den laufenden/letzten aktuellen Run und keine historische Run-Liste.
10. `Workflow` visualisiert den aktiven Run als Live-Graph (Knoten + Kanten + Status pro Knoten).
11. `Orchestra` ist in V1 editierbar, aber nur innerhalb von Template-Grenzen (keine komplett freie Topologie).

## Datenmodell (V1-Entwurf)

1. `personas.preferred_model_id` (nullable)
2. `worker_flow_templates` (vordefinierte Flows)
3. `worker_flow_drafts` (editierbare Entwuerfe)
4. `worker_flow_published` (aktive Version)
5. `worker_runs` / `worker_run_steps` (Tracing, Entscheidungen, Fehler)
6. `worker_subagent_sessions` (pro Task/Run registrierte Subagent-Session mit Status und Zeitstempeln)
7. `worker_task_activities` (strukturierte Aktivitaeten je Task/Run)
8. `worker_task_deliverables` (ausgelieferte Artefakte/Dateien/Links je Task/Run)

## Mission-Control-Transparenzschicht (V1-Ergaenzung)

Ziel: Die bestehende Worker-Engine beibehalten, aber Transparenz und Nachvollziehbarkeit auf Mission-Control-Niveau ergaenzen.

1. Subagent-Sessions sichtbar machen:

- Start/Status/Ende je Subagent pro Task-Run protokollieren.
- Parallel laufende Subagents sauber zaehlen und im UI anzeigen.

2. Aktivitaets-Protokoll standardisieren:

- Jede relevante Aktion als strukturierte Aktivitaet speichern (spawned, updated, completed, status_changed, error).
- Aktivitaeten chronologisch im Task-Detail anzeigen.

3. Deliverable-Protokoll standardisieren:

- Outputs als echte Deliverables registrieren (file/url/artifact) statt nur als freie Textzusammenfassung.
- Download-/Export-UX auf Deliverables fokussieren, nicht nur auf Plan-/Logdateien.

## Offener Punkt

Release-/Aenderungsmodell fuer Flows:

1. Draft + Publish (entschieden)
2. Sofort Live
3. Interne Versionierung ohne Publish-UI

## Umsetzung

Der vollstaendige produktionsreife Implementierungsplan (inkl. Git-Worktree-Nutzung, Teststrategie,
Rollout/Rollback, konkreter File-Liste) liegt in:

- `docs/plans/2026-02-13-worker-orchestra-v1-production-implementation-plan.md`

## Naechste Schritte

1. Task 0 aus dem Produktionsplan ausfuehren (Worktree + Baseline).
2. Danach alle Implementierungstasks aus dem Produktionsplan strikt in Reihenfolge umsetzen.
