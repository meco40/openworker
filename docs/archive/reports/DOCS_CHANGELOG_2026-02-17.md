# Dokumentations-Änderungsprotokoll (2026-02-17)

## Ziel

Dieses Protokoll fasst die Doku-Überarbeitung vom 2026-02-17 zusammen:

- fachliche Aktualisierung auf den realen Code-/API-Stand
- sprachlicher Feinschliff mit konsistenter Terminologie

## Inhaltliche Änderungen

1. API-Konsistenz hergestellt

- `docs/API_REFERENCE.md` vollständig mit `app/api/*` abgeglichen.
- Veraltete oder nicht existente Endpunkte entfernt.
- Methoden-/Pfadabweichungen korrigiert.

2. Knowledge-Layer korrekt eingeordnet

- `docs/KNOWLEDGE_BASE_SYSTEM.md` klar als interne Schicht dokumentiert.
- Keine öffentlichen Knowledge-HTTP-Routen mehr behauptet.

3. Memory-Doku auf aktuellen Betrieb gebracht

- `docs/MEMORY_SYSTEM.md` auf reale Memory-Typen, FC-Aufrufe und Mem0-Runtime-Guards angepasst.
- API-Operationen (`GET/POST/PUT/PATCH/DELETE`) präzisiert.

4. Worker-/Orchestra-/Skills-/Rooms-Dokus aktualisiert

- Endpunktlisten, Status- und Funktionsbeschreibungen am aktuellen Implementierungsstand ausgerichtet.
- Tooling-/Konfigurationshinweise konkretisiert.

5. Model Hub und Provider-Matrix aktualisiert

- Provideranzahl und Providerliste auf aktuellen Katalogstand gebracht.
- `docs/architecture/model-hub-provider-matrix.md` auf 14 Provider aktualisiert.

6. Sprachlicher Feinschliff

- Terminologie in den Hauptdokumenten vereinheitlicht.
- Uneinheitliche Deutsch/Englisch-Mischungen reduziert.
- Beschreibungen auf professionellen, technischen Stil harmonisiert.

## Betroffene Dateien

- `docs/API_REFERENCE.md`
- `docs/README.md`
- `docs/architecture/model-hub-provider-matrix.md`
- `docs/MEMORY_SYSTEM.md`
- `docs/KNOWLEDGE_BASE_SYSTEM.md`
- `docs/SKILLS_SYSTEM.md`
- `docs/CLAWHUB_SYSTEM.md`
- `docs/WORKER_SYSTEM.md`
- `docs/WORKER_ORCHESTRA_SYSTEM.md`
- `docs/PERSONA_ROOMS_SYSTEM.md`
- `docs/SESSION_MANAGEMENT.md`
- `docs/AUTOMATION_SYSTEM.md`
- `docs/MODEL_HUB_SYSTEM.md`
- `docs/OMNICHANNEL_GATEWAY_SYSTEM.md`

## Verifikation

Durchgeführt:

```bash
npx prettier --write <alle geänderten Doku-Dateien>
npx prettier --check <alle geänderten Doku-Dateien>
```

Zusätzliche Konsistenzprüfung:

- Automatischer Abgleich aller in aktiven Dokus genannten API-Methoden/Pfade gegen `app/api/*`.
- Ergebnis: keine Route-Mismatches in aktiven Dokus.
