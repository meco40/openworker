c# Plan: Single-Port App Mode mit Cross-Platform Runtime

Stand: 2026-02-19
Status: Umsetzung abgeschlossen (Hauptchat + Telegram + CLI kompatibel uebernommen)

## 1. Entscheidung

Gewaehlte Richtung: **Option A**

- Nach aussen wirkt die App wie ein Programm mit **einem einzigen Port**.
- Intern bleiben mehrere Dienste moeglich (Web, Scheduler, Mem0).
- Ziel bleibt: Flexibilitaet und gute Wartbarkeit ohne Monolith-Umbau.

## 2. Ziele

1. Ein User kann die App auf **Windows**, **WSL2** und **Linux** starten.
2. Docker ist **optional**, nicht verpflichtend.
3. Es gibt einen klaren "Programm-Modus": ein Startkommando, ein externer Port.
4. Interne Dienste sind austauschbar und koennen getrennt skaliert werden.

## 3. Nicht-Ziele

1. Kein Full-Monolith-Umbau (ein Prozess fuer alles).
2. Kein Entfernen bestehender Service-Grenzen.
3. Keine separate Worker-Runtime im Zielbild.

## 4. Optionen und Trade-offs

## Option A1 (Empfehlung): Single-Port-Edge, interne Services

- Extern wird nur `APP_PORT` (Default `3000`) veroeffentlicht.
- Mem0/Postgres laufen intern oder lokal gebunden.
- Docker- und Native-Modus nutzen dieselbe Runtime-Logik.

Vorteile:

- "Programm-Gefuehl" fuer Nutzer.
- Flexibel fuer Betrieb und Skalierung.
- Niedriger Umbauaufwand.

Nachteile:

- Intern bleibt Orchestrierung komplexer als Monolith.
- Mehr Health/Readiness-Logik noetig.

## Option B: Echter Monolith

Vorteile:

- Einfachste Laufzeitstruktur.

Nachteile:

- Hoher Umbauaufwand.
- Groesserer Ausfallradius.
- Schlechtere spaetere Skalierung.

## Option C: Docker-only

Vorteile:

- Einheitliche Umgebung.

Nachteile:

- Schlechtere lokale Einstiegshuerde (insb. Windows ohne WSL2-Workflow).
- Ziel "Docker optional" wird verfehlt.

## 5. Zielarchitektur

## 5.1 Externe Schnittstelle

- Genau ein oeffentlicher Port: `APP_PORT` (Default `3000`).
- Alle anderen Ports nur intern (Container-Netzwerk) oder loopback-only.

## 5.2 Laufzeit-Profile

1. `native-minimal`
   - Web + Scheduler lokal.
   - Mem0 extern erreichbar (z.B. Cloud oder separater Host).
   - Extern sichtbar: nur `3000`.
2. `native-local-stack`
   - Web + Scheduler + lokaler Mem0-Stack.
   - Mem0/DB nur loopback/intern.
   - Extern sichtbar: nur `3000`.
3. `docker-single-port`
   - Compose-Stack.
   - Nur `web` mapped Host-Port.
   - Mem0/Postgres ohne Host-Port-Mapping.

## 5.3 Startmodell ("wie ein Programm")

- Ein einheitlicher Launcher:
  - Windows: `scripts/app-start.ps1`
  - Linux/WSL2: `scripts/app-start.sh`
- Der Launcher:
  1. erkennt Profil (`native-minimal`, `native-local-stack`, `docker-single-port`)
  2. prueft Voraussetzungen
  3. startet Dienste in korrekter Reihenfolge
  4. prueft Readiness
  5. zeigt nur eine Endpunkt-URL (`http://localhost:3000`)

## 5.4 Degrade/Fallback-Regeln

- Es gibt keine separate Worker-Runtime mehr.
- Bei Ausfall interner Dienste (z.B. Mem0/DB) werden klare Fehlermodi und
  definierte Wiederanlaufpfade bereitgestellt.

## 6. Plattformzielbild

## 6.1 Windows (PowerShell, optional Docker Desktop)

- Primarstart ueber `scripts/app-start.ps1`.
- Native und Docker-Modus verfuegbar.

## 6.2 WSL2

- Gleiches Verhalten wie Linux.
- Start ueber `scripts/app-start.sh`.

## 6.3 Linux

- Native via shell script oder systemd.
- Docker-Modus optional.

## 7. Docker als Option (nicht Pflicht)

- Compose-Profil fuer "Single-Port":
  - `web` exposed: `${APP_PORT:-3000}:3000`
  - keine Exposes fuer Mem0/Postgres auf Host.
- Debug-Profil optional fuer Entwickler mit zusaetzlichen Host-Ports.

## 8. Umsetzungsplan

1. Profil-Definitionen und Env-Defaults standardisieren.
2. Einheitliche Launcher-Skripte fuer Windows und Linux/WSL2 bauen.
3. Compose auf Single-Port-Default umstellen; Debug-Profil getrennt ausweisen.
4. Readiness-Checks und klare Fehlermeldungen fuer Abhaengigkeiten erweitern.
5. Runbooks fuer drei Zielplattformen vereinheitlichen.
6. Smoke-Tests fuer alle drei Plattformpfade dokumentieren.
7. Hard-Remove-Plan fuer Worker-Endpunkte und Worker-UI mit Kompatibilitaetsmatrix erstellen.
8. Vollstaendige Uebernahme der relevanten Funktionen aus `demo` umsetzen (kein Teilmodus).
9. Alle identifizierten Kompatibilitaetsluecken schliessen (API, WS-Events, CLI, Telegram).
10. SLO/Alerting-Baseline fuer WebChat, Gateway und Telegram festlegen.
11. Last-/Fehler-/Recovery-Tests vor Go-Live durchfuehren.
12. Go/No-Go-Review mit klaren Abbruchkriterien durchfuehren.

## 9. Akzeptanzkriterien

1. Ein Nutzer startet die App je Plattform mit einem Kommando.
2. Nach aussen ist nur ein Port sichtbar.
3. Docker ist optional; Native-Start funktioniert weiterhin.
4. Ausfall interner Dienste (z.B. Mem0/DB) fuehrt zu klaren, reproduzierbaren Fehlermodi.
5. Dokumentation deckt Windows, WSL2 und Linux ohne Luecken ab.
6. Chat-Streaming-SLO erreicht:
   - `chat.first_token.p95 <= 2.5s` (WebChat)
   - `chat.first_token.p95 <= 4.0s` (Telegram)
7. Gateway-Verfuegbarkeit erreicht:
   - `gateway.ws_connect_success_rate >= 99.5%` pro 15 Min.
8. Telegram-Zustellung erreicht:
   - `telegram.outbound_success_rate >= 99.0%` pro Stunde
   - `telegram.polling_409_rate < 0.5%`
9. Fehlerquote erreicht:
   - `chat.request_error_rate < 1.0%` pro Stunde

## 10. Risiken und Gegenmassnahmen

1. Risiko: Port-Konflikte lokal.
   - Gegenmassnahme: `APP_PORT` frei konfigurierbar, Vorab-Portcheck im Launcher.
2. Risiko: Unterschiedliches Verhalten zwischen Windows und WSL2.
   - Gegenmassnahme: separates Smoke-Szenario pro Plattform.
3. Risiko: Zu viele "versteckte" Abhaengigkeiten trotz Single-Port.
   - Gegenmassnahme: Health-Ausgabe listet alle internen Dienste inkl. Status.
4. Risiko: Regressionen durch Hard-Remove von Worker-Schnittstellen.
   - Gegenmassnahme: API-/UI-Kompatibilitaetsmatrix und verpflichtende End-to-End-Abdeckung vor Go-Live.
5. Risiko: Unvollstaendige Uebernahme aus `demo` fuehrt zu Funktionsluecken.
   - Gegenmassnahme: Vollstaendigkeits-Checklist pro Modul und Blocker-Gate fuer offene Kompatibilitaetsfixes.

## 11. Uebernahme aus `demo` (OpenClaw)

Dieser Plan wird erweitert: Neben Single-Port-Betrieb wird der produktive Kern
aus `demo` uebernommen, damit der Hauptchat, lokale CLI-Ausfuehrung und Channel-
Funktionen konsistent aus einer Architektur stammen.

### 11.1 Quelle und Scope

- Primaere Referenz fuer die Uebernahme ist `demo/src/*`.
- Fokus ist explizit:
  1. User-Aufgabe im Chat -> Agent-Orchestrierung
  2. saubere CLI-Ausfuehrung auf dem lokalen PC
  3. Streaming-Antworten
  4. Telegram/Channel-Funktionalitaet

### 11.2 Module, die uebernommen werden

1. Gateway + Chat-Orchestrierung
   - `demo/src/gateway/server-chat.ts`
   - `demo/src/gateway/server-methods.ts`
   - `demo/src/gateway/server.ts`
   - `demo/src/gateway/protocol/*`
2. CLI-Laufzeit und Befehlsrouting
   - `demo/src/cli/program.ts`
   - `demo/src/cli/gateway-cli.ts`
   - `demo/src/cli/node-cli.ts`
   - `demo/src/cli/channels-cli.ts`
3. Command-Approval und Sicherheitsgrenzen fuer Exec
   - `demo/src/gateway/exec-approval-manager.ts`
   - `demo/src/gateway/method-scopes.ts`
   - `demo/src/gateway/node-command-policy.ts`
4. Channels und Telegram
   - `demo/src/channels/*`
   - `demo/src/telegram/*`
   - `demo/src/pairing/*`

### 11.3 Module, die nicht uebernommen werden (Hard Cut)

Der bestehende Worker-Stack wird bewusst entfernt, um vollen Fokus auf den
Hauptchat zu erzwingen:

1. `src/server/worker/*`
2. `app/api/worker/*`
3. `src/modules/worker/*`
4. Worker-RPC im Gateway (`src/server/gateway/methods/worker.ts`, Worker-Events)
5. Worker-spezifische Runtime-Pfade

### 11.4 Zielbild nach dem Cut

1. Ein zentraler Hauptchat-Runtime-Pfad (keine parallele Worker-Runtime).
2. Chat-Streaming bleibt ueber Gateway/WS erhalten.
3. Agent kann weiterhin lokale CLI-Befehle kontrolliert ausfuehren.
4. Telegram/Channel-Features werden entlang der Demo-Pfade vereinheitlicht.

### 11.5 Umsetzungsreihenfolge (ergaenzt)

1. Hard Remove Worker-Code + APIs.
2. Chat-Runtime auf Demo-Orchestrierung (Gateway/Chat-Flow) konsolidieren.
3. CLI-Orchestrierung aus `demo/src/cli/*` integrieren.
4. Channel/Telegram-Schicht aus `demo/src/channels|telegram|pairing` angleichen.
5. End-to-End Tests: WebChat + Telegram + CLI + Streaming.

### 11.6 Telegram-Funktionsausbau (Priorisiert)

Aktive Prioritaeten fuer die Umsetzung:

1. Prioritaet 1: Delivery/Netzwerk-Haertung
   - Webhook-Absicherung und Allowed-Updates verstaerken
     (`src/server/channels/webhookAuth.ts`, `src/server/channels/pairing/telegram.ts`,
     `src/server/channels/pairing/telegramPolling.ts`)
   - Polling-Offset und Transport-Uebergaenge robust halten
     (`src/server/channels/pairing/telegramPolling.ts`)
   - Retry/Backoff fuer Telegram-Netzwerk- und Zustellfehler erweitern
     (`src/server/channels/outbound/telegram.ts`, `src/server/channels/pairing/telegramPolling.ts`)
   - Basis-Monitoring fuer Zustell- und Polling-Fehler ausbauen
2. Prioritaet 2: Bot-UX
   - Native Commands/Menu uebernehmen (`demo/src/telegram/bot-native-commands.ts`,
     `demo/src/telegram/bot-native-command-menu.ts`)
   - Inline- und Model-Buttons uebernehmen (`demo/src/telegram/inline-buttons.ts`,
     `demo/src/telegram/model-buttons.ts`)
   - bessere Ausgabeformatierung und Chunking angleichen
     (`demo/src/telegram/format.ts`, `demo/src/telegram/draft-chunking.ts`)
3. Prioritaet 3: Media + Gruppenfunktionen
   - Voice-/Audio-Pfade angleichen (`demo/src/telegram/voice.ts`)
   - Sticker-/Media-Hilfslogik uebernehmen (`demo/src/telegram/sticker-cache.ts`,
     `demo/src/telegram/send.ts`)
   - Gruppen-/Topic-/Thread-Verhalten angleichen
     (`demo/src/telegram/targets.ts`, `demo/src/telegram/group-migration.ts`)

### 11.7 Bewertung Prioritaet 1 (Delivery/Netzwerk-Haertung)

Frage: Muss Prioritaet 1 zwingend vor 2/3 gemacht werden?

Antwort:

1. Fuer reine Feature-Entwicklung ist Prioritaet 1 nicht zwingend als erster Schritt.
2. Fuer stabilen Produktionsbetrieb ist ein Minimal-Set aus Prioritaet 1 spaeter dennoch noetig:
   - robuste Webhook-Absicherung + Allowed-Updates
   - persistenter Polling-Offset
   - Retry/Backoff bei Telegram-Netzwerkfehlern
   - Basis-Monitoring fuer Zustellfehler

Entscheidung in diesem Plan:

1. Jetzt umsetzen: Prioritaet 1, 2 und 3.
2. Reihenfolge: zuerst Stabilitaets-Baseline aus Prioritaet 1, danach parallelisierte
   Umsetzung von Prioritaet 2 und 3.

## 12. Production-Readiness-Ergaenzung

### 12.1 Cutover-Strategie (vollstaendige Migration)

1. Phase A - Vorbereiten
   - Vollstaendige Mapping-Liste von alten Worker-Pfaden auf neue Hauptchat-Pfade erstellen.
   - Betroffene UI-Flows und Gateway-Methoden markieren.
2. Phase B - Vollstaendige Implementierung
   - Alle uebernommenen Demo-Funktionen in den Zielpfaden implementieren.
   - Kompatibilitaetsfixes fuer API-Contracts, WS-Events, CLI-Verhalten und Telegram abschliessen.
3. Phase C - Integrationsnachweis
   - Testmatrix aus Abschnitt 12.2 vollstaendig gruen.
   - SLO-Zielwerte aus Abschnitt 9 in Last-/Soak-Tests nachweisen.
4. Phase D - Hard Cutover 100%
   - Worker-Pfade final entfernen.
   - Nur Hauptchat-Runtime bleibt aktiv.

### 12.2 Testmatrix vor Go-Live

1. Funktional
   - WebChat: Send/Stream/Abort
   - Telegram: Webhook, Polling, Pairing, Outbound
   - CLI: lokale Befehlsausfuehrung inkl. Approval-Pfade
2. Nicht-funktional
   - Load-Test (Normal + Peak)
   - Soak-Test (mind. 12h)
   - Failure-Tests (Mem0/DB nicht verfuegbar, Telegram API Fehler, Netzpartitionen)
3. Plattformmatrix
   - Windows (native)
   - WSL2
   - Linux (native)
   - Docker Single-Port

### 12.3 Observability und Alerts

1. Pflichtmetriken
   - `chat.first_token.latency`
   - `chat.request.error_rate`
   - `gateway.ws.connect_success_rate`
   - `telegram.outbound.success_rate`
   - `telegram.polling.http_409_rate`
2. Pflichtalerts
   - SLO-Verletzung > 15 Min.
   - Error-Rate-Spike > 2x Baseline
   - Telegram-Delivery-Drop unter 98%

### 12.4 Go/No-Go-Checkliste

Go nur wenn alle Punkte erfuellt:

1. Alle Akzeptanzkriterien aus Abschnitt 9 sind erfuellt.
2. Vollstaendigkeits-Checklist der Demo-Uebernahme ist 100% erfuellt.
3. Alle Kompatibilitaetsfixes sind geschlossen (keine offenen Blocker).
4. Runbooks sind aktuell und on-call faehig.
5. Produkt, Ops und Engineering haben gemeinsames Go-Commit.

### 12.5 Umsetzungsstand (abgeschlossen)

Stand: 2026-02-19

1. Erledigt: Worker-Hard-Cut und Hauptchat-Fokus.
   - `src/server/worker/*`, `app/api/worker/*`, `src/modules/worker/*` entfernt
   - Worker-RPC im Gateway entfernt (`src/server/gateway/methods/worker.ts` geloescht)
   - Worker-UI-Komponenten und Worker-Navigation entfernt
2. Erledigt: Keine Legacy-Worker-Bridge mehr im Chatpfad.
   - Hauptchat-Dispatch laeuft ueber ModelHub + Gateway-Streaming
   - Worker-spezifische Security-/Tool-Konfigpfade entfernt
3. Erledigt: Uebernahme Telegram Prioritaet 1 (Delivery/Netzwerk-Haertung).
   - Allowed-Updates fuer Webhook/Polling konsolidiert
   - Retry/Backoff fuer Telegram-Outbound (429/5xx/Netzfehler) aktiv
   - Pairing/Polling-Flow robuster und konsistenter
4. Erledigt: Uebernahme Telegram Prioritaet 2 (Bot-UX).
   - Native Commands/Menu integriert (`/model`, Auswahl, Reset)
   - Inline-Model-Buttons inkl. Callback-Handling und Paging integriert
   - Reply-Markup / Callback-Answer / Edit-Message Flows vereinheitlicht
5. Erledigt: Uebernahme Telegram Prioritaet 3 (Media + Gruppenfunktionen).
   - Voice-/Audio- und Media-Inbound-Pfade integriert
   - Sticker-/Media-Hilfslogik integriert
   - Gruppenmigration, Topic-/Thread-Targets und Routing vereinheitlicht
6. Erledigt: Plan-kompatible Test- und Vertragsanpassungen nach Hard-Cut.
   - Pairing/Inbound-Tests auf neuen Conversation-Flow aktualisiert
   - Skills-Registry- und Persistent-Session-Contract auf neuen Hauptchatpfad angepasst
7. Verifikation (gruen):
   - `npm run typecheck`
   - `npm test`
   - Ergebnis: 256 Testdateien bestanden, 1 Testdatei skipped (gesamt 1167 Tests bestanden, 1 skipped)
8. Erledigt: CLI-Uebernahme in Hauptprojekt (kompatibler Runtime-Pfad).
   - Neue CLI-Einstiegspunkte:
     - `src/cli/program.ts`
     - `src/cli/gateway-cli.ts`
     - `src/cli/channels-cli.ts`
     - `src/cli/node-cli.ts`
   - Neue NPM-Skripte:
     - `npm run cli`
     - `npm run cli:gateway`
     - `npm run cli:channels`
     - `npm run cli:node`
9. Erledigt: Exec-Approval/Policy-Stack uebernommen und integriert.
   - `src/server/gateway/exec-approval-manager.ts`
   - `src/server/gateway/method-scopes.ts`
   - `src/server/gateway/node-command-policy.ts`
   - `shell_execute` ist auf den neuen Policy-Stack verdrahtet (optional mit Approval-Gate via Env).
10. Verifikation erweitert (gruen):

- Volltestlauf nach CLI/Policy-Integration:
  - 256 Testdateien bestanden, 1 Testdatei skipped
  - 1167 Tests bestanden, 1 Test skipped
