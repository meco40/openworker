# Rooms System - Verifizierte Maengel & Best-Case-Loesungen

Datum: 2026-02-12  
Stand: Gegen aktuellen Code verifiziert  
Status: Produktionsreif fuer Single-Instance, gezieltes Hardening sinnvoll

---

## Kritisch

### 1. `GET /api/rooms` ohne Fehlerbehandlung

**Datei:** `app/api/rooms/route.ts`

**Befund:** Der `GET`-Handler hat kein `try/catch`.  
**Risiko:** Unbehandelte Exceptions liefern inkonsistente Error-Responses.

**Best-Case-Loesung:**
- Einheitlichen API-Wrapper fuer Auth + Fehlerbehandlung einfuehren (`withAuth`, `handleRouteError`)
- Standard-Envelope fuer Fehler (`{ ok: false, error, code? }`)

---

## Hohe Prioritaet

### 2. Head-of-Line-Blocking durch sequentielle Room-Zyklen

**Datei:** `src/server/rooms/orchestrator.ts`

**Befund:** `for (const room of runningRooms)` verarbeitet Raeume sequentiell.  
**Risiko:** Langsame Provider blockieren schnellere Raeume.

**Best-Case-Loesung:**
- Bounded Parallelism statt strikt sequenziell, z. B. `p-limit` mit konfigurierbarer Parallelitaet
- Weiterhin Lease-Schutz pro Room beibehalten

### 3. Fragile Fehlerklassifizierung per String-Matching

**Dateien:** mehrere Routes unter `app/api/rooms/**`

**Befund:** `message.includes('not found') ? 404 : 500` ist breit genutzt.  
**Risiko:** Brechend bei Message-Aenderungen im Service-Layer.

**Best-Case-Loesung:**
- Typisierte Domain-Errors (`RoomNotFoundError`, `PersonaNotFoundError`, ...)
- Zentrale Error-to-HTTP-Mapping-Funktion

### 4. DRY-Verletzungen in Rooms-API

**Befund:**
- `unauthorized()` mehrfach dupliziert
- Auth-Check + Error-Handling Pattern mehrfach dupliziert

**Best-Case-Loesung:**
- Gemeinsame Helpers in `app/api/rooms/_helpers.ts`
- Optional: Route-Factory fuer Auth-geschuetzte Handler

---

## Mittlere Prioritaet

### 5. Input-Validierung inkonsistent

#### 5.1 `limit` auf API-Ebene nicht begrenzt

**Dateien:**
- `app/api/rooms/[id]/messages/route.ts`
- `app/api/rooms/[id]/interventions/route.ts`

**Befund:** API cappt `limit` nicht aktiv.  
**Wichtig:** Repository cappt bereits intern auf 200 (`src/server/rooms/sqliteRoomRepository.ts`).

**Best-Case-Loesung:**
- API-seitig ebenfalls explizit cappen (z. B. `Math.min(200, ...)`)
- 400 fuer ungueltige/negative Limits

#### 5.2 `turnPriority` unvalidiert

**Datei:** `app/api/rooms/[id]/members/route.ts`

**Befund:** `turnPriority` wird ungeprueft durchgereicht.  
**Risiko:** `NaN`, negative oder nicht-ganzzahlige Werte.

**Best-Case-Loesung:**
- `Number.isInteger && >= 0` validieren
- 400 bei invaliden Werten

#### 5.3 Malformed JSON Bodies landen auf 500

**Dateien:** POST-Routes unter `app/api/rooms/**`

**Befund:** `await request.json()` sitzt im globalen `try/catch`, invalides JSON wird i. d. R. als 500 behandelt.  
**Best-Case-Loesung:** JSON-Parse-Fehler gezielt als 400 antworten.

### 6. Unerreichbarer Branch im Orchestrator

**Datei:** `src/server/rooms/orchestrator.ts`

**Befund:** `gatewayMessages.length === 0` ist praktisch unerreichbar, da vorher immer eine System-Message gepusht wird.

**Best-Case-Loesung:** Branch entfernen oder Bedingung fachlich korrekt neu formulieren.

### 7. Persona-Lookups ohne Request-Cache

**Datei:** `src/server/rooms/orchestrator.ts`

**Befund:** Pro Member erfolgt ein eigener `getPersona`-Lookup.  
**Best-Case-Loesung:** Per-Cycle Cache oder Batch-Lookup.

### 8. Rolling Summary ist nur String-Truncation

**Datei:** `src/server/rooms/orchestrator.ts`

**Befund:** Summary wird durch Aneinanderhaengen + `slice(-1000)` gebildet.  
**Best-Case-Loesung:** Ereignisgesteuerte echte Summarisierung (z. B. alle N Messages) mit strukturiertem Output.

### 9. Message-Upsert bleibt O(n), aber kein Sort-pro-Event mehr

**Datei:** `src/modules/rooms/useRoomSync.ts`

**Befund:**
- Dedupe via `some()` ist O(n)
- Einfuegen via `findIndex()` ist O(n)
- Das fruehere `sort()` pro Event ist nicht mehr vorhanden

**Best-Case-Loesung:** Struktur auf `Map` + geordnete ID/Seq-Indexe umstellen, Re-Sort nur wenn noetig.

### 10. Keine Message-Virtualisierung

**Datei:** `src/modules/rooms/components/RoomDetailPanel.tsx`

**Befund:** Alle Messages werden gleichzeitig gerendert.  
**Best-Case-Loesung:** Virtualisierung (`@tanstack/react-virtual` o. ae.).

### 11. Keine UI-Pagination trotz `beforeSeq`-Backend

**Dateien:** `src/modules/rooms/api.ts`, `src/modules/rooms/components/RoomDetailPanel.tsx`

**Befund:** Initialer Fetch laedt komplett, kein "aeltere laden" Flow.  
**Best-Case-Loesung:** Cursor/`beforeSeq`-basierte Nachlade-Strategie.

### 12. Kein Markdown-Rendering

**Datei:** `src/modules/rooms/components/RoomDetailPanel.tsx`

**Befund:** Message-Content wird als Plain Text gerendert.  
**Best-Case-Loesung:** `react-markdown` + sanitization + begrenzte Feature-Policy.

---

## Test-Qualitaet

### 13. Sehr hohe Test-Ueberlappung (nicht 1:1 identisch)

**Dateien:**
- `tests/unit/rooms/orchestrator-stop-race.test.ts`
- `tests/integration/rooms/rooms-hardening-baseline.test.ts`

**Befund:** Gleicher Repro-Kern, andere Describe/It-Texte.  
**Best-Case-Loesung:** Gemeinsamen Repro-Helper/Fixure extrahieren oder Scope klar trennen.

### 14. Fehlende Negativtests

**Konkrete Luecken:**
- Invalid JSON Body -> 400
- Ungueltige `turnPriority`
- API-Level `limit`-Validierung
- DELETE waehrend `running`/`degraded` inklusive Event-Konsistenz

### 15. Mock-Setup mehrfach kopiert

**Befund:** ModelHub/Persona/Skills-Mocks wiederholen sich in mehreren Orchestrator-Tests.  
**Best-Case-Loesung:** Shared Test-Fixture einziehen (`tests/fixtures/rooms-orchestrator.ts`).

---

## Sicherheit

### 16. Keine HTTP Rate Limits fuer Rooms-REST

**Befund:** WebSocket hat Verbindungsgrenze, Rooms-HTTP-Routen haben keine dedizierten Rate-Limits.  
**Best-Case-Loesung:** Middleware-basiertes Rate-Limiting pro User/IP + Route-Klassen.

### 17. Tool-Permissions nicht room-scoped

**Datei:** `src/server/rooms/types.ts`

**Befund:** Permissions sind global pro Persona (`PersonaPermissions`), nicht pro Room-Member.  
**Best-Case-Loesung:** Permissions an Membership koppeln (`room_id + persona_id`).

---

## Fehlende Features

### 18. Kein `PATCH/PUT /api/rooms/[id]`

**Befund:** Room-Metadaten nach Erstellung nicht editierbar.  
**Best-Case-Loesung:** Partielles Update mit Whitelist-Feldern und Validierung.

### 19. Kein dediziertes `GET /api/rooms/[id]/members`

**Befund:** Members sind nur indirekt ueber `state` sichtbar.  
**Best-Case-Loesung:** Eigene GET-Route fuer klaren API-Contract.

### 20. Kein Token-Streaming der Persona-Antworten

**Befund:** Antwort erst nach kompletter Modellantwort sichtbar.  
**Best-Case-Loesung:** Streaming ueber WS/SSE mit partiellen Chunks und finalem Persist-Commit.

---

## Skalierbarkeits-Limits

### 21. SQLite als Single-Instance-Limit

**Befund:** Solide lokal/single node, limitiert fuer horizontale Skalierung und hohe Schreiblast.

**Best-Case-Loesung:** PostgreSQL + migrations + connection pooling + idempotente write paths.

### 22. Kein dediziertes Queue/Worker-Modell fuer Rooms-Orchestrierung

**Befund:** Timer-basierter Scheduler in `server.ts`/`scheduler.ts`, keine echte Job-Orchestrierung pro Room.

**Best-Case-Loesung:** Queue-basiertes Scheduling (z. B. BullMQ/Redis), retry/backoff, dead-letter.

---

## Aus der alten Analyse korrigiert

- "`limit` komplett unbounded" war zu hart formuliert: intern wird bereits auf 200 gecappt.
- "`useRoomSync` sortiert jedes Event" ist veraltet: aktueller Code sortiert nicht pro Event.
- "Duplizierter Test identisch" praezisiert: stark ueberlappend, aber nicht 1:1 identisch.
- Abschlussliste mit `✅` als "bereits erledigt" entfernt, da diese Punkte im Code nicht vollstaendig umgesetzt sind.

---

## Priorisierter Best-Case-Fixplan

1. API-Hardening in einem Schritt: zentraler Auth/Error-Wrapper, typed errors, JSON/limit/turnPriority-Validierung.  
2. Orchestrator-Performance in einem Schritt: bounded concurrency + persona cache + dead-code cleanup.  
3. UX/Frontend in einem Schritt: pagination + virtualisierung + markdown rendering.  
4. Security/Operations in einem Schritt: HTTP rate limits + room-scoped permissions + observability fuer slow rooms.
