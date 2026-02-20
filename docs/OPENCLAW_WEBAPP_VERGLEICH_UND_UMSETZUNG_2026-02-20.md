# OpenClaw Demo vs unsere WebApp: Tiefes Gesamtreview (Funktionen, Qualitaet, Nutzen)

Stand: 2026-02-20  
Vergleichsbasis: `demo/openclaw-main` vs aktueller Zustand unserer WebApp auf `main`

## 1) Executive Summary

Wenn man nur die reine Ops-Konsole betrachtet, ist die OpenClaw-Demo aktuell in der Tiefe pro Ops-Seite noch vorne (vor allem `nodes`, `agents`, `usage`).

Wenn man das Gesamtsystem betrachtet (Ops + produktive Integrationen + Security/Channel-Realitaet + Testabsicherung), ist unsere WebApp in mehreren produktionsnahen Bereichen staerker.

Kurz gesagt:

- **OpenClaw Demo staerker**: Ops-Spezialtiefe und Bedienlogik innerhalb einzelner Ops-Screens.
- **Unsere WebApp staerker**: integrierte Plattformbreite, Channel-Realitaet, Prompt-Risiko-Transparenz, API-/Integrationstest-Reife.

---

## 2) Wie bewertet wurde

Die Bewertung ist codebasiert, nicht meinungsbasiert.

Primarquellen:

- Demo UI/Navi/Views:
  - `demo/openclaw-main/ui/src/ui/navigation.ts:7`
  - `demo/openclaw-main/ui/src/ui/app-render.ts:299`
  - `demo/openclaw-main/ui/src/ui/views/sessions.ts:128`
  - `demo/openclaw-main/ui/src/ui/views/usage.ts:515`
  - `demo/openclaw-main/ui/src/ui/views/nodes.ts:32`
  - `demo/openclaw-main/ui/src/ui/views/agents.ts:31`
  - `demo/openclaw-main/ui/src/ui/views/logs.ts:45`
- Unsere WebApp:
  - `src/components/Sidebar.tsx:49`
  - `src/modules/app-shell/components/AppShellViewContent.tsx:137`
  - `app/api/ops/sessions/route.ts:95`
  - `src/modules/ops/components/SessionsView.tsx:80`
  - `app/api/logs/route.ts:82`
  - `src/components/logs/components/LogsToolbar.tsx:188`
  - `src/modules/cron/components/CronView.tsx:325`
  - `src/components/stats/PromptLogsTab.tsx:19`
  - `src/messenger/ChannelPairing.tsx:17`
  - `src/server/channels/healthMonitor.ts:58`
- Qualitaet/Security/Doku:
  - `demo/openclaw-main/docs/security/README.md:7`
  - `demo/openclaw-main/docs/security/THREAT-MODEL-ATLAS.md:24`
  - `docs/SECURITY_SYSTEM.md:798`
  - `src/server/auth/userContext.ts:41`
  - `tests/integration/ops/ops-routes.test.ts:21`
  - `tests/integration/automation/automations-routes.test.ts:59`
  - `tests/integration/telemetry/logs-route.test.ts:33`
  - `tests/integration/telemetry/logs-ingest-route.test.ts:65`

---

## 3) Gesamtvergleich auf einen Blick

| Dimension                    | OpenClaw Demo                                             | Unsere WebApp                                                                                 | Urteil                               |
| ---------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------ |
| Funktionen (Ops)             | Sehr tiefe Ops-Screens mit vielen direkten Aktionen       | 7 Ops-Seiten vorhanden, plus juengst ausgebaut (Sessions/Logs/Cron)                           | Demo leicht vorne in Ops-Tiefe       |
| Funktionen (Gesamtprodukt)   | Fokus stark auf Gateway/Ops-Flows                         | Breitere integrierte Produktflaeche (Models, Personas, Memory, Tasks, Profile, Security etc.) | Unsere WebApp vorne                  |
| Qualitaet (UI-Reife)         | Sehr aufgeraeumte Ops-IA und starke View-Spezialisierung  | Modular, aber unterschiedliche Reifegrade je Screen                                           | Gemischt                             |
| Qualitaet (Tests/API)        | Gute UI/View-Tests in Demo-Scope                          | Sehr breite Integrationstests ueber APIs und Security Guards                                  | Unsere WebApp vorne                  |
| Security/Trust-Kommunikation | Sehr starke oeffentliche Threat-Model-/Trust-Doku         | Sehr starke technische Security-Implementierung + Auth Guards                                 | Beide stark, mit anderem Schwerpunkt |
| Nutzen im Betrieb            | Sehr gut fuer Ops-Teams, die tiefe Einzelscreens brauchen | Sehr gut fuer produktionsnahe Teams mit Multi-Channel/Prompt-Risk/Integrationsbedarf          | Kontextabhaengig                     |

---

## 4) Tiefer Funktionsvergleich

## 4.1 Informationsarchitektur und Navigation

**OpenClaw Demo Vorteil**

- Klare Navigationsgruppen (`control`, `agent`, `settings`) mit fokussierten Tabs (`sessions`, `usage`, `cron`, `nodes`, `agents`, `logs`) in einer konsistenten IA: `demo/openclaw-main/ui/src/ui/navigation.ts:7`.
- Zentrale Verdrahtung aller Views ueber einen orchestrierten Render-Flow: `demo/openclaw-main/ui/src/ui/app-render.ts:146`.

**Unsere WebApp Vorteil**

- Deutlich breitere App-Oberflaeche in derselben Shell, nicht nur Ops:
  - Sidebar-Views inkl. `MODELS`, `PERSONAS`, `MEMORY`, `TASKS`, `SECURITY`, `PROFILE`: `src/components/Sidebar.tsx:13`.
  - Direkte View-Routing-Abdeckung in AppShell: `src/modules/app-shell/components/AppShellViewContent.tsx:97`.

**Bewertung**

- Nur Ops-Cockpit: Demo klarer.
- Integrierte Produktplattform: unsere WebApp breiter.

## 4.2 Sessions

**OpenClaw Demo Vorteil**

- Tiefe Session-Steuerung pro Zeile inkl. Thinking/Verbose/Reasoning-Overrides und Chat-Deeplink: `demo/openclaw-main/ui/src/ui/views/sessions.ts:270`, `demo/openclaw-main/ui/src/ui/views/sessions.ts:303`.

**Unsere WebApp Vorteil**

- Produktive CRUD-Flows (Create/Rename/Delete) plus ausgebauter Filterbereich:
  - `Active within minutes`, `Include global`, `Include unknown`: `src/modules/ops/components/SessionsView.tsx:80`.
- Serverseitige sichere Scope-Logik fuer `includeGlobalApplied` und Filter:
  - `app/api/ops/sessions/route.ts:99`.

**Bewertung**

- Demo tiefer in pro-Session-Override-Operability.
- Unsere App staerker in sicherer produktiver Session-Verwaltung.

## 4.3 Usage / Stats

**OpenClaw Demo Vorteil**

- Sehr tiefer Usage-Stack: Query-Tokens, Vorschlaege, Session-/Day-/Hour-Filter, Export CSV/JSON, Detailpanels:
  - `demo/openclaw-main/ui/src/ui/views/usage.ts:515`
  - `demo/openclaw-main/ui/src/ui/views/usage.ts:637`
  - `demo/openclaw-main/ui/src/ui/views/usage.ts:820`

**Unsere WebApp Vorteil**

- Stark integrierte Prompt-Dispatch-Telemetrie mit Risk-Level, Risk-Score, Reasons, Provider/Model-Filtern und Diagnostics:
  - `src/components/stats/PromptLogsTab.tsx:19`
  - `src/components/stats/PromptLogsTab.tsx:326`
  - `src/components/stats/PromptLogsTab.tsx:456`

**Bewertung**

- Demo vorne bei klassischer Usage-Forensik.
- Unsere App vorne bei Prompt-Risk-Transparenz.

## 4.4 Cron

**OpenClaw Demo**

- Reife Cron-Jobs-Ansicht mit Actions und Run-History.

**Unsere WebApp**

- Funktionsparitaet bei Kernaktionen plus juengst erweiterte History-Tiefe:
  - UI `Run history depth`: `src/modules/cron/components/CronView.tsx:325`
  - Hook-State `historyLimit`: `src/modules/cron/hooks/useCronRules.ts:193`
  - Route/Service-Limit-Weitergabe: `app/api/automations/[id]/runs/route.ts:37`, `src/server/automation/service.ts:135`

**Bewertung**

- In der Kernfunktion inzwischen weitgehend gleichwertig.

## 4.5 Nodes

**OpenClaw Demo Vorteil (deutlich)**

- Aktive Device- und Token-Operationen direkt im UI:
  - Approve/Reject: `demo/openclaw-main/ui/src/ui/views/nodes.ts:144`
  - Rotate/Revoke: `demo/openclaw-main/ui/src/ui/views/nodes.ts:197`
  - Exec-Node-Bindings/Approvals: `demo/openclaw-main/ui/src/ui/views/nodes.ts:277`

**Unsere WebApp**

- Sehr gute Read-/Lagebild-Sicht (Health/Doctor/Automation/Bindings), aber weniger direkte Steueraktionen.

**Bewertung**

- Demo klar vorne.

## 4.6 Agents

**OpenClaw Demo Vorteil (deutlich)**

- Multi-Panel-Ansatz: `overview`, `files`, `tools`, `skills`, `channels`, `cron`:
  - `demo/openclaw-main/ui/src/ui/views/agents.ts:31`
  - `demo/openclaw-main/ui/src/ui/views/agents.ts:315`

**Unsere WebApp**

- Kompakter Runtime-Ueberblick, schnell und stabil, aber weniger tief.

**Bewertung**

- Demo klar vorne in Operability-Tiefe.

## 4.7 Logs

**OpenClaw Demo**

- Klassisches File-tail-Pattern mit Level-Filtern, Export, Auto-follow:
  - `demo/openclaw-main/ui/src/ui/views/logs.ts:91`

**Unsere WebApp**

- Realtime + Cursor-Nachladen + konfigurierbare History/Buffer:
  - API `hasMore/nextCursor`: `app/api/logs/route.ts:82`
  - Hook `hasMoreHistory`: `src/components/logs/hooks/useLogs.ts:24`
  - UI `Load older`, `HISTORY`, `BUFFER`: `src/components/logs/components/LogsToolbar.tsx:128`

**Bewertung**

- Bei Log-Skalierung in der WebUI aktuell unsere App vorne.

---

## 5) Qualitaetsvergleich (Reife, Security, Tests, Doku)

## 5.1 Architektur

**OpenClaw Demo Staerke**

- Sehr koharente zentrale UI-Steuerung (Lit + zentraler App-Render), gut fuer konsistente Ops-Interaktion.

**Unsere WebApp Staerke**

- Modulare Systemarchitektur mit klar dokumentierten Domainen und Security-Layern:
  - `docs/ARCHITECTURE_DIAGRAM.md:3`

## 5.2 Security und Auth

**OpenClaw Demo Staerke**

- Exzellente oeffentliche Security-Positionierung inkl. Threat-Model-Programm:
  - `demo/openclaw-main/docs/security/README.md:7`
  - `demo/openclaw-main/docs/security/THREAT-MODEL-ATLAS.md:24`

**Unsere WebApp Staerke**

- Starke technische Security-Umsetzung:
  - ABAC dokumentiert: `docs/SECURITY_SYSTEM.md:798`
  - Request-Context/Auth-Gates: `src/server/auth/userContext.ts:41`
  - Viele Endpunkt-Tests gegen Unauthorized/Scope-Fehler.

## 5.3 Testreife

**OpenClaw Demo**

- Gute View-nahe UI-Tests in zentralen Ops-Bereichen.

**Unsere WebApp**

- Sehr breite Integrations- und API-Testabdeckung in produktionskritischen Bereichen:
  - Ops: `tests/integration/ops/ops-routes.test.ts:21`
  - Automations: `tests/integration/automation/automations-routes.test.ts:59`
  - Telemetrie/Logs: `tests/integration/telemetry/logs-route.test.ts:33`
  - Ingest/Auth: `tests/integration/telemetry/logs-ingest-route.test.ts:65`

**Bewertung**

- Teststrategie unterschiedlich:
  - Demo staerker auf UI-View-Verhalten.
  - Unsere App staerker auf API-/Security-/Integration-Haerte.

---

## 6) Nutzwertvergleich

## 6.1 Betriebsnutzen (Ops)

**OpenClaw Demo**

- Sehr stark fuer Operatoren, die tief in einem einzelnen Ops-Screen arbeiten (Nodes/Agents/Usage).

**Unsere WebApp**

- Sehr stark fuer Teams, die Ops plus reale Integrationen gemeinsam brauchen:
  - Multi-Account Pairing/Allowlist/Webhook-Scope: `src/messenger/ChannelPairing.tsx:312`, `app/api/channels/whatsapp/webhook/route.ts:205`
  - Auto-Repair-Mechanik fuer Channel-Health: `src/server/channels/healthMonitor.ts:58`

## 6.2 Produktnutzen

**OpenClaw Demo**

- Hoher Nutzen als fokussierte Ops/Control-Oberflaeche.

**Unsere WebApp**

- Hoher Nutzen als integrierte Produktkonsole (mehr End-to-End im selben UI):
  - `MODELS`, `PERSONAS`, `MEMORY`, `TASKS`, `SECURITY`, `PROFILE`: `src/components/Sidebar.tsx:13`.

## 6.3 Teamnutzen

**OpenClaw Demo**

- Klare Ops-IA reduziert Einarbeitungszeit fuer klassische Operator-Rollen.

**Unsere WebApp**

- Gemeinsame Datenbasis fuer Product + Ops + Security durch kombinierte Views (Stats/Prompt-Risk/Channels/Ops) in einer Shell.

---

## 7) Wo OpenClaw besser ist (heute)

1. **Nodes-Operability-Tiefe** (Approve/Reject/Rotate/Revoke/Bindings direkt im Screen).
2. **Agents-Multi-Panel-Reife** (Files/Tools/Skills/Channels/Cron als zusammenhaengende Agenten-Konsole).
3. **Usage-Forensik** (starkes Query-/Export-/Drilldown-Niveau).

---

## 8) Wo unsere WebApp besser ist (heute)

1. **Gesamtplattform-Breite im selben Produkt** (nicht nur Ops).
2. **Produktionsnahe Channel-Realitaet** (Multi-Account + Allowlist + account-scoped webhook + Health-Reparatur).
3. **Prompt-Risk-Observability** mit Diagnostics/Filter/Cost/Risk-Reasons.
4. **API-/Security-Integrationstest-Haerte** ueber kritische Routen.

---

## 9) Endurteil

Es gibt keinen absoluten "Gesamtsieger" ohne Kontext:

- Wenn Ziel = **maximal tiefe Ops-Konsole pro Einzelscreen**, ist die **OpenClaw-Demo aktuell vorne**.
- Wenn Ziel = **integrierte produktionsnahe Control Plane mit breiter Funktionsflaeche und starker API-/Security-Absicherung**, ist **unsere WebApp aktuell vorne**.

Strategisch ist fuer uns der beste Weg:

- Demo-Staerken gezielt uebernehmen (`nodes`, `agents`, `usage`-Tiefe),
- dabei unsere bestehenden Staerken (Channel-Realitaet, Prompt-Risk, Integrationsreife) beibehalten.
