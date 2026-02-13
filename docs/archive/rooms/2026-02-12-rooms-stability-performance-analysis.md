# Rooms System Analyse: Stabilitaet und Performance

Datum: 2026-02-12
Scope: aktueller Implementierungsstand von Rooms-Orchestrator, Scheduler, Repository, API und WebSocket-Sync.

## Ergebnis

Der Aufbau ist solide, aber nicht Best-Case fuer Stabilitaet und Performance.
Die urspruengliche Analyse war groesstenteils korrekt; ein Punkt war ueberzeichnet und wurde praezisiert.

## Implementierungsstatus (Update: 2026-02-12)

Umgesetzte Hardening-Massnahmen:

1. Reentrancy-Guard in `RoomOrchestrator.runOnce()`.
2. Runtime-Rollensteuerung via `ROOMS_RUNNER` (web/scheduler/both) + Compose-Default auf `scheduler`.
3. Stop-Race-Schutz: `stopped` wird nicht mehr auf `degraded` ueberschrieben.
4. Lease-Keepalive waehrend langem Dispatch inkl. Abort bei Lease-Verlust.
5. Atomischer Sequenz-Allocator via `room_message_sequences` statt `MAX(seq)+1`.
6. Korrekte `createdMessages`-Zaehllogik.
7. Harte `beforeSeq`-Validierung auf API-Grenze (400 bei invaliden Werten).

## Validierte Findings (nach Schweregrad)

1. Kritisch (teilweise korrigiert): Re-entrant Orchestrator-Laeufe sind moeglich.
   - Es gibt keinen In-Process-Guard gegen ueberlappende `runOnce()`-Ausfuehrungen.
   - `acquireRoomLease()` blockiert nur fremde Owner, nicht dieselbe Instanz (`src/server/rooms/sqliteRoomRepository.ts:679`).
   - Praezisierung: Die Aussage "zwei Scheduler bedeuten automatisch Doppelverarbeitung" war zu pauschal. Cross-process wird meist durch Lease begrenzt; das Kernrisiko ist Reentrancy innerhalb einer Instanz.
   - Referenzen: `server.ts:112`, `scheduler.ts:50`, `src/server/rooms/sqliteRoomRepository.ts:679`.

2. Hoch (neu): Stop-Race kann Run-State falsch auf `degraded` setzen.
   - User stoppt Room via `closeActiveRoomRun(..., 'stopped')` (`src/server/rooms/service.ts:171`).
   - Ein parallel laufender Turn kann danach beim Heartbeat fehlschlagen (`src/server/rooms/orchestrator.ts:457`), in `catch` landen und erneut auf `degraded` setzen (`src/server/rooms/orchestrator.ts:461`).
   - Ergebnis: Inkonsistenter finaler Status trotz manuellem Stop.

3. Hoch (korrekt): Lease kann bei langen Model-Calls auslaufen.
   - Heartbeat erfolgt vor und nach Turn (`src/server/rooms/orchestrator.ts:82`, `src/server/rooms/orchestrator.ts:457`).
   - Waehrend `dispatchWithFallback` (`src/server/rooms/orchestrator.ts:295`) gibt es keinen Heartbeat.

4. Hoch (praezisiert): Sequenzvergabe in `room_messages` ist race-anfaellig.
   - `appendMessage()` verwendet `MAX(seq)+1` in App-Logik (`src/server/rooms/sqliteRoomRepository.ts:540`, `src/server/rooms/sqliteRoomRepository.ts:542`).
   - Bei parallelen Writes sind Kollisionen moeglich; durch `UNIQUE(room_id, seq)` resultiert das eher in Constraint-Fehlern/Retry-Bedarf als in stillen Duplikaten (`src/server/rooms/sqliteRoomRepository.ts:348`).

5. Mittel (korrekt): `createdMessages` wird falsch gezaehlt.
   - Erhoehung bei echter Persistierung (`src/server/rooms/orchestrator.ts:424`) und zusaetzlich pauschal am Ende (`src/server/rooms/orchestrator.ts:458`).

6. Mittel (korrekt): Seed-Branch ist effektiv unerreichbar.
   - System-Message wird immer zuerst gesetzt (`src/server/rooms/orchestrator.ts:202`).
   - Bedingung `gatewayMessages.length === 0` greift dadurch nicht (`src/server/rooms/orchestrator.ts:224`).

7. Mittel (korrekt): Head-of-line-Blocking im Orchestrator.
   - Alle laufenden Raeume werden sequenziell verarbeitet (`src/server/rooms/orchestrator.ts:74`).
   - Langsame Raeume bremsen die gesamte Runde.

8. Mittel (korrekt, lastabhaengig): Frontend-Sync skaliert bei langen Timelines schlecht.
   - Bei jedem Event O(n)-Dedupe plus Sort (`src/modules/rooms/useRoomSync.ts:41`, `src/modules/rooms/useRoomSync.ts:44`).
   - Keine Begrenzung der lokalen Message-Liste.

9. Niedrig (korrekt): `beforeSeq`-Input ist nicht hart gegen `NaN` abgesichert.
   - Parse ohne `Number.isFinite` in Route (`app/api/rooms/[id]/messages/route.ts:25`).
   - Repository prueft nur `typeof beforeSeq === 'number'` (`src/server/rooms/sqliteRoomRepository.ts:577`).
   - Effekt: `NaN` fuehrt derzeit zu leeren Ergebnissen statt sauberer Eingabevalidierung.

## Positive Punkte

1. SQLite-Baseline ist korrekt gesetzt:
   - `journal_mode = WAL` (`src/server/rooms/sqliteRoomRepository.ts:137`)
   - `busy_timeout = 5000` (`src/server/rooms/sqliteRoomRepository.ts:138`)
   - `foreign_keys = ON` (`src/server/rooms/sqliteRoomRepository.ts:139`)

2. Lease- und Active-Run-Modell ist vorhanden:
   - Unique Active Run Index (`src/server/rooms/sqliteRoomRepository.ts:374`)

3. Gateway hat Slow-Consumer-Schutz:
   - Puffergrenze und Socket-Close (`src/server/gateway/broadcast.ts:69`)

## Reproduktionsnachweise

1. Stop-Race (manual stop kann in `degraded` enden)
   - Lokaler Repro-Ablauf:
     - Run starten + Lease holen
     - `closeActiveRoomRun(..., 'stopped')`
     - anschliessend `heartbeatRoomLease(...)` (erwartet Fehler)
     - danach Fehlerpfad wie im Orchestrator: `closeActiveRoomRun(..., 'degraded', reason)`
   - Beobachtetes Ergebnis:
     - `heartbeatError= Could not heartbeat run lease: <roomId>/<runId>`
     - `finalRunState= degraded`
     - `activeRunExists= false`
   - Betroffene Stellen:
     - `src/server/rooms/service.ts:171`
     - `src/server/rooms/orchestrator.ts:457`
     - `src/server/rooms/orchestrator.ts:461`

2. `beforeSeq=NaN` Validierungsluecke
   - Lokaler Repro-Ablauf:
     - Zwei Messages schreiben (`seq=1`, `seq=2`)
     - `listMessages(..., beforeSeq=2)` und `listMessages(..., beforeSeq=NaN)` vergleichen
   - Beobachtetes Ergebnis:
     - `beforeSeq=2 -> [1]`
     - `beforeSeq=NaN -> []`
   - Betroffene Stellen:
     - `app/api/rooms/[id]/messages/route.ts:25`
     - `src/server/rooms/sqliteRoomRepository.ts:577`

## Priorisierte Hardening-Schritte

1. Reentrancy-Guard fuer `runOnce()` einbauen und klar festlegen, welche Runtime Rooms steuert (web, scheduler oder feature-flag-gesteuert).
2. Stop-Race absichern: Fehlerpfad im Orchestrator darf einen bereits gestoppten Run nicht auf `degraded` ueberschreiben.
3. Lease-Heartbeat waehrend langer Dispatch-/Tool-Phasen ergaenzen.
4. Sequenzvergabe atomar und konfliktfest machen (kein `MAX(seq)+1` in Anwendungscode).
5. `createdMessages`-Zaehllogik korrigieren.
6. `beforeSeq` strikt validieren (`finite`, `>0`).
7. UI-Sync auf inkrementelle Struktur (Map + append-only order) und lokale Timeline-Limits umstellen.
