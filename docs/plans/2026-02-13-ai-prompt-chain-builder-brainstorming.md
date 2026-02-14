# AI Prompt Chain Builder - Brainstorming (UX + Umsetzung)

Datum: 2026-02-13  
Status: Brainstorming-Draft

## 1) Ausgangslage

OpenClaw hat bereits eine funktionierende Model-Pipeline mit Fallback:

- Laufzeit: `ModelHubService.dispatchWithFallback()` in `src/server/model-hub/service.ts`
- Persistenz: `model_hub_pipeline` in SQLite (`src/server/model-hub/repositories/sqliteModelHubRepository.ts`)
- API: `app/api/model-hub/pipeline/route.ts`

Das ist ein starker Startpunkt. Aktuell kann die Pipeline Prioritaet/Fallback, aber noch kein inhaltliches Routing (z. B. Intent -> Modellwahl). Der neue Builder sollte deshalb nicht "alles neu" bauen, sondern bestehende Pipeline-Mechanik erweitern.

## 2) Zielbild (produktseitig)

Der Visual Pipeline Editor soll drei Dinge gleichzeitig leisten:

1. Fuer Einsteiger sofort nutzbar sein (ohne Prompt-Engineering-Wissen).
2. Fuer Power-User flexibel genug sein (Conditionals, Variablen, Memory, Branching).
3. Im Betrieb verlaesslich bleiben (Validierung, Debug-Ansicht, sichere Defaults).

Kernnutzen:

- Qualitaet: Richtige Modelle fuer richtige Aufgaben
- Kosten: Teure Modelle nur bei Bedarf
- Geschwindigkeit: Schnelle Modelle fuer einfache Faelle
- Transparenz: Klar sichtbar, warum eine Antwort so erzeugt wurde

## 3) UX-Leitprinzipien (benutzerfreundlich + robust)

- Progressive Disclosure: Start simpel, dann erweiterte Optionen einblenden.
- Guardrails statt Freitext-Chaos: Vordefinierte Node-Typen mit klaren Feldern.
- Explainability by default: Jede Node zeigt "Input -> Output -> Dauer -> Kosten".
- Fast feedback: Test-Run direkt im Editor, ohne Deployment-Schritt.
- Recoverability: Undo/Redo, Versionen, sichere Draft/Publish-Trennung.
- Fallback-safe: Jeder Flow muss einen gueltigen Fallback-Pfad haben.

## 4) Drei Produktansaetze

### Option A (Empfohlen): Guided Canvas

Canvas mit Node-Editor, aber stark gefuehrt:

- Node-Templates (Trigger, Classifier, Router, Model Call, Memory, Output)
- Wizard fuer neue Flows (Start from template)
- Inline-Validierung je Node
- "Happy path" zuerst, Advanced-Felder einklappbar

Vorteile:

- Geringe Einstiegshuerde
- Gute Balance zwischen Einfachheit und Power
- Niedriges Fehlerrisiko durch Templates

Nachteile:

- Manche Expert-Faelle brauchen zusaetzliche Advanced-Modi

### Option B: No-Code Rule Builder (Form-zentriert)

Kein freier Canvas, sondern regelbasierte Formulare (If/Then-Blasen, Listen).

Vorteile:

- Sehr einfach fuer nicht-technische Nutzer
- Validierung ist leichter

Nachteile:

- Komplexe Flows werden schnell unuebersichtlich
- Weniger "mental model" fuer Graphen/Branches

### Option C: Pro Graph Editor first

Maximal frei von Anfang an (aehnlich LangGraph-IDE).

Vorteile:

- Sehr maechig fuer Power-User

Nachteile:

- Zu steile Lernkurve
- Hoeheres Risiko falscher Konfiguration
- Mehr Support-Aufwand

Empfehlung: Option A. Sie trifft am besten "optimal und benutzerfreundlich".

## 5) Minimal Lovable Scope (MVP)

Fuer eine erste starke Version reichen 6 Node-Typen:

1. Trigger Node

- Quellen: Telegram, WhatsApp, Discord, WebChat, Manual Test

2. Classify Intent Node

- Ausgabe: label + confidence
- Start mit 3-6 festen Labels

3. Condition / Router Node

- Regeln: label == x, confidence >= y, contains keyword

4. Model Call Node

- Waehlt Modell (oder Modellgruppe)
- Optional: temperature, max tokens

5. Memory Enrichment Node

- Holt relevante Facts/Context

6. Reply/Action Node

- Antwort ueber Channel/SSE ausgeben

Wichtiger MVP-Constraint:

- Kein beliebig tiefer Schleifenbau im MVP
- Klare max. Node-Anzahl pro Flow (z. B. 20)
- Deterministische Ausfuehrung ohne Nebenlaeufigkeits-Explosion

## 6) Ziel-Architektur (inkrementell auf Bestand)

### Backend

Neue Domains (vorschlag):

- `src/server/pipelines/`
- `pipelineRepository.ts` (CRUD + versioning)
- `pipelineCompiler.ts` (Graph -> ausfuehrbarer Plan)
- `pipelineExecutor.ts` (Runtime mit tracing)
- `pipelineValidator.ts` (statische Regeln)

Integration in bestehende Runtime:

- `ModelHubService.dispatchWithFallback()` bleibt Fallback-Mechanik
- Neue Routing-Logik entscheidet erst, welcher Model-Call-Node aktiv ist
- Danach normaler Dispatch ueber bestehende ModelHub-Pfade

### API

Neue API-Familie:

- `GET /api/pipelines`
- `POST /api/pipelines`
- `PUT /api/pipelines/{id}`
- `POST /api/pipelines/{id}/validate`
- `POST /api/pipelines/{id}/test-run`
- `POST /api/pipelines/{id}/publish`

Wichtig: Draft und Published strikt trennen.

### Persistenz (SQLite)

Empfohlene Tabellen:

- `pipelines` (id, name, status, created_at, updated_at, published_version)
- `pipeline_versions` (id, pipeline_id, version, graph_json, changelog, created_at)
- `pipeline_runs` (id, pipeline_id, version, trigger_meta, status, started_at, finished_at)
- `pipeline_run_steps` (run_id, node_id, input_json, output_json, duration_ms, cost_usd, error)

## 7) UX-Design fuer den Editor

Layout:

- Links: Node Library (Templates + Search)
- Mitte: Canvas
- Rechts: Properties Panel der selektierten Node
- Unten: Test-Run Console (step-by-step)

Interaktion:

- Drag & drop Nodes
- Verbindungspunkte mit erlaubten Kanten (typed ports)
- Auto-Layout Button
- "Validate" und "Test Run" prominent
- Fehler direkt an Node markieren

Benutzerfreundliche Features:

- Starter-Templates (Support Bot, Code Assistant, Creative Bot)
- "Explain this flow" Button (kurze natuerliche Zusammenfassung)
- "Convert from current fallback pipeline" Migrationshilfe
- Duplicate Flow + Compare Versions

## 8) Fehlerbehandlung und Sicherheit

Statische Validierung vor Publish:

- Keine unverbundenen Pflicht-Nodes
- Mindestens ein Reply/Action-Endpunkt
- Keine unerreichbaren Knoten
- Keine unendlichen Zyklen (MVP: Zyklen komplett blocken)

Runtime-Resilienz:

- Node Timeouts pro Step
- Retry nur fuer sichere Node-Typen
- Circuit breaker fuer instabile Provider
- Harte Obergrenzen fuer Kosten und Laufzeit

Observability:

- Jeder Run bekommt Trace-ID
- Schrittprotokoll in UI einsehbar
- "Warum wurde Modell X gewaehlt?" als maschinenlesbare Decision-Logs

## 9) Messbare Erfolgskriterien

Produktmetriken:

- Time-to-first-working-flow < 10 Minuten
- Publish-Fehlerquote < 5%
- Anteil erfolgreicher Test-Runs > 90%

Qualitaetsmetriken:

- P95 Flow-Ausfuehrung innerhalb Ziel-Latenz
- Regressionen im aktuellen Chat/Worker-Verhalten = 0
- Kein Sicherheitsvorfall durch Pipeline-Exec

Businessmetriken:

- Reduktion teurer Modellaufrufe bei gleichbleibender Antwortqualitaet
- Hoeherer Anteil automatisierter Antworten pro Channel

## 10) Rollout-Plan (realistisch)

Phase 1 (1-2 Wochen):

- Datenmodell + CRUD + Validierung
- Read-only Flow Viewer
- Test-Run API ohne Canvas

Phase 2 (2-3 Wochen):

- Guided Canvas MVP
- 6 Node-Typen
- Draft/Publish + Versioning

Phase 3 (2 Wochen):

- Run Trace UI + Decision Logs
- Templates + Migrationshilfe aus bestehender Pipeline
- Feinschliff UX + Dokumentation

## 11) Offene Entscheidungen fuer das weitere Brainstorming

1. Zielgruppe zuerst:

- A: Einsteiger/Admins
- B: Power-User/Prompt Engineers
- C: Gemischt (mit Guided Mode + Pro Mode)

2. Publish-Strategie:

- A: Sofort aktiv
- B: Manuell aktivieren
- C: Staged rollout (recommended)

3. Routing-Logik im MVP:

- A: Nur Regelbasiert
- B: Regelbasiert + Intent-Klassifikation (recommended)
- C: Voll dynamisch mit Script-Nodes

## 12) Bisher validierte Entscheidungen

### Entscheidung 1: Zielgruppe

Ausgewaehlt: `C` (Gemischt: Guided Mode + Pro Mode)

Konsequenzen fuer das Design:

- Default-UX startet immer im Guided Mode mit Templates und Guardrails.
- Pro Mode wird explizit als Erweiterung freigeschaltet (kein Default).
- Beide Modi nutzen dieselbe Pipeline-Engine und dasselbe Datenmodell.
- In der UI braucht es eine klare Umschaltlogik inkl. Warnhinweis bei Pro-Optionen.
- Validierung bleibt in beiden Modi identisch streng (keine Sonderregeln fuer Pro).

### Entscheidung 2: Publish-Strategie

Ausgewaehlt: `A` (Sofort aktiv)

Konsequenzen fuer das Design:

- Kein separates Go-Live pro Version: Publish schaltet direkt produktiv.
- Vor Publish werden harte Blocking-Checks benoetigt (Validierung muss 100% gruen sein).
- Ein-Klick Rollback auf letzte stabile Version wird zwingend benoetigt.
- Runtime braucht Schutzgrenzen (Timeout-, Kosten- und Fehlerlimits pro Run).
- In der UI wird ein klarer Warnhinweis beim Publish-Button benoetigt.

### Entscheidung 3: Routing-Logik im MVP

Ausgewaehlt: `B` (Regelbasiert + Intent-Klassifikation)

Konsequenzen fuer das Design:

- Routing ist weiterhin deterministisch ueber Regeln steuerbar.
- Vor den Regeln wird ein Intent-Label mit Confidence bestimmt.
- Bei niedriger Confidence greift ein sicherer Fallback-Pfad.
- Decision-Logs muessen Label, Confidence und getroffene Regel speichern.
- Im UI braucht die Classify-Node einfache Defaults (Labels + Confidence-Schwelle).

## 13) Naechste validierte Entscheidung

### Entscheidung 4: Low-Confidence-Fallback

Ausgewaehlt: `3` (Rueckfrage an Nutzer)

Konsequenzen fuer das Design:

- Bei Confidence unter Schwellwert wird keine direkte Modellroute erzwungen.
- Stattdessen erzeugt der Flow eine kurze Klaerungsfrage (2-3 Optionen).
- Nach Nutzerantwort wird das passende Intent-Label gesetzt und normal weitergeroutet.
- Fuer nicht-interaktive Kontexte (z. B. bestimmte Automationslaeufe) braucht es einen Backup-Fallback.
- In Decision-Logs werden Low-Confidence-Event, Rueckfrage und finale Auswahl gespeichert.

### Entscheidung 5: Backup-Fallback (nicht-interaktiv)

Ausgewaehlt: Rueckgriff auf das Base Model im ModelHub

Konsequenzen fuer das Design:

- Wenn keine Rueckfrage moeglich ist, wird direkt das Base Model verwendet.
- Das Base Model muss in der ModelHub-Konfiguration eindeutig markiert sein.
- Fehlt ein Base Model, wird der Run mit klarer Fehlermeldung abgebrochen.
- Decision-Logs muessen den Grund "non-interactive fallback to base model" speichern.

### Entscheidung 6: Guided-Mode-MVP-Umfang (Phase 1)

Ausgewaehlt: `2` (Mittel, inkl. Memory Enrichment)

Konsequenzen fuer das Design:

- Phase 1 enthaelt Trigger, Classify, Router, Model Call, Memory Enrichment und Reply.
- Memory wird als optionaler Node umgesetzt, aber im Guided Mode als empfohlener Standard vorgeschlagen.
- Pipeline-Tests brauchen zusaetzliche Faelle fuer "memory available" und "memory empty".
- Laufzeitgrenzen muessen Memory-Latenz beruecksichtigen (separater Timeout pro Memory-Step).
- UI braucht klare Sichtbarkeit, wann Memory tatsaechlich in die Antwort eingeflossen ist.

### Entscheidung 7: Default-Confidence-Schwelle (Classifier)

Ausgewaehlt: `2` (`0.75`)

Konsequenzen fuer das Design:

- Default-Balance zwischen zu vielen Rueckfragen und Fehlrouting.
- Schwelle bleibt pro Flow konfigurierbar, aber Startwert ist 0.75.
- Monitoring soll Quote "low-confidence prompts" und "misroute corrections" tracken.
- Wenn eine Flow-Metrik stabil schlecht ist, kann die Schwelle gezielt pro Flow angepasst werden.

### Entscheidung 8: Anzahl Default-Intent-Labels (Guided Mode)

Ausgewaehlt: `2` (`5` Labels)

Konsequenzen fuer das Design:

- Gute Balance aus Einfachheit und Routing-Genauigkeit im Alltag.
- Guided Setup bleibt uebersichtlich (kein Label-Overload fuer Einsteiger).
- Default-Templates sollten mit 5 festen Labeln starten und danach editierbar sein.
- Decision-Logs muessen Label-Verteilung pro Flow auswertbar machen.

## Empfehlung fuer den naechsten Schritt

Als naechstes Entscheidung ueber die konkreten 5 Default-Intent-Labels, weil sie direkt bestimmt:

- Routing-Qualitaet im Tagesbetrieb
- Auswahl der Default-Modelle pro Label
- Hoehe der Low-Confidence-Quote
