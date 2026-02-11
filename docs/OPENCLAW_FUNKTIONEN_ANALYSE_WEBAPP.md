# Analyse: OpenClaw-Funktionen mit hohem Vorteil fuer unsere WebApp

## Ziel und Vorgehen
Ich habe `demo/openclaw-main` gegen unsere aktuelle Next.js-WebApp verglichen und nur Funktionen bewertet, die fuer unser bestehendes Produkt kurzfristig bis mittelfristig hohen Mehrwert liefern.

Verglichene Bereiche:
- Scheduling/Automation
- Command- und Tool-Sicherheit
- Multi-Session/Multi-Agent Orchestrierung
- Skill-Lifecycle (Install, Eligibility, Security)
- Kontextmanagement bei langen Tool-Dialogen

## Aktuelle Ausgangslage in unserer WebApp
- Scheduling ist aktuell client-seitig und fluechtig (`useState` + `setInterval`), z. B. `src/modules/app-shell/useTaskScheduler.ts:12`, `src/modules/app-shell/useTaskScheduler.ts:15`, `src/modules/app-shell/useAgentRuntime.ts:85`.
- Command-Approval existiert nur im Worker-Fluss (Polling-basiert), z. B. `src/server/worker/workerExecutor.ts:290`, `src/server/worker/workerExecutor.ts:303`, `src/server/worker/workerRepository.ts:408`.
- Skill-Installation ist moeglich, aber relativ offen (GitHub Raw + `npm install`) und ohne Security-Scan, z. B. `src/server/skills/skillInstaller.ts:79`, `src/server/skills/skillInstaller.ts:141`.
- Skill-Ausfuehrung ist statisch auf einen festen Handler-Map begrenzt (`Unsupported skill` sonst), z. B. `src/server/skills/executeSkill.ts:14`, `src/server/skills/executeSkill.ts:27`.
- Kontextsicherung nutzt Summaries, aber kein gezieltes Tool-Result-Pruning fuer Token-/Prompt-Druck, z. B. `src/server/channels/messages/contextBuilder.ts:11`, `src/server/channels/messages/service.ts:642`.

## Priorisierte OpenClaw-Funktionen (High Advantage)

| Prio | Funktion aus OpenClaw | Nutzen fuer uns | Aufwand | Gesamtbewertung |
|---|---|---|---|---|
| 1 | Persistentes Cron + Wake-System | Sehr hoch (zuverlaessige Automationen statt fluechtiger Reminder) | Mittel | Sehr hoch |
| 2 | Globales Exec-Approval-System (Queue + Allowlist) | Sehr hoch (Sicherheit + UX + Governance) | Mittel | Sehr hoch |
| 3 | `sessions_*` Agent-zu-Agent Tools | Hoch (orchestrierte Multi-Agent-Flows) | Mittel-Hoch | Hoch |
| 4 | Skill-Status + Install-Hardening + Security-Scan | Hoch (Supply-Chain/Operations Risiko sinkt) | Mittel | Hoch |
| 5 | Kontext-Pruning fuer Tool-lastige Verlaeufe | Mittel-Hoch (stabilere lange Sessions) | Niedrig-Mittel | Hoch |

## 1) Persistentes Cron + Wake-System
OpenClaw-Reifegrad:
- Einheitliches Cron-Tool mit `status/list/add/update/remove/run/runs/wake`: `demo/openclaw-main/src/agents/tools/cron-tool.ts:227`, `demo/openclaw-main/src/agents/tools/cron-tool.ts:290`, `demo/openclaw-main/src/agents/tools/cron-tool.ts:291`, `demo/openclaw-main/src/agents/tools/cron-tool.ts:299`, `demo/openclaw-main/src/agents/tools/cron-tool.ts:456`.
- Klare Session-Targets (`main` vs `isolated`) und Guardrails: `demo/openclaw-main/src/agents/tools/cron-tool.ts:245`, `demo/openclaw-main/src/agents/tools/cron-tool.ts:271`.
- Optionaler Kontext-Import in Erinnerungen (`contextMessages`): `demo/openclaw-main/src/agents/tools/cron-tool.ts:42`, `demo/openclaw-main/src/agents/tools/cron-tool.ts:392`.

Warum hoher Vorteil fuer uns:
- Unsere Reminder leben momentan im Browser-State und koennen bei Reload/Tab-Wechsel verloren gehen.
- Ein serverseitiges, persistentes Cron-Modell wuerde Automation fuer Channel-Workflows deutlich stabiler machen.

## 2) Globales Exec-Approval-System (Queue + Allowlist)
OpenClaw-Reifegrad:
- UI-Overlay mit Queue und Entscheidungen `Allow once / Always allow / Deny`: `demo/openclaw-main/ui/src/ui/views/exec-approval.ts:26`, `demo/openclaw-main/ui/src/ui/views/exec-approval.ts:69`, `demo/openclaw-main/ui/src/ui/views/exec-approval.ts:76`, `demo/openclaw-main/ui/src/ui/views/exec-approval.ts:83`.
- Persistente Approval-Konfiguration inkl. Agent-Allowlist und Hash-basierter Save-Konsistenz: `demo/openclaw-main/ui/src/ui/controllers/exec-approvals.ts:20`, `demo/openclaw-main/ui/src/ui/controllers/exec-approvals.ts:67`, `demo/openclaw-main/ui/src/ui/controllers/exec-approvals.ts:126`.

Warum hoher Vorteil fuer uns:
- Wir haben Approval heute nur im Worker-Executor, nicht als uebergreifendes Control-Plane-Sicherheitsmodell.
- Ein globaler Approval-Layer reduziert Risiko bei `shell_execute`-aehnlichen Pfaden und verbessert Transparenz.

## 3) `sessions_*` fuer Agent-zu-Agent Orchestrierung
OpenClaw-Reifegrad:
- Spezialisierte Tools: `sessions_list`, `sessions_send`, `sessions_history`: `demo/openclaw-main/src/agents/tools/sessions-list-tool.ts:36`, `demo/openclaw-main/src/agents/tools/sessions-send-tool.ts:44`, `demo/openclaw-main/src/agents/tools/sessions-history-tool.ts:180`.
- Policy- und Sandbox-Grenzen (`forbidden` statt stiller Eskalation): `demo/openclaw-main/src/agents/tools/sessions-send-tool.ts:107`, `demo/openclaw-main/src/agents/tools/sessions-history-tool.ts:225`.

Warum hoher Vorteil fuer uns:
- Unsere App hat Worker und Chat bereits getrennt, aber noch keinen robusten Session-zu-Session Kommunikationslayer.
- Diese Funktion ermoeglicht saubere Delegation (Planer-Agent -> Ausfuehrer-Agent -> Reviewer-Agent) mit klaren Sicherheitsgrenzen.

## 4) Skill-Lifecycle Hardening (Status, Eligibility, Install Security)
OpenClaw-Reifegrad:
- Sicherheitspruefung von Skills beim Install (`scanDirectoryWithSummary`) inkl. Warnungen bei gefaehrlichen Mustern: `demo/openclaw-main/src/agents/skills-install.ts:10`, `demo/openclaw-main/src/agents/skills-install.ts:110`, `demo/openclaw-main/src/agents/skills-install.ts:117`.
- Mehrere Installpfade mit Betriebssystem-/Tooling-Bewusstsein (brew/go/uv/download): `demo/openclaw-main/src/agents/skills-install.ts:168`, `demo/openclaw-main/src/agents/skills-install.ts:186`, `demo/openclaw-main/src/agents/skills-install.ts:192`, `demo/openclaw-main/src/agents/skills-install.ts:425`.
- Skill-Status/Eligibility und Quelle/Precedence-Logik: `demo/openclaw-main/src/agents/skills-status.ts:47`, `demo/openclaw-main/src/agents/skills/workspace.ts:159`.

Warum hoher Vorteil fuer uns:
- Unser aktueller Installer fuehrt `npm install` direkt aus und laedt Handler aus GitHub ohne integrierten Sicherheitscheck.
- Skill-Execution ist aktuell statisch; ein echter Lifecycle mit Eligibility + Safe Install + konsistenter Aktivierung waere ein grosser Qualitaetssprung.

## 5) Kontext-Pruning fuer lange Tool-Sessions
OpenClaw-Reifegrad:
- Konfigurierbares Pruning (`cache-ttl`, `softTrim`, `hardClear`, `keepLastAssistants`): `demo/openclaw-main/src/agents/pi-extensions/context-pruning/settings.ts:49`, `demo/openclaw-main/src/agents/pi-extensions/context-pruning/settings.ts:51`, `demo/openclaw-main/src/agents/pi-extensions/context-pruning/settings.ts:52`, `demo/openclaw-main/src/agents/pi-extensions/context-pruning/settings.ts:53`.
- Laufzeit-Pruning vor Request-Send mit Tool-Result-Fokus: `demo/openclaw-main/src/agents/pi-extensions/context-pruning/extension.ts:23`, `demo/openclaw-main/src/agents/pi-extensions/context-pruning/pruner.ts:225`, `demo/openclaw-main/src/agents/pi-extensions/context-pruning/pruner.ts:303`.

Warum hoher Vorteil fuer uns:
- Unsere Zusammenfassungen helfen, aber sie adressieren nicht gezielt grosse Tool-Outputs in laufenden Dialogen.
- Pruning senkt Prompt-Druck, stabilisiert Antworten und reduziert Kosten bei langen Sessions.

## Konkrete Empfehlung fuer die naechsten Schritte
1. Phase 1 (schneller ROI): Persistentes Cron/Wake + globales Exec-Approval.
2. Phase 2: `sessions_*` Kommunikationslayer fuer Multi-Agent-Orchestrierung.
3. Phase 3: Skill-Hardening (Scan/Eligibility/Installfluss) plus dynamischere Skill-Ausfuehrung.
4. Phase 4: Kontext-Pruning als Stabilitaets- und Kostenoptimierung.

## Kurzfazit
Der groesste direkte Nutzen fuer unsere WebApp entsteht durch die Uebernahme von:
- OpenClaw Cron/Wake (statt client-seitiger Reminder-Logik),
- OpenClaw Exec-Approvals (statt nur worker-lokalem Approval),
- OpenClaw `sessions_*` Orchestrierung.

Diese drei liefern den besten Mix aus Sicherheitsgewinn, Zuverlaessigkeit und funktionalem Ausbau der bestehenden Architektur.
