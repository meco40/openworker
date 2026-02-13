# Architektur-Entscheidungsmatrix

Stand: 10.02.2026  
Projekt: `openclaw-gateway-control-plane`

## Ziel
Entscheidungshilfe zwischen:

- `A`: Next.js + REST/SSE (aktuell)
- `B`: Verteilte Daemon/Node-Architektur mit WebSocket-Command-Bus

Die Matrix ist auf eure reale App-Lage zugeschnitten: Control Plane, Multi-Channel Inbox, Skill/Worker-Logik, Model-Hub-Fallback.

## Kurzfazit

- Für euer aktuelles Zielbild (Control Plane + Messaging + moderate Worker-Last) ist `A` klar im Vorteil.
- `B` wird vorteilhaft, sobald ihr echte verteilte Worker-Orchestrierung auf mehreren Hosts/Regionen mit strengen Realtime-/Resilience-Anforderungen braucht.
- Praktisch sinnvoll ist oft ein `Hybrid`: Control Plane bleibt Next.js, Worker-Bus wird schrittweise ausgelagert.

## Ziel-/Workload-Mapping

| Ziel / Workload | Vorteil `A` (REST/SSE) | Vorteil `B` (Daemon/Node + WS-Bus) | Empfehlung |
| --- | --- | --- | --- |
| Schnelles Produkt-Shipping (kleines Team) | Sehr hoch: geringe Komplexität, schneller Dev-Loop | Niedrig: hoher Initialaufwand | `A` |
| Zentrale Web-Steuerung, Human-in-the-loop | Sehr hoch: passt direkt zu Dashboard/API | Mittel | `A` |
| Multi-Channel Chat mit moderater Last | Hoch: gut mit API + SSE handhabbar | Mittel | `A` |
| Viele gleichzeitige Langläufer-Tasks | Mittel | Hoch: langlebige Verbindungen, aktives Scheduling | `B` oder Hybrid |
| Verteilte Worker auf mehreren Hosts/Regionen | Niedrig bis mittel | Sehr hoch | `B` |
| Strenges Realtime-Commanding (bidirektional, ACK/Retry) | Mittel | Sehr hoch | `B` |
| Offline/instabile Netzsegmente zwischen Nodes | Niedrig | Hoch | `B` |
| Niedrige Ops-Kosten und einfache Wartung | Sehr hoch | Niedrig bis mittel | `A` |

## Entscheidungs-Schwellenwerte

Wenn mehrere der folgenden Punkte gleichzeitig zutreffen, kippt der Vorteil Richtung `B`:

| Kriterium | `A` geeignet | Kipppunkt | `B` geeignet |
| --- | --- | --- | --- |
| Aktive Worker-Nodes gleichzeitig | bis ca. 10-20 | > 20 | > 20-30+ |
| Verteilte Hosts/Standorte | 1-2 | >= 3 | >= 3-5+ |
| Ziel-Latenz (p95 Command) | 500-2000 ms | < 300 ms gefordert | < 300 ms |
| Langläufer-Jobs | vereinzelt | viele Jobs > 10-30 min | häufig/lang |
| Netzwerkqualität zwischen Workern | stabil | häufig instabil | instabil/offline-fähig |
| Realtime-Orchestrierung (ACK, Retry, Backpressure) | basis | zwingend | zwingend |
| Betriebsbudget / Ops-Kapazität | gering | mittel | mittel-hoch |

Hinweis: Die Schwellen sind Praxiswerte, keine harten Limits.

## Bewertungsmatrix (gewichtete Entscheidung)

Bewerte jedes Kriterium von `1` (schlecht) bis `5` (sehr gut), multipliziere mit Gewicht:

| Kriterium | Gewicht | `A` | `B` |
| --- | ---: | ---: | ---: |
| Delivery-Speed / Time-to-Market | 25% | 5 | 2 |
| Betriebs-Komplexität (einfach = gut) | 20% | 5 | 2 |
| Verteilte Skalierung | 20% | 2 | 5 |
| Realtime-Steuerung | 15% | 3 | 5 |
| Resilience bei Netzproblemen | 10% | 2 | 4 |
| Debugbarkeit / Operative Transparenz | 10% | 4 | 3 |
| **Gewichtete Summe (typisch)** | **100%** | **3.95** | **3.35** |

Interpretation:

- Bei eurem aktuellen Profil gewinnt meist `A`.
- Wenn sich Gewichte Richtung Skalierung/Realtime verschieben, kann `B` schnell vorne liegen.

## Empfehlung für euren aktuellen Stand

Auf Basis eurer aktuellen Struktur (Next.js App Router, API-Routes, SSE-Stream, zentrales MessageService/ModelHub, gekoppelte Messenger) ist diese Reihenfolge sinnvoll:

1. `Jetzt`: Bei `A` bleiben, Stabilität und Security härten (AuthN/AuthZ, Rate Limits, Monitoring).
2. `Nächster Schritt`: Hybrid vorbereiten (Worker-Ausführung als separates Runtime-Modul, klare Command-Contracts).
3. `Später`: Erst bei realen Last-/Skalierungsindikatoren gezielt auf `B` für den Worker-Bus migrieren.

## Konkreter Hybrid-Migrationspfad (wenn benötigt)

1. `Phase 1`: Command-Schema standardisieren (idempotent, ACK/NACK, Retry-Felder) innerhalb der bestehenden API.
2. `Phase 2`: Worker-Execution-Service separat deployen, Control Plane bleibt in Next.js.
3. `Phase 3`: WS-Command-Bus nur für Worker-Orchestrierung einführen, REST für Admin/Config beibehalten.
4. `Phase 4`: Observability ausbauen (Tracing pro Command, Dead-letter Queue, Retry-Metriken).

## Entscheidungs-Checkliste (quick)

Wenn ihr mindestens 3 Fragen mit `Ja` beantwortet, plant den Hybrid-/`B`-Pfad aktiv:

- Haben wir > 20 gleichzeitige Worker mit langen Laufzeiten?
- Müssen Worker auf mehreren Hosts/Regionen zuverlässig koordiniert werden?
- Ist p95 Command-Latenz < 300 ms geschäftskritisch?
- Brauchen wir robustes ACK/Retry/Backpressure mit garantierter Zustellung?
- Sind instabile/offline Netzwerkabschnitte ein realer Betriebsfall?

