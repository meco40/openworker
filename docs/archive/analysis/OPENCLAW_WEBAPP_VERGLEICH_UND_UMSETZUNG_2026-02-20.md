# OpenClaw Demo vs unsere WebApp: Aktualisiertes Gesamtreview (Funktionen, Qualitaet, Nutzen)

Stand: 2026-02-21  
Vergleichsbasis: `demo/openclaw-main` vs aktueller Zustand unserer WebApp auf `main`

## 1) Executive Summary (neu)

Im letzten Vergleich war die Aussage: OpenClaw ist bei Ops-Tiefe klar vorne, besonders bei `nodes`.
Das ist in dieser Absolutheit nicht mehr korrekt.

Was sich geaendert hat:

- Unsere `nodes`-Seite ist von read-only auf echte Operability ausgebaut worden
  (`exec approvals`, `channel connect/disconnect`, `rotate secret`, `persona binding`, `telegram pending reject`):
  - `app/api/ops/nodes/route.ts:200`
  - `app/api/ops/nodes/route.ts:240`
  - `app/api/ops/nodes/route.ts:279`
  - `src/modules/ops/components/NodesView.tsx:121`
  - `src/modules/ops/components/NodesView.tsx:192`
  - `src/modules/ops/components/NodesView.tsx:345`
- `sessions` hat jetzt tiefere Filter-/Scope-Logik:
  - `app/api/ops/sessions/route.ts:95`
  - `app/api/ops/sessions/route.ts:99`
  - `src/modules/ops/components/SessionsView.tsx:85`
  - `src/modules/ops/components/SessionsView.tsx:119`
- `logs` ist weiter stark bei Web-Operability (cursor + history/buffer control):
  - `app/api/logs/route.ts:82`
  - `src/components/logs/hooks/useLogs.ts:94`
  - `src/components/logs/components/LogsToolbar.tsx:128`
  - `src/components/logs/components/LogsToolbar.tsx:188`
- `cron` run-history wurde weiter verstaerkt:
  - `app/api/automations/[id]/runs/route.ts:13`
  - `app/api/automations/[id]/runs/route.ts:37`
  - `src/modules/cron/hooks/useCronRules.ts:193`
  - `src/modules/cron/components/CronView.tsx:319`

Kurzfazit jetzt:

- **OpenClaw bleibt vorne** bei `agents`-Tiefe und klassischer `usage`-Forensik.
- **Unsere WebApp hat deutlich aufgeholt** bei `nodes` und bleibt stark bei `logs`, `cron`, produktionsnaher Plattformbreite und API-Testhaerte.

---

## 2) Welche Aussagen aus der alten Version veraltet sind

### Veraltet 1: "Nodes klar vorne bei OpenClaw"

Das war frueher korrekt, weil unsere Nodes-Seite primar Read-Only war.  
Mit dem neuen Stand ist das nicht mehr "klar vorne", sondern "OpenClaw noch vorne, aber Gap deutlich kleiner".

Neue Fakten:

- Eigene Nodes-Mutationsroute vorhanden: `POST /api/ops/nodes`
  - `app/api/ops/nodes/route.ts:328`
- Konkrete Actions vorhanden:
  - `exec.approve/revoke/clear`: `app/api/ops/nodes/route.ts:200`
  - `bindings.setPersona`: `app/api/ops/nodes/route.ts:220`
  - `channels.connect/disconnect`: `app/api/ops/nodes/route.ts:240`, `app/api/ops/nodes/route.ts:265`
  - `channels.rotateSecret`: `app/api/ops/nodes/route.ts:279`
  - `telegram.rejectPending`: `app/api/ops/nodes/route.ts:304`

OpenClaw bleibt trotzdem tiefer bei Device-Lifecycle:

- `Approve/Reject`: `demo/openclaw-main/ui/src/ui/views/nodes.ts:144`
- `Rotate/Revoke` (device tokens): `demo/openclaw-main/ui/src/ui/views/nodes.ts:197`

### Veraltet 2: "Ops-Vergleich insgesamt klar Demo-lastig"

Auch das muss nuanciert werden:

- Unsere WebApp hat jetzt 7 Ops-Punkte sichtbar und direkt geroutet:
  - Sidebar: `src/components/Sidebar.tsx:54`
  - Rendering: `src/modules/app-shell/components/AppShellViewContent.tsx:138`
- Nodes/Sessions/Cron/Logs wurden in der Tiefe nachgezogen.

---

## 3) Gesamtvergleich auf einen Blick (aktualisiert)

| Dimension        | OpenClaw Demo                                               | Unsere WebApp                                                        | Urteil (2026-02-21)                  |
| ---------------- | ----------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------ |
| Ops-Tiefe gesamt | Sehr stark, vor allem `agents` + `usage` + Device-Workflows | Deutlich ausgebaut, besonders `nodes` + `sessions` + `logs` + `cron` | Eher ausgeglichener als vorher       |
| Nodes            | Sehr tiefer Device- und Token-Lifecycle                     | Jetzt echte Operability inkl. Mutationen                             | OpenClaw leicht vorne                |
| Sessions         | Tiefe per-session override controls                         | Starke produktive CRUD + sichere Scope-Filter                        | Unterschiedlicher Fokus, beide stark |
| Usage            | Sehr tiefe Forensik/Query/Export                            | Stark bei Prompt-Risk-Observability                                  | OpenClaw vorne bei klassischer Usage |
| Logs             | Solide klassische Logs-View                                 | Cursor + Load-Older + buffer/history controls                        | Unsere WebApp vorne                  |
| Cron             | Reif                                                        | Kernparitaet + variable History-Limits                               | Nahezu gleichwertig                  |
| Agents           | Multi-Panel tief (files/tools/skills/channels/cron)         | Kompakter Runtime-View                                               | OpenClaw klar vorne                  |
| Plattformbreite  | Stark als Ops-Konsole                                       | Breitere integrierte Produktkonsole                                  | Unsere WebApp vorne                  |

---

## 4) Tiefer Funktionsvergleich

## 4.1 Informationsarchitektur

**OpenClaw Vorteil**

- Sehr klare Tab-IA in Gruppen:
  - `demo/openclaw-main/ui/src/ui/navigation.ts:7`

**Unsere WebApp Vorteil**

- Breite integrierte Shell plus Ops-Cluster in einer App:
  - `src/components/Sidebar.tsx:54`
  - `src/modules/app-shell/components/AppShellViewContent.tsx:138`

## 4.2 Sessions

**OpenClaw Vorteil**

- Tiefe session-level Overrides (thinking/verbose/reasoning):
  - `demo/openclaw-main/ui/src/ui/views/sessions.ts:198`
  - `demo/openclaw-main/ui/src/ui/views/sessions.ts:270`

**Unsere WebApp Vorteil**

- Produktive Verwaltung plus sichere Filterlogik:
  - `activeMinutes/includeGlobal/includeUnknown`: `app/api/ops/sessions/route.ts:95`
  - Scope-Absicherung (`includeGlobalApplied`): `app/api/ops/sessions/route.ts:99`
  - UI-Filter sichtbar: `src/modules/ops/components/SessionsView.tsx:85`

## 4.3 Usage / Stats

**OpenClaw Vorteil**

- Sehr tiefe Query-/Zeitachsen-/Export-Forensik:
  - `demo/openclaw-main/ui/src/ui/views/usage.ts:45`
  - `demo/openclaw-main/ui/src/ui/views/usage.ts:637`
  - `demo/openclaw-main/ui/src/ui/views/usage.ts:522`

**Unsere WebApp Vorteil**

- Starkes Prompt-Risk-Observability mit Risk-Level/Score/Reasons:
  - `src/components/stats/PromptLogsTab.tsx:19`
  - `src/components/stats/PromptLogsTab.tsx:167`
  - `src/components/stats/PromptLogsTab.tsx:485`

Bewertung: Demo vorne bei klassischer Usage-Forensik; unsere App vorne bei Prompt-Risk-Sicht.

## 4.4 Cron

**OpenClaw**

- Reife Cron-Oberflaeche.

**Unsere WebApp (aktuell)**

- Bounded API-Limits + einstellbare Run-History-Tiefe:
  - `app/api/automations/[id]/runs/route.ts:13`
  - `app/api/automations/[id]/runs/route.ts:37`
  - `src/modules/cron/hooks/useCronRules.ts:193`
  - `src/modules/cron/components/CronView.tsx:319`

Bewertung: praktisch gleichwertig fuer die Kernbedarfe.

## 4.5 Nodes (stark aktualisiert)

**OpenClaw Vorteil (weiterhin)**

- Device- und Token-Lifecycle im Screen:
  - `demo/openclaw-main/ui/src/ui/views/nodes.ts:144`
  - `demo/openclaw-main/ui/src/ui/views/nodes.ts:197`
  - `demo/openclaw-main/ui/src/ui/views/nodes.ts:277`

**Unsere WebApp (neu)**

- Vollwertige Nodes-Operability mit API + UI:
  - Action-Backend: `app/api/ops/nodes/route.ts:200`
  - Channel/Pairing actions: `app/api/ops/nodes/route.ts:240`
  - Secret rotation: `app/api/ops/nodes/route.ts:279`
  - UI Panels: `src/modules/ops/components/NodesView.tsx:121`, `src/modules/ops/components/NodesView.tsx:192`
  - Telegram pending handling: `src/modules/ops/components/NodesView.tsx:345`
  - Hook-actions: `src/modules/ops/hooks/useOpsNodes.ts:126`

Bewertung: Groesser Gap-Close; OpenClaw bleibt vorne bei Device-spezifischer Tiefe.

## 4.6 Agents

**OpenClaw Vorteil**

- Reifer Multi-Panel Agent-Workspace:
  - `demo/openclaw-main/ui/src/ui/views/agents.ts:31`
  - `demo/openclaw-main/ui/src/ui/views/agents.ts:316`

**Unsere WebApp**

- Solider Runtime-Ueberblick, aber weniger tief als Demo:
  - `src/modules/ops/components/AgentsView.tsx`

Bewertung: OpenClaw klar vorne.

## 4.7 Logs

**OpenClaw**

- Klassische Logs-View mit Filter/Auto-follow.

**Unsere WebApp**

- Cursor-basierte Historie, Load-Older, HISTORY/BUFFER-Controls:
  - `app/api/logs/route.ts:82`
  - `app/api/logs/route.ts:93`
  - `src/components/logs/hooks/useLogs.ts:94`
  - `src/components/logs/components/LogsToolbar.tsx:128`
  - `src/components/logs/components/LogsToolbar.tsx:188`

Bewertung: unsere WebApp bleibt hier vorne fuer Web-Ops-Skalierung.

---

## 5) Qualitaetsvergleich (Tests, Betrieb, Sicherheit)

## 5.1 Test-/Contract-Reife (aktualisiert)

Neue/aktualisierte Tests fuer die ausgebauten Ops-Pfade:

- Nodes API inkl. Mutationen:
  - `tests/integration/ops/ops-routes.test.ts:432`
- Sessions advanced filter contract:
  - `tests/integration/ops/ops-routes.test.ts:186`
- Logs cursor/limit contract:
  - `tests/integration/telemetry/logs-route.test.ts:114`
  - `tests/integration/telemetry/logs-route.test.ts:142`
- Cron bounded runs limit:
  - `tests/integration/automation/automations-routes.test.ts:146`
- Nodes/Sessions/Cron UI unit coverage:
  - `tests/unit/components/ops-nodes-view.test.ts:187`
  - `tests/unit/components/ops-sessions-view.test.ts`
  - `tests/unit/components/cron-view.test.ts`

Bewertung: Unsere API-/Integrationshaerte ist weiterhin eine klare Staerke.

## 5.2 Security-/Scope-Logik

- User-Context-Guards in Ops-Routen bleiben zentral:
  - `src/server/auth/userContext.ts:41`
  - `app/api/ops/nodes/route.ts:314`
  - `app/api/ops/sessions/route.ts:99`

---

## 6) Wo OpenClaw heute noch besser ist

1. Agenten-Operability-Tiefe (`files/tools/skills/channels/cron`) in einem konsistenten Agenten-Workspace.
2. Klassische Usage-Forensik mit sehr tiefen Query/Export/Drilldown-Flows.
3. Device-/Token-Lifecycle auf Nodes weiterhin tiefer spezialisiert.

---

## 7) Wo unsere WebApp heute besser ist

1. Plattformbreite in einer App-Shell (Ops + Produkt + Security + Memory + Personas).
2. Logs-Ops im Web (cursor/history/buffer/load-older) sehr performant und bedienbar.
3. Deutlich verbesserte Nodes-Operability mit serverseitigen Mutationen und UI-Steuerung.
4. Starke API-/Integrations-Testabdeckung auf kritischen Betriebsrouten.

---

## 8) Endurteil (neu)

Der Vergleich ist jetzt weniger "Demo klar vorne" als noch am 2026-02-20:

- **OpenClaw bleibt vorne** in `agents` und klassischer `usage`-Forensik.
- **Unsere WebApp hat sichtbar aufgeholt** in `nodes` und bestaetigt Staerke bei `logs`, `cron`, Integrationsreife und Plattformbreite.

Praktisch bedeutet das:

- Fuer tiefste Agenten-/Usage-Operations ist Demo weiterhin Referenz.
- Fuer produktionsnahe, integrierte Ops + Produktarbeit ist unsere WebApp inzwischen mindestens gleichwertig und in Teilbereichen klar besser.
