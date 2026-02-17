# Spec-Kit Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Integriere `github/spec-kit` in dieses Repo, sodass Features konsistent spec-driven umgesetzt werden.

**Architecture:** Nutze das offizielle `codex + powershell`-Template als Basis, ergänze projektspezifische Governance und passe Templates auf die bestehende OpenClaw-Struktur an. Fokus auf minimale Upstream-Abweichungen.

**Tech Stack:** PowerShell Scripts, Markdown Templates, npm Scripts

---

### Task 1: Offizielles Template importieren

**Files:**

- Create: `.codex/prompts/speckit.specify.md`
- Create: `.codex/prompts/speckit.plan.md`
- Create: `.codex/prompts/speckit.tasks.md`
- Create: `.codex/prompts/speckit.implement.md`
- Create: `.specify/scripts/powershell/create-new-feature.ps1`
- Create: `.specify/scripts/powershell/setup-plan.ps1`
- Create: `.specify/scripts/powershell/check-prerequisites.ps1`
- Create: `.specify/templates/spec-template.md`
- Create: `.specify/templates/plan-template.md`
- Create: `.specify/templates/tasks-template.md`

**Step 1: Download offizielles Template-Artefakt**

Run: `Invoke-WebRequest ... spec-kit-template-codex-ps-v0.0.95.zip`
Expected: ZIP lokal verfügbar unter `.tmp/spec-kit/`

**Step 2: Entpacken und Repo-Dateien übernehmen**

Run: `Expand-Archive ... ; Copy-Item .tmp/spec-kit/template/.codex ... ; Copy-Item .tmp/spec-kit/template/.specify ...`
Expected: `.codex/` und `.specify/` existieren mit den erwarteten Dateien

**Step 3: Sanity-Check**

Run: `Get-ChildItem -Recurse .codex,.specify`
Expected: Prompt-, Script- und Template-Dateien sichtbar

### Task 2: Projektspezifische Governance definieren

**Files:**

- Create: `.specify/memory/constitution.md`
- Modify: `.specify/templates/plan-template.md`
- Modify: `.specify/templates/tasks-template.md`

**Step 1: Constitution anlegen**

Inhalt: Prinzipien für Spec-First, Test-First bei Verhaltensänderungen, Security, Operability, Simplicity.

**Step 2: Plan-Template auf Constitution-Gates ausrichten**

Inhalt: Konkrete Checkliste statt Platzhalter.

**Step 3: Tasks-Template an Repo-Struktur anpassen**

Inhalt: Pfadkonventionen und Beispieltasks auf `app/`, `services/`, `src/`, `tests/` und `*.test.ts`.

### Task 3: Nutzung in den Projektalltag integrieren

**Files:**

- Modify: `package.json`
- Create: `docs/SPEC_KIT.md`

**Step 1: npm Skripte ergänzen**

Add:

- `speckit:help`
- `speckit:new`
- `speckit:plan:init`
- `speckit:agent:update`

**Step 2: Team-Doku ergänzen**

In `docs/SPEC_KIT.md` den End-to-End-Ablauf für neue Features dokumentieren.

### Task 4: Verifikation

**Files:**

- Test: `.specify/scripts/powershell/check-prerequisites.ps1`
- Test: `.specify/scripts/powershell/create-new-feature.ps1`

**Step 1: Hilfetext prüfen**

Run: `npm run speckit:help`
Expected: Ausgabe mit Optionen ohne Fehler

**Step 2: Feature-Skript Help prüfen**

Run: `pwsh -File .specify/scripts/powershell/create-new-feature.ps1 -Help`
Expected: Usage-Ausgabe vorhanden
