# Agent Room — Vollständige Analyse (2026-02-26)

> **Scope:** Frontend (`src/modules/agent-room/`, 29 Dateien, ~3.450 LOC) + Backend (`src/server/agent-room/`, 14 Dateien, ~1.095 LOC) + Gateway-Methoden (`agent-v2.ts`, ~320 LOC swarm-bezogen) + Tests (11 Dateien, 59 Tests)

---

## Inhaltsverzeichnis

1. [A — Architektur & Code-Qualität](#a--architektur--code-qualität)
2. [B — Fehlerhafte / Schwache Implementierungen](#b--fehlerhafte--schwache-implementierungen)
3. [C — Fehlende Features mit Mehrwert](#c--fehlende-features-mit-mehrwert)
4. [D — UX-Verbesserungen](#d--ux-verbesserungen)
5. [E — Test-Lücken](#e--test-lücken)
6. [Priorisierte Empfehlung](#priorisierte-empfehlung)

---

## A — Architektur & Code-Qualität

### A1 — `useAgentRoomRuntime.ts` ist immer noch zu groß (593 LOC)

**Problem:** Der Hook vereint weiterhin 15+ Callbacks in einer Datei: CRUD-Operationen (`createSwarm`, `deploySwarm`, `deleteSwarm`, `abortSwarm`), Steuerung (`steerSwarm`, `forceNextPhase`, `forceComplete`), Export (`exportRunJson`), Session-Mapping (`lookupSwarmBySessionId`), WebSocket-Lifecycle und Event-Handling.

**Auswirkung:** Schwer testbar, schwer reviewbar, jede Änderung risikiert Seiteneffekte.

**Empfehlung:** Aufteilen in:

- `useSwarmConnection.ts` (~80 LOC) — WebSocket-Lifecycle, `clientRef`, Event-Subscriptions
- `useSwarmActions.ts` (~150 LOC) — `createSwarm`, `deploySwarm`, `abortSwarm`, `deleteSwarm`, `syncSwarm`
- `useSwarmControls.ts` (~80 LOC) — `steerSwarm`, `forceNextPhase`, `forceComplete`, `addSwarmUnit`
- `useSwarmExport.ts` (~40 LOC) — `exportRunJson`
- `useAgentRoomRuntime.ts` (~100 LOC) — Thin Compositor, der die anderen kombiniert

**Schwere:** Mittel | **Aufwand:** ~2h

---

### A2 — `orchestrator.ts` hat zu viele Verantwortlichkeiten (456 LOC)

**Problem:** Enthält: `runOrchestratorOnce` (Top-Level-Loop), `processSwarmTick`, `dispatchNextTurn` (~80 LOC), `checkTurnCompletion` (~120 LOC), `resolveSwarmUnits`, `resolveSpeakerPersonaId`, `findCompletionEvent`, `extractCompletedText`. Mischung aus Orchestrierung, Turn-Dispatch, Completion-Handling und Persona-Resolution.

**Auswirkung:** Schwer testbar ohne umfangreiche Mocks, schwer änderbares Turn-Management.

**Empfehlung:** Aufteilen in:

- `orchestrator.ts` (~80 LOC) — Thin Loop: `runOrchestratorOnce` → delegates to services
- `turnDispatch.service.ts` (~100 LOC) — `dispatchNextTurn`, Session-Management
- `turnCompletion.service.ts` (~120 LOC) — `checkTurnCompletion`, Event-Auswertung, Artifact-Update
- `swarmResolution.service.ts` (~60 LOC) — `resolveSwarmUnits`, `resolveSpeakerPersonaId`

**Schwere:** Mittel | **Aufwand:** ~3h

---

### A3 — Duplizierte Typ-Definitionen zwischen Frontend und Backend

**Problem:** `SwarmFriction` existiert in 3 Varianten:

1. `src/modules/agent-room/swarmTypes.ts` → `SwarmFriction` (Frontend)
2. `src/server/agent-room/types/index.ts` → `SwarmFriction` (Backend)
3. `src/server/channels/messages/repository.ts` → `AgentRoomSwarmFriction` (Repository-Interface)

Ebenso: `SwarmUnit` / `AgentRoomSwarmUnit`, `SwarmStatus` / `AgentRoomSwarmStatus`, `SwarmPhase` / `AgentRoomSwarmPhase`.

**Auswirkung:** Inkonsistenzen bei Typänderungen, Refactoring-Risiko (siehe PhaseBufferEntry-Update, das 9 Dateien anfasste).

**Empfehlung:** Canonical Types in `src/shared/domain/agentRoom.types.ts` definieren. Frontend und Backend importieren von dort. Repository-Interface re-exportiert.

**Schwere:** Hoch | **Aufwand:** ~2h

---

### A4 — `swarmPhases.ts` mischt Frontend und Backend Concerns

**Problem:** `swarmPhases.ts` (133 LOC) im Frontend-Modul enthält sowohl UI-Labels (`PHASE_LABELS`) als auch Business-Logic (`getPhaseRounds`, `buildAgentTurnPrompt`, `buildPhasePrompt`). Das Backend importiert direkt aus `@/modules/agent-room/swarmPhases`, was die Dependency-Richtung verletzt (`src/server/` → `src/modules/`).

**Auswirkung:** Zirkuläre Abhängigkeitsgefahr, erschwert Tree-Shaking für den Server-Bundle.

**Empfehlung:**

- Phase-Konstanten + Business-Logic → `src/shared/domain/swarmPhases.ts`
- UI-Labels + Prompt-Builder (Deutsch) → bleiben in `src/modules/agent-room/`
- Server importiert nur aus `src/shared/`

**Schwere:** Mittel | **Aufwand:** ~1.5h

---

### A5 — Deprecated `simpleLoop.ts` Re-Export Bridge

**Problem:** `simpleLoop.ts` (23 LOC) existiert nur als `@deprecated` Re-Export-Brücke für `prompt/`. Der Import-Pfad `@/server/agent-room/simpleLoop` wird immer noch in Tests benutzt.

**Auswirkung:** Toter Code, verwirrend für neue Contributor.

**Empfehlung:** Tests auf `@/server/agent-room/prompt` umstellen, `simpleLoop.ts` löschen.

**Schwere:** Niedrig | **Aufwand:** ~15min

---

### A6 — `swarmOrchestratorState.ts` und `swarmViewState.ts` sind Waisen

**Problem:** `swarmOrchestratorState.ts` (18 LOC) und `swarmViewState.ts` (18 LOC) definieren Interfaces und Type Guards, die nirgends importiert werden:

- `buildSwarmProjectionPatch()` wird nicht aufgerufen
- `SWARM_LAYOUT_MODES`, `SWARM_OUTPUT_TABS` werden nicht genutzt

**Auswirkung:** Toter Code, verwirrt die Codestruktur.

**Empfehlung:** Löschen oder in aktive Nutzung integrieren.

**Schwere:** Niedrig | **Aufwand:** ~10min

---

### A7 — `services/` Ordner im Frontend ist leer

**Problem:** `src/modules/agent-room/services/` existiert als leerer Ordner. Die geplante Extraktion der Gateway-API-Calls in `swarmApi.service.ts` wurde nie umgesetzt.

**Auswirkung:** Alle `client.request()` Calls sind in den Hooks verstreut, kein zentraler API-Layer.

**Empfehlung:** API-Service-Layer implementieren wie im Modularisierungsplan vorgesehen.

**Schwere:** Mittel | **Aufwand:** ~1.5h

---

## B — Fehlerhafte / Schwache Implementierungen

### B1 — Speaker-Selection ist rein Round-Robin, ignoriert Kontext

**Problem:** `chooseNextSpeakerPersonaId()` macht simples `turnCount % orderedPersonaIds.length`. Es gibt keinerlei Berücksichtigung von:

- Welcher Agent gerade kontextuell relevant ist
- Ob ein Agent zum aktuellen Thema etwas beitragen kann
- Ob ein Agent bereits mehrfach hintereinander gesprochen hat (wenn Units < 3)

**Auswirkung:** Bei 2 Agenten entsteht immer ping-pong. Bei 4+ Agenten sprechen Experten zum falschen Zeitpunkt.

**Empfehlung:** Erweiterte Speaker-Selection mit:

1. Rollenbasierte Gewichtung nach Phase (z.B. "Critic" bekommt in `critique` Phase Vorrang)
2. Optional: Agent kann "pass" signalisieren wenn kein Beitrag
3. Lead spricht immer als Letzter in der `result` Phase

**Schwere:** Hoch | **Aufwand:** ~3h

---

### B2 — Conflict Radar ist keyword-basiert und naiv

**Problem:** `deriveConflictRadar()` nutzt 5 Regex-Pattern mit festen deutschen und englischen Keywords (`doubt`, `risk`, `conflict`, `fatal`). Scoring: `riskHits * 25 + severeHits * 35`.

**Auswirkung:**

- False Positives: Jeder Text, der "risk" im sachlichen Kontext erwähnt, erhöht den Score
- False Negatives: Subtile Widersprüche ("A sagt X, B sagt nicht-X") werden nicht erkannt
- Kein temporaler Kontext: Score steigt nur, sinkt nie
- `hold: false` ist hardcoded — Friction kann nie automatisch den Swarm pausieren

**Empfehlung:**

1. Kurzfristig: Score-Reset bei Phasenwechsel, `hold: true` ab Score >80
2. Mittelfristig: LLM-basierte Friction-Analyse als optionaler Meta-Agent
3. Semantic Overlap Detection: Vergleich der Positionen verschiedener Agenten

**Schwere:** Mittel | **Aufwand:** ~4h (kurzfristig), ~2 Tage (LLM-basiert)

---

### B3 — Kein Retry-Mechanismus für fehlgeschlagene Turns

**Problem:** Wenn ein Agent-Turn fehlschlägt (API-Error, Timeout), setzt der Orchestrator den Status auf `error` + `holdFlag: true`. Der Benutzer muss manuell "Resume" klicken. Rate-Limits werden zwar erkannt (`will retry next tick`), aber andere transiente Fehler nicht.

**Auswirkung:** Swarms brechen bei transienten Fehlern ab, erfordern manuelle Intervention.

**Empfehlung:**

- Automatisches Retry (max 3x, exponential backoff) für transiente Fehler
- Nur nach 3 Fehlversuchen → `status: 'error'`
- Rate-Limit: `retryAfterMs` aus Error-Response nutzen statt blind nächster Tick

**Schwere:** Hoch | **Aufwand:** ~2h

---

### B4 — Artifact ist Plain-Text, nicht strukturiert

**Problem:** Das Artifact ist ein Markdown-String mit `**[Name]:**` Turn-Markern und `--- Phase Label ---` Dividers. Parsing geschieht via Regex an 6+ Stellen im Code.

**Auswirkung:**

- Fragil: Wenn ein Agent `**[Name]:**` im Text verwendet, bricht das Parsing
- Keine Metadaten pro Turn (Timestamp, Phase, Token-Count, Confidence)
- Kein Diff zwischen Turns (History speichert nur vollständige Snapshots)
- Export enthält rohen Markdown statt strukturierter Daten

**Empfehlung:** Strukturiertes Artifact-Format:

```typescript
interface StructuredArtifact {
  turns: Array<{
    id: string;
    phase: SwarmPhase;
    speakerPersonaId: string;
    speakerName: string;
    content: string;
    timestamp: string;
    tokenCount?: number;
    voteDelta?: number;
  }>;
  phaseTransitions: Array<{ from: SwarmPhase; to: SwarmPhase; afterTurnId: string }>;
}
```

Rendering zu Markdown nur noch in der View-Schicht. Backward-Compat: `parseArtifactSections()` wird Fallback-Parser für Legacy-Daten.

**Schwere:** Hoch | **Aufwand:** ~1 Tag

---

### B5 — `useEffect` ohne Dependency-Array für Event-Wiring

**Problem:** In `AgentRoomView.tsx` Zeile 28–78: `useEffect(() => { runtime.onAgentEventRef.current = ... })` hat **kein Dependency-Array** — läuft bei jedem Render. Das Ref-Pattern funktioniert, ist aber:

1. Ein Anti-Pattern (unnötige Zuweisungen pro Render)
2. Nicht offensichtlich korrekt — Leser vermuten Missing-Dependencies-Bug

**Auswirkung:** Performance-Overhead, Code-Verwirrung.

**Empfehlung:** Explizit `[]` Dependency-Array setzen (Ref-Zuweisung ist stabil) oder zu einer dedizierten Wiring-Funktion refactorn.

**Schwere:** Niedrig | **Aufwand:** ~10min

---

### B6 — `NewSwarmModal` erstellt Swarm, aber deployed nicht automatisch

**Problem:** Der "Deploy Agents" Button in `NewSwarmModal` ruft nur `runtime.createSwarm()` auf. Der Swarm wird im Status `idle` erstellt. Der Benutzer muss dann in der Sidebar manuell "Start" klicken.

**Auswirkung:** Verwirrende UX — Button heißt "Deploy Agents" aber deployed nicht wirklich.

**Empfehlung:** Nach `createSwarm()` automatisch `deploySwarm()` aufrufen. Oder Button umbenennen zu "Create Swarm".

**Schwere:** Niedrig | **Aufwand:** ~15min

---

### B7 — Keine Validierung der `pauseBetweenPhases` Funktionalität

**Problem:** Das Flag `pauseBetweenPhases` wird in der DB gespeichert und in der UI angeboten, aber der Orchestrator prüft es nirgends. Phasen-Transitionen in `checkTurnCompletion()` pausieren nie, unabhängig vom Flag-Wert.

**Auswirkung:** Feature ist fake — das Checkbox tut nichts.

**Empfehlung:** In `checkTurnCompletion` implementieren: wenn `phaseResult.phaseComplete && swarm.pauseBetweenPhases`, Status auf `hold` setzen statt automatisch zur nächsten Phase weiterzugehen.

**Schwere:** Hoch | **Aufwand:** ~30min

---

### B8 — `searchEnabled` hat keinen Effekt

**Problem:** Wie `pauseBetweenPhases` wird auch `searchEnabled` in der DB gespeichert, aber nirgends evaluiert. Weder der Orchestrator noch der Prompt-Builder berücksichtigen es.

**Auswirkung:** Feature-Fake, irreführendes UI-Element.

**Empfehlung:** Web-Search-Skill in Prompts aktivieren wenn `searchEnabled`.

**Schwere:** Mittel | **Aufwand:** ~2h (implementieren) oder ~10min (entfernen)

---

### B9 — Consensus-Score wächst unbegrenzt, wird nie zurückgesetzt

**Problem:** `consensusScore` wird bei jedem Turn um `+8` (VOTE:UP) oder `-12` (VOTE:DOWN) modifiziert und dann auf `[0, 100]` geclamped. Aber:

1. Agenten generieren selten explizite `[VOTE:UP/DOWN]`-Tags
2. Score wird nie bei Phasenwechsel zurückgesetzt
3. Kein Threshold-basiertes Verhalten (z.B. "Pause wenn Score < 20")

**Auswirkung:** Feature ist praktisch wirkungslos, da Agenten die Tags fast nie ausgeben.

**Empfehlung:**

1. Score automatisch berechnen basierend auf Textanalyse (Agreement/Disagreement)
2. Phase-Reset des Scores bei Transition
3. Threshold-basierte Aktionen (z.B. Friction-Hold bei Score < 20)

**Schwere:** Mittel | **Aufwand:** ~3h

---

## C — Fehlende Features mit Mehrwert

### C1 — Swarm Templates mit vordefinierten Rollen

**Problem:** Templates definieren aktuell nur `title` und `task`. Rollen werden nicht vordefiniert — der Benutzer muss bei jedem Swarm manuell die passenden Personas auswählen und deren Rollen zuweisen.

**Mehrwert:** Schnelleres Setup, bessere Ergebnisqualität durch optimale Rollenverteilung.

**Empfehlung:** Templates mit `suggestedRoles`:

```typescript
interface SwarmTemplate {
  id: string;
  label: string;
  title: string;
  task: string;
  suggestedRoles: Array<{
    role: string;
    description: string;
    autoAssignTag?: string; // e.g. 'expertise:architecture'
  }>;
  phaseTuning?: Partial<Record<SwarmPhase, { rounds: number; guidance: string }>>;
}
```

**Aufwand:** ~3h

---

### C2 — Operator kann einzelne Agenten gezielt ansprechen (Targeted Steering)

**Problem:** `steerSwarm()` sendet aktuell `[OPERATOR GUIDANCE]` als Follow-Up in die laufende Session. Es gibt keinen Mechanismus, um einen bestimmten Agenten gezielt anzuweisen (z.B. "Nova, geh tiefer auf Security ein").

**Mehrwert:** Feinere Kontrolle über den Swarm-Verlauf, bessere Ergebnisse.

**Empfehlung:**

- Frontend: `@mention` in `UserChatInput` ist bereits implementiert, wird aber nur als String gesendet
- Backend: Wenn `@PersonaName` erkannt wird, den Guidance-Text als nächsten Turn des genannten Agenten priorisieren (Speaker-Override für den nächsten Tick)

**Aufwand:** ~3h

---

### C3 — Phase-Zusammenfassung am Ende jeder Phase

**Problem:** Beim Phasenwechsel wird nur ein Marker (`--- Phase Label ---`) eingefügt. Es gibt keine Zusammenfassung dessen, was in der Phase erarbeitet wurde.

**Mehrwert:**

- Agenten in der nächsten Phase haben komprimierten Kontext
- Benutzer kann schnell den Status jeder Phase erfassen
- Reduziert Token-Verbrauch in späteren Phasen

**Empfehlung:** Nach Phasen-Completion einen "Synthese-Turn" durch den Lead-Agent:

1. Lead bekommt Prompt: "Fasse die Ergebnisse der [Phase] Phase zusammen"
2. Zusammenfassung wird als `--- [Phase] Summary ---` Block eingefügt
3. Nachfolgende Phasen erhalten nur die Summary statt aller einzelnen Turns

**Aufwand:** ~4h

---

### C4 — Swarm-Forking (Parallele Lösungspfade)

**Problem:** Ein Swarm hat immer nur einen linearen Pfad: analysis → ideation → critique → best_case → result.

**Mehrwert:** Bei kontroversen Themen könnte der Swarm nach `ideation` in 2+ parallele "best_case"-Pfade forken, die unabhängig evaluiert werden.

**Empfehlung:**

- Fork-Button im UI: "Explore Alternative Path"
- Backend: Fork erstellt Klon mit eigenem Artifact ab Fork-Point
- Merge-Phase: Vergleich der Fork-Ergebnisse

**Aufwand:** ~2 Tage

---

### C5 — Echtzeit-Fortschrittsanzeige und Token-Tracking

**Problem:** Der Benutzer sieht nur den aktuellen Phase-Indikator und den Streaming-Text. Es gibt keine Information über:

- Wie viele Turns noch in der Phase kommen
- Token-Verbrauch pro Turn/Phase/Swarm
- Geschätzte Restzeit

**Mehrwert:** Transparenz, Kostenkontrolle, bessere Erwartungen.

**Empfehlung:**

- Phase-Progress: `Turn 3/6 in Ideation` im ChatHeader
- Token-Counter: Server tracked Token-Count pro Turn, sendet im Broadcast mit
- Geschätzte Restzeit basierend auf avg. Turn-Duration

**Aufwand:** ~4h

---

### C6 — Swarm-Persistenz und Wiederaufnahme (Resume After Restart)

**Problem:** Bei Server-Restart gehen laufende Swarms verloren. Der `processing` Set ist in-memory, `currentDeployCommandId` zeigt auf eine nicht mehr existierende Agent-Session.

**Mehrwert:** Robustheit, kein Datenverlust bei Deployments.

**Empfehlung:**

- Beim Start: Alle Swarms mit `status: 'running'` auf `hold` setzen
- Recovery-Check: Wenn `currentDeployCommandId` vorhanden, Session-Status prüfen
- Automatisches Resume nach Recovery-Check

**Aufwand:** ~2h

---

### C7 — Voting-Mechanismus für den Benutzer

**Problem:** Der Benutzer kann nur passiv den Swarm beobachten oder via Operator-Guidance eingreifen. Es gibt keine Möglichkeit, explizit für einen Lösungsansatz zu stimmen.

**Mehrwert:** Benutzer steuert Richtung, Agents berücksichtigen User-Präferenz.

**Empfehlung:**

- Thumbs-Up/Down Buttons pro Agent-Turn in der Chat-Feed
- Vote wird als `[OPERATOR_VOTE:UP/DOWN for Turn X]` in den nächsten Prompt eingefügt
- Agents werden instruiert, Operator-Votes stark zu gewichten

**Aufwand:** ~4h

---

### C8 — Markdown-Rendering im Chat-Feed

**Problem:** Agent-Turns werden als Plain-Text in `<p>` gerendert (`SwarmChatFeed.tsx`). Markdown-Formatierung (Bold, Listen, Code-Blöcke, Mermaid) wird nicht gerendert.

**Mehrwert:** Deutlich bessere Lesbarkeit, Agents nutzen bereits Markdown in ihren Responses.

**Empfehlung:** React-Markdown-Renderer mit Mermaid-Support integrieren (wie im Rest der App bereits vorhanden).

**Aufwand:** ~2h

---

### C9 — Export als PDF / Presentation

**Problem:** Export ist nur als raw JSON möglich. Kein visuell aufbereitetes Exportformat.

**Mehrwert:** Ergebnisse direkt in Meetings/Reports nutzbar.

**Empfehlung:**

- PDF-Export mit Phasen-Kapiteln, Agent-Avataren, Diagrammen
- Alternativ: Markdown-Export mit frontmatter (einfacher, schneller)

**Aufwand:** ~4h (Markdown), ~1 Tag (PDF)

---

### C10 — Multi-Swarm Orchestrierung (Swarm of Swarms)

**Problem:** Jeder Swarm arbeitet isoliert. Komplexe Projekte erfordern, dass Ergebnisse eines Swarms in einen nächsten einfließen.

**Mehrwert:** Komplex-Projekte können in vernetzte Sub-Swarms aufgeteilt werden.

**Empfehlung:**

- Swarm-Chaining: Output von Swarm A wird Input (Task) von Swarm B
- DAG-basierte Orchestrierung mit Abhängigkeiten
- Visualisierung als Swarm-Pipeline

**Aufwand:** ~3 Tage

---

## D — UX-Verbesserungen

### D1 — Artifact-Tab zeigt nur Plain-Text

**Problem:** `ArtifactTab.tsx` (13 LOC) ist eine `<pre>` mit dem rohen Artifact-String. Kein Syntax-Highlighting, kein Markdown-Rendering, kein Copy-Button.

**Empfehlung:** Markdown-Renderer mit Copy-Button, collapsible Phase-Sections, Mermaid-Rendering.

**Aufwand:** ~2h

---

### D2 — History-Tab hat kein Diff-View

**Problem:** `HistoryTab.tsx` zeigt Snapshots als `<details>` Accordions. Kein visueller Diff zwischen Versionen.

**Empfehlung:** Inline-Diff-Anzeige (added/removed Highlighting) zwischen aufeinanderfolgenden Snapshots.

**Aufwand:** ~3h

---

### D4 — Sidebar zeigt keine Swarm-Statistiken

**Problem:** Sidebar zeigt nur Titel, Status und Phase. Keine Turn-Anzahl, Dauer, Agent-Beteiligung.

**Empfehlung:** Swarm-Karte erweitern: `Turn 12/40 · 3 Agents · 5min`

**Aufwand:** ~1h

---

### D5 — Kein Confirmation-Dialog für destruktive Aktionen

**Problem:** "Delete Swarm" und "Abort" haben keine Bestätigung.

**Empfehlung:** Confirmation-Dialog oder "Undo"-Toast nach Löschung.

**Aufwand:** ~30min

---

## E — Test-Lücken

### E1 — Keine Tests für `orchestrator.ts` (456 LOC, 0 Tests)

**Problem:** Der wichtigste Backend-Code — `runOrchestratorOnce`, `dispatchNextTurn`, `checkTurnCompletion` — hat keine Unit-Tests. Erfordert umfangreiche Mocks (MessageRepository, AgentV2SessionManager, MessageService, PersonaRepository).

**Empfehlung:** Mindestens 15 Tests:

- `dispatchNextTurn`: Session-Erstellung, Follow-Up, Buffer-Update, Broadcast
- `checkTurnCompletion`: Erfolgreicher Turn, Error-Turn, Phase-Transition, Completion
- `runOrchestratorOnce`: Rate-Limit-Handling, Error-Handling, Multi-Swarm

**Schwere:** Hoch | **Aufwand:** ~4h

---

### E2 — Keine Tests für Gateway-Methoden (swarm CRUD)

**Problem:** `agent-v2.ts` swarm-bezogene Methoden (create, update, deploy, delete) haben keine Tests. Besonders die neue Server-Only-Field-Guard für `swarm.update` ist ungetestet.

**Empfehlung:** Contract-Tests für jeden Endpoint.

**Aufwand:** ~3h

---

### E3 — Keine Tests für `conflictRadar.service.ts`

**Problem:** Die Friction-Berechnung hat keine Tests für Edge-Cases (leerer Text, mehrere Severe-Hits, Phasen-Marker-Isolation).

**Aufwand:** ~1h

---

### E4 — Keine Tests für `swarmArtifact.service.ts`

**Problem:** `buildArtifactWithNewTurn`, `pushArtifactSnapshot`, `clampConsensusScore` sind ungetestet (obwohl `artifact-phase-markers.test.ts` einige indirekt abdeckt).

**Aufwand:** ~1h

---

### E5 — Frontend-Hooks komplett ungetestet

**Problem:** `useAgentRoomRuntime`, `useSwarmMessages`, `useSwarmCatalogState` — 0 Tests. Dies sind kritische State-Management-Hooks.

**Aufwand:** ~6h (mit React Testing Library / `@testing-library/react-hooks`)

---

## Priorisierte Empfehlung

### Sofort (Quick Wins, < 30min jeweils)

| #   | Item                                                  | Typ     |
| --- | ----------------------------------------------------- | ------- |
| 1   | **B7** `pauseBetweenPhases` implementieren            | Bugfix  |
| 2   | **B6** Auto-Deploy nach Create oder Button umbenennen | UX      |
| 3   | **B5** `useEffect` Dependency-Array fixen             | Cleanup |
| 4   | **A5** `simpleLoop.ts` entfernen                      | Cleanup |
| 5   | **A6** Waisen-Dateien entfernen                       | Cleanup |
| 6   | **D5** Confirmation-Dialoge                           | UX      |

### Kurzfristig (1-4h)

| #   | Item                                                 | Typ        |
| --- | ---------------------------------------------------- | ---------- |
| 7   | **B3** Auto-Retry für transiente Fehler              | Robustheit |
| 8   | **C5** Turn-Progress und Token-Tracking              | Feature    |
| 9   | **C8** Markdown-Rendering im Chat                    | UX         |
| 10  | **B8** `searchEnabled` implementieren oder entfernen | Cleanup    |
| 11  | **E3+E4** Tests für Services                         | Qualität   |
| 12  | **C6** Resume nach Server-Restart                    | Robustheit |
| 13  | **D1** Artifact-Tab mit Markdown-Rendering           | UX         |

### Mittelfristig (1-2 Tage)

| #   | Item                                    | Typ         |
| --- | --------------------------------------- | ----------- |
| 14  | **A1** `useAgentRoomRuntime` splitten   | Architektur |
| 15  | **A2** `orchestrator.ts` splitten       | Architektur |
| 16  | **A3** Shared Types konsolidieren       | Architektur |
| 17  | **B4** Strukturiertes Artifact-Format   | Architektur |
| 18  | **B1** Intelligentere Speaker-Selection | Feature     |
| 19  | **C3** Phase-Zusammenfassungen          | Feature     |
| 20  | **E1** Orchestrator-Tests               | Qualität    |
| 21  | **C2** Targeted Agent Steering          | Feature     |

### Langfristig (1+ Woche)

| #   | Item                                 | Typ     |
| --- | ------------------------------------ | ------- |
| 22  | **C4** Swarm-Forking                 | Feature |
| 23  | **C10** Swarm-of-Swarms              | Feature |
| 24  | **B2** LLM-basierte Friction-Analyse | Feature |
| 25  | **C9** PDF/Presentation Export       | Feature |

---

## Metriken

| Kategorie                     | Anzahl Dateien | LOC        | Tests                          | Test-Coverage                                       |
| ----------------------------- | -------------- | ---------- | ------------------------------ | --------------------------------------------------- |
| Frontend (modules/agent-room) | 29             | ~3.450     | 0 direkte Hook/Component-Tests | ~0%                                                 |
| Backend (server/agent-room)   | 14             | ~1.095     | 59 (11 Dateien)                | ~55% (Services+Prompt getestet, Orchestrator nicht) |
| Gateway (agent-v2.ts swarm)   | 1 (Teil)       | ~320       | 0                              | 0%                                                  |
| **Gesamt**                    | **44**         | **~4.865** | **59**                         | **~30% geschätzt**                                  |
