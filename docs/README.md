# Dokumentationsindex

Stand: 2026-02-17

Diese Seite ist der Einstieg in die aktive Projektdokumentation.
Historische Reports, Reviews und alte Pläne liegen unter `docs/archive/`.

## Aktive Technische Doku

### Kernsysteme

1. **[docs/CORE_HANDBOOK.md](CORE_HANDBOOK.md)**
   - Technischer Gesamtüberblick (Stack, Runtime, Qualitäts-Gates).

2. **[docs/SESSION_MANAGEMENT.md](SESSION_MANAGEMENT.md)**
   - Konversationen, Chat-Flows, Abbruch, Idempotenz, Session-Überschreibungen.

3. **[docs/MEMORY_SYSTEM.md](MEMORY_SYSTEM.md)**
   - Persona-/User-skopierter Memory-Layer (Mem0, Feedback, Versionierung).

### Messaging und Gateway

4. **[docs/OMNICHANNEL_GATEWAY_SYSTEM.md](OMNICHANNEL_GATEWAY_SYSTEM.md)**
   - Omnichannel-Routing, Kopplung, Webhooks und WebSocket-Gateway.

5. **[docs/OMNICHANNEL_GATEWAY_OPERATIONS.md](OMNICHANNEL_GATEWAY_OPERATIONS.md)**
   - Betrieb und Incident-Handling für Gateway und Channels.

### KI und Modelle

6. **[docs/MODEL_HUB_SYSTEM.md](MODEL_HUB_SYSTEM.md)**
   - Model Hub mit 14 Providern, Pipeline, OAuth und Connectivity.

7. **[docs/architecture/model-hub-provider-matrix.md](architecture/model-hub-provider-matrix.md)**
   - Provider/Auth/Endpoint-Referenz (Produktion).

### Personas, Rooms, Worker

8. **[docs/PERSONA_ROOMS_SYSTEM.md](PERSONA_ROOMS_SYSTEM.md)**
   - Rooms-Orchestrierung, Member-Lebenszyklus, Persona-Kontext.

9. **[docs/WORKER_SYSTEM.md](WORKER_SYSTEM.md)**
   - Worker-Task-Lifecycle, Planung, Ausführung, Freigabe.

10. **[docs/WORKER_ORCHESTRA_SYSTEM.md](WORKER_ORCHESTRA_SYSTEM.md)**
    - Orchestra-Flows, Publishing, Run-Status, Workflow-Ansicht.

11. **[docs/AUTOMATION_SYSTEM.md](AUTOMATION_SYSTEM.md)**
    - Cron-basierte Regeln, Run-Queue, Retry/Dead-Letter, Scheduler-Lease.

### Skills, Knowledge und Sicherheit

12. **[docs/SKILLS_SYSTEM.md](SKILLS_SYSTEM.md)**
    - Skill-Katalog, Runtime-Konfiguration, Ausführung und Governance.

13. **[docs/CLAWHUB_SYSTEM.md](CLAWHUB_SYSTEM.md)**
    - ClawHub-Suche/Install/Update/Enable-Management.

14. **[docs/KNOWLEDGE_BASE_SYSTEM.md](KNOWLEDGE_BASE_SYSTEM.md)**
    - Interne Knowledge-Ingestion/Retrieval-Pipeline (keine öffentlichen Knowledge-HTTP-Routen).

15. **[docs/SECURITY_SYSTEM.md](SECURITY_SYSTEM.md)**
    - Security-Checks, Channel-Verifikation, Isolations- und Command-Regeln.

### Deployment & API

16. **[docs/DEPLOYMENT_OPERATIONS.md](DEPLOYMENT_OPERATIONS.md)**
    - Deployment, Runtime-Prozesse, Health/Monitoring.

17. **[docs/API_REFERENCE.md](API_REFERENCE.md)**
    - Vollständige, code-konsistente API-Routenliste.

## Plans

- **[docs/plans/README.md](plans/README.md)**

## Änderungsprotokolle

- **[docs/DOCS_CHANGELOG_2026-02-17.md](DOCS_CHANGELOG_2026-02-17.md)**

## Archive

- **[docs/archive/README.md](archive/README.md)**

## Regel

Wenn Inhalte zwischen aktiver Doku und Archiv widersprechen, gilt die aktive Doku unter `docs/`.
