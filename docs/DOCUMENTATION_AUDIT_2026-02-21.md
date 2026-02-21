# Documentation Audit 2026-02-21

Stand: 2026-02-21
Scope: Alle zuvor nicht-archivierten Dateien unter `docs/` wurden einzeln bewertet.

## Ergebnis

- Gepruefte Dateien: `51`
- Aktiv behalten/aktualisiert: `32`
- Ins Archiv verschoben: `19`

## Addendum (Re-Audit 2026-02-21)

- Diese Tabelle dokumentiert den **urspruenglichen** Audit-Durchlauf.
- Im nachgelagerten IST-Abgleich wurden zusaetzlich zwei aktive Systemdokumente angelegt:
  - `docs/AUTH_SYSTEM.md`
  - `docs/OPS_OBSERVABILITY_SYSTEM.md`
- Aktive API-Domaenenabdeckung ist damit vollstaendig (`auth`, `automations`, `channels`, `clawhub`, `config`, `control-plane`, `doctor`, `health`, `knowledge`, `logs`, `memory`, `model-hub`, `ops`, `personas`, `rooms`, `security`, `skills`, `stats`).

## Einzelentscheidungen

| Dokument (vor Audit)                                                   | Entscheidung    | Ziel / Status                                                                             | Kurzbegruendung                                               |
| ---------------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `docs/README.md`                                                       | update          | aktiv                                                                                     | Neuer professioneller Index mit klaren Kategorien.            |
| `docs/API_REFERENCE.md`                                                | keep            | aktiv                                                                                     | API-Referenz bleibt Source of Truth.                          |
| `docs/ARCHITECTURE_DIAGRAM.md`                                         | keep            | aktiv                                                                                     | Architektur-Blueprint weiterhin relevant.                     |
| `docs/architecture/model-hub-provider-matrix.md`                       | keep            | aktiv                                                                                     | Produktions-Provider-Matrix bleibt Referenz.                  |
| `docs/AUTOMATION_SYSTEM.md`                                            | keep            | aktiv                                                                                     | Aktive Systemdoku fuer Automations.                           |
| `docs/CLAWHUB_SYSTEM.md`                                               | keep            | aktiv                                                                                     | Aktive ClawHub-Systemdoku.                                    |
| `docs/CORE_HANDBOOK.md`                                                | keep            | aktiv                                                                                     | Zentrale technische Gesamtdoku.                               |
| `docs/DEPLOYMENT_OPERATIONS.md`                                        | keep            | aktiv                                                                                     | Betriebs- und Deployment-Referenz aktiv.                      |
| `docs/KNOWLEDGE_BASE_SYSTEM.md`                                        | keep            | aktiv                                                                                     | Aktive Systembeschreibung fuer Knowledge Base.                |
| `docs/MEMORY_SYSTEM.md`                                                | keep            | aktiv                                                                                     | Aktive Systembeschreibung fuer Memory.                        |
| `docs/memory-architecture.md`                                          | keep            | aktiv                                                                                     | Tiefere Architekturreferenz fuer Memory.                      |
| `docs/MODEL_HUB_SYSTEM.md`                                             | keep            | aktiv                                                                                     | Aktive Systemdoku fuer Model Hub.                             |
| `docs/OMNICHANNEL_GATEWAY_OPERATIONS.md`                               | keep            | aktiv                                                                                     | Betriebsrichtlinien weiterhin relevant.                       |
| `docs/OMNICHANNEL_GATEWAY_SYSTEM.md`                                   | keep            | aktiv                                                                                     | Aktive Omnichannel-/Gateway-Systemdoku.                       |
| `docs/PERSONA_ROOMS_SYSTEM.md`                                         | keep            | aktiv                                                                                     | Aktive Persona/Rooms-Systemdoku.                              |
| `docs/SECURITY_SYSTEM.md`                                              | keep            | aktiv                                                                                     | Aktive Security-Referenz.                                     |
| `docs/SESSION_MANAGEMENT.md`                                           | keep            | aktiv                                                                                     | Aktive Session-Systemdoku.                                    |
| `docs/SKILLS_SYSTEM.md`                                                | keep            | aktiv                                                                                     | Aktive Skill-Systemdoku.                                      |
| `docs/SPEC_KIT.md`                                                     | keep            | aktiv                                                                                     | Prozessdoku mit aktuellem Nutzwert.                           |
| `docs/ux/gateway-config-copy-guidelines.md`                            | keep            | aktiv                                                                                     | UX/Copy-Leitlinie weiterhin nutzbar.                          |
| `docs/WORKER_ORCHESTRA_SYSTEM.md`                                      | keep            | aktiv                                                                                     | Aktive Orchestra-Systemdoku.                                  |
| `docs/WORKER_SYSTEM.md`                                                | keep            | aktiv                                                                                     | Aktive Worker-Systemdoku.                                     |
| `docs/runbooks/chat-cli-smoke-approval.md`                             | keep            | aktiv                                                                                     | Aktives Runbook fuer Smoke-Freigabe.                          |
| `docs/runbooks/gateway-config-production-rollout.md`                   | keep            | aktiv                                                                                     | Aktives Rollout-Runbook.                                      |
| `docs/runbooks/openai-worker-data-governance.md`                       | move-to-archive | `docs/archive/runbooks/openai-worker-data-governance.md`                                  | Referenziert entfernten OpenAI-Worker-Service.                |
| `docs/runbooks/openai-worker-local-runbook.md`                         | move-to-archive | `docs/archive/runbooks/openai-worker-local-runbook.md`                                    | Referenziert entfernten OpenAI-Worker-Service.                |
| `docs/runbooks/openai-worker-rollout.md`                               | move-to-archive | `docs/archive/runbooks/openai-worker-rollout.md`                                          | Referenziert entfernten OpenAI-Worker-Service.                |
| `docs/runbooks/openai-worker-slos.md`                                  | move-to-archive | `docs/archive/runbooks/openai-worker-slos.md`                                             | Referenziert entfernten OpenAI-Worker-Service.                |
| `docs/runbooks/worker-orchestra-v1-rollout.md`                         | move-to-archive | `docs/archive/runbooks/worker-orchestra-v1-rollout.md`                                    | Orchestra-Service entfernt.                                   |
| `docs/plans/README.md`                                                 | update          | aktiv                                                                                     | Bereinigte Liste nur mit verbleibenden aktiven Plaenen.       |
| `docs/plans/2026-02-20-point7-best-case-plus-production-plan.md`       | keep            | aktiv                                                                                     | Noch aktiver Umsetzungsplan.                                  |
| `docs/plans/2026-02-21-webapp-cleanup-optimization.md`                 | keep            | aktiv                                                                                     | Neuester aktiver Umsetzungsplan.                              |
| `docs/analysis/worker-workflow-deep-analysis.md`                       | move-to-archive | `docs/archive/analysis/worker-workflow-deep-analysis.md`                                  | Historische Detailanalyse, kein laufendes Betriebsdokument.   |
| `docs/ARCHITECTURE_ALTERNATIVES_ANALYSIS.md`                           | move-to-archive | `docs/archive/analysis/ARCHITECTURE_ALTERNATIVES_ANALYSIS.md`                             | Alternativenvergleich statt aktiver Soll-Architektur.         |
| `docs/MEMORY_ARCHITECTURE_ANALYSIS.md`                                 | move-to-archive | `docs/archive/analysis/MEMORY_ARCHITECTURE_ANALYSIS.md`                                   | Historischer Analyse-Stand, durch aktive Memory-Doku ersetzt. |
| `docs/MEMORY_ARCHITECTURE_ANALYSIS_REVIEW.md`                          | move-to-archive | `docs/archive/analysis/MEMORY_ARCHITECTURE_ANALYSIS_REVIEW.md`                            | Review zu historischem Analysepapier.                         |
| `docs/openai-agents-sdk-vs-openclaw-tiefenanalyse.md`                  | move-to-archive | `docs/archive/analysis/openai-agents-sdk-vs-openclaw-tiefenanalyse.md`                    | Vergleichsanalyse, kein aktiver Betriebsleitfaden.            |
| `docs/openclaw-vs-openai-deep-analysis.md`                             | move-to-archive | `docs/archive/analysis/openclaw-vs-openai-deep-analysis.md`                               | Vergleichsanalyse, kein Source-of-Truth.                      |
| `docs/OPENCLAW_WEBAPP_VERGLEICH_UND_UMSETZUNG_2026-02-20.md`           | move-to-archive | `docs/archive/analysis/OPENCLAW_WEBAPP_VERGLEICH_UND_UMSETZUNG_2026-02-20.md`             | Bewertungsdokument statt laufender Spezifikation.             |
| `docs/SESSION_MANAGEMENT_IMPLEMENTATION.md`                            | move-to-archive | `docs/archive/reports/SESSION_MANAGEMENT_IMPLEMENTATION.md`                               | Implementierungsbericht, nicht laufende Referenz.             |
| `docs/DOCS_CHANGELOG_2026-02-17.md`                                    | move-to-archive | `docs/archive/reports/DOCS_CHANGELOG_2026-02-17.md`                                       | Datumsgebundenes Aenderungsprotokoll, historisch.             |
| `docs/mock-data/2026-02-17-chat-preview-user-persona-assistant.md`     | move-to-archive | `docs/archive/reports/2026-02-17-chat-preview-user-persona-assistant.md`                  | Mock-Vorschau ohne laufenden Betriebswert.                    |
| `docs/global-policy-production-plan-and-execution.md`                  | move-to-archive | `docs/archive/plans/completed/global-policy-production-plan-and-execution.md`             | Plan-/Execution-Dokument, als abgeschlossen einsortiert.      |
| `docs/persona-policy-runtime-plan.md`                                  | move-to-archive | `docs/archive/plans/completed/persona-policy-runtime-plan.md`                             | Plan-Dokument, kein aktiver Standard mehr.                    |
| `docs/plans/2026-02-12-knowledge-base-agent-access-implementation.md`  | move-to-archive | `docs/archive/plans/completed/2026-02-12-knowledge-base-agent-access-implementation.md`   | Alter Implementierungsplan, abgeschlossen.                    |
| `docs/plans/2026-02-13-clawhub-dual-lane-design.md`                    | move-to-archive | `docs/archive/plans/completed/2026-02-13-clawhub-dual-lane-design.md`                     | Frueheres Design, umgesetzt und historisch.                   |
| `docs/plans/2026-02-17-memory-knowledge-entity-preservation.md`        | move-to-archive | `docs/archive/plans/superseded/2026-02-17-memory-knowledge-entity-preservation.md`        | Inhaltlich durch spaetere Planstaende ersetzt.                |
| `docs/plans/2026-02-17-memory-plan-alternative.md`                     | move-to-archive | `docs/archive/plans/superseded/2026-02-17-memory-plan-alternative.md`                     | Alternative, nicht finaler aktiver Plan.                      |
| `docs/plans/2026-02-19-single-port-cross-platform-runtime-design.md`   | move-to-archive | `docs/archive/plans/completed/2026-02-19-single-port-cross-platform-runtime-design.md`    | Dokument enthaelt bereits Abschlussstatus.                    |
| `docs/plans/2026-02-20-nodes-operability-best-case-production-plan.md` | move-to-archive | `docs/archive/plans/superseded/2026-02-20-nodes-operability-best-case-production-plan.md` | Durch spaetere konsolidierte Plaene ersetzt.                  |
| `docs/plans/2026-02-20-ops-console-seven-point-production-plan.md`     | move-to-archive | `docs/archive/plans/superseded/2026-02-20-ops-console-seven-point-production-plan.md`     | Durch spaetere konsolidierte Plaene ersetzt.                  |

## Hinweis

Bei Konflikten zwischen aktiv und archiviert gilt weiterhin nur der aktive Bereich unter `docs/`.
