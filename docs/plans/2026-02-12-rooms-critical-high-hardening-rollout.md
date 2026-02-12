# Rooms Critical+High Hardening Rollout

## Ziel

Sicheres Ausrollen der Stabilitäts-/Performance-Härtungen für Rooms ohne Verhaltensregressionen.

## Konfigurationsmatrix

`ROOMS_RUNNER` steuert, welcher Prozess Room-Cycles fährt:

1. `web`
   - Nur `server.ts` fährt `RoomOrchestrator`.
2. `scheduler`
   - Nur `scheduler.ts` fährt `RoomOrchestrator`.
3. `both`
   - Beide Prozesse aktiv (nur für Diagnose/Übergang).

Empfehlung Produktion (Docker Compose):

1. `web`: `ROOMS_RUNNER=scheduler`
2. `scheduler`: `ROOMS_RUNNER=scheduler`

## Verifikations-Checkliste

1. Keine überlappenden `runOnce()`-Ausführungen pro Instanz.
2. Manueller Stop führt stabil zu `stopped` (kein spätes `degraded`).
3. Bei langem Dispatch bleibt Lease beim aktiven Owner.
4. Keine seq-Kollisionen in `room_messages` unter parallelen Writes.
5. `createdMessages` entspricht tatsächlichen persisted Persona-Messages.
6. `beforeSeq` invalid (`NaN`, Text, `0`, negativ) liefert HTTP 400.

## Smoke-Run (produktionnah)

1. `docker compose up -d --build`
2. `docker compose logs -f scheduler web`
3. Start/Stop eines Test-Rooms mehrfach triggern
4. Test mit künstlich langsamer Modellantwort durchführen

Erwartung:

1. Nur der konfigurierte Runner schreibt Room-Cycle-Logs.
2. Keine degradations nach manuellen Stops.
3. Keine Lease-Takeovers während aktiver langer Dispatches.

## Fallback / Rollback

1. Sofortmaßnahme bei auffälligem Verhalten:
   - `ROOMS_RUNNER=web` oder `ROOMS_RUNNER=scheduler` eindeutig setzen.
2. Diagnostikmodus:
   - Nur kurzfristig `ROOMS_RUNNER=both` zur Ursachenanalyse.
3. API-Kompatibilität:
   - Keine Breaking Changes in Room-Endpoints erforderlich.

## Nachkontrolle

1. Täglich: `rooms`-Metriken (running/degraded/totalMessages).
2. Bei Fehlern: Orchestrator-Logs auf Lease-Heartbeat/Abort prüfen.
3. Nach 7 Tagen ohne Auffälligkeit: Diagnoseflags bereinigen.
