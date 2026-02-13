# Dokumentations-Verbesserungsplan

**Priorität:** 1. Root README | 2. Fehlende Dokumentationen | 3. Einheitlich Deutsch | 4. API-Referenz
**Stand:** 2026-02-13

## Aufgaben

### 1. Root README.md überarbeiten ✅
- [ ] Datum hinzufügen
- [ ] Verweis auf docs/ ergänzen
- [ ] Alle Kernfeatures erwähnen (Rooms, Personas, Omnichannel, Skills, Worker, Memory)
- [ ] Provider-Übersicht ergänzen (11 statt nur Gemini)
- [ ] Quality Gates dokumentieren
- [ ] Einheitlich Deutsch

### 2. plans/README.md korrigieren ✅
- [ ] ClawHub-Dual-Lane-Plan hinzufügen

### 3. docs/SKILLS_SYSTEM.md erstellen (NEU) ⬜
- [ ] Skills-Architektur (8 Built-in Skills)
- [ ] Skill-Handler (shell, file, browser, python, vision, sql, github, search)
- [ ] Skill-Installation (npm, GitHub, ClawHub)
- [ ] Skill-Execution-Runtime
- [ ] API-Oberfläche dokumentieren

### 4. docs/WORKER_SYSTEM.md erstellen (NEU) ⬜
- [ ] Worker-Architektur (Executor, Planner, Agent)
- [ ] Task-Zustände und Prioritäten
- [ ] Workspace-Management
- [ ] Command-Approval-Workflow
- [ ] API-Oberfläche dokumentieren

### 5. docs/MEMORY_SYSTEM.md erstellen (NEU) ⬜
- [ ] Memory-Typen (core_memory_store, core_memory_recall)
- [ ] Embedding-Pipeline
- [ ] Vector-Similarity-Suche
- [ ] Persistenz (SQLite)
- [ ] API-Oberfläche dokumentieren

### 6. docs/SECURITY_SYSTEM.md erstellen (NEU) ⬜
- [ ] Security-Checks (Firewall, Encryption, Audit, Isolation)
- [ ] Channel-Security (Webhook-Signaturen)
- [ ] Command-Permissions und Risk-Levels
- [ ] Credential-Store
- [ ] API-Oberfläche dokumentieren

### 7. docs/DEPLOYMENT_OPERATIONS.md erstellen (NEU) ⬜
- [ ] Docker-Setup (Dockerfile, docker-compose)
- [ ] Environment-Variablen
- [ ] Systemd-Services
- [ ] Health-Checks
- [ ] Monitoring und Metriken

### 8. docs/API_REFERENCE.md erstellen (NEU) ⬜
- [ ] Konsolidierte API-Übersicht aller Routes
- [ ] Gruppiert nach Domäne (channels, rooms, personas, worker, model-hub, skills, memory, security, clawhub, control-plane)
- [ ] HTTP-Methoden und Pfade
- [ ] Auth-Anforderungen

### 9. docs/README.md aktualisieren ⬜
- [ ] Neue Dokumente in Index aufnehmen
- [ ] Einheitlich Deutsch

### 10. Bestehende Dokumente sprachlich anpassen ⬜
- [ ] SESSION_MANAGEMENT → Deutsch (oder English konsistent)
- [ ] Plans → English konsistent oder Deutsch
- [ ] Klare Sprachrichtlinie definieren

## Abhängigkeiten

- `src/server/skills/*` → docs/SKILLS_SYSTEM.md
- `src/server/worker/*` → docs/WORKER_SYSTEM.md
- `src/server/memory/*` → docs/MEMORY_SYSTEM.md
- `src/server/security/*` → docs/SECURITY_SYSTEM.md
- `Dockerfile`, `docker-compose.yml`, `ops/systemd/*` → docs/DEPLOYMENT_OPERATIONS.md
- `app/api/*` → docs/API_REFERENCE.md

## Verifikation

Nach Abschluss:
- `npm run lint`
- `npm run typecheck`
- Alle neuen Docs haben "Stand: YYYY-MM-DD"
