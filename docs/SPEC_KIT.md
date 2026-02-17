# Spec Kit Workflow (OpenClaw)

Diese Codebase nutzt jetzt `spec-kit` (Codex + PowerShell Template) für
spec-driven Entwicklung.

## Solo-Modus (empfohlen, 10-15 Minuten)

Wenn du alleine arbeitest, nutze standardmäßig den `Solo Lite`-Flow.
Ziel: genug Struktur für Klarheit, aber ohne unnötigen Overhead.

### Wann `Solo Lite` reicht

- kleine bis mittlere Features mit klarer Scope-Grenze
- keine Breaking Changes
- keine sicherheitskritischen Änderungen

### Wann `Full Flow` nutzen

- größere Umbauten über mehrere Bereiche
- API-/Datenmodell-Änderungen mit Migrationsbedarf
- Security-/Auth-/Session-Logik
- alles, was schwer rückbaubar ist

## Enthaltene Struktur

- `.codex/prompts/speckit.*.md`: Prompt-Kommandos für den Codex-Workflow
- `.specify/scripts/powershell/*.ps1`: Feature-/Plan-Skripte
- `.specify/templates/*.md`: Templates für Spec, Plan, Tasks, Constitution
- `.specify/memory/constitution.md`: Projektregeln (verbindlich)
- `specs/[###-feature-name]/`: Feature-Artefakte pro Branch

## npm Skripte

- `npm run speckit:help`
- `npm run speckit:new -- "Feature-Beschreibung"`
- `npm run speckit:plan:init`
- `npm run speckit:agent:update`

## Empfohlener Ablauf pro Feature

1. Spec erstellen und Feature-Branch anlegen:
   - `npm run speckit:new -- "Beschreibe die gewünschte Funktion"`
2. `specs/<branch>/spec.md` ausarbeiten und klären.
3. Plan erzeugen:
   - `npm run speckit:plan:init`
4. `specs/<branch>/plan.md` technisch konkretisieren.
5. `specs/<branch>/tasks.md` erzeugen und in kleine Schritte schneiden.
6. Implementierung mit TDD für Verhaltensänderungen.
7. Verifikation ausführen (`npm test`, `npm run typecheck`, bei Bedarf `npm run lint`).

## Solo Lite Ablauf (kurz)

1. `npm run speckit:new -- "Feature-Beschreibung"`
2. `specs/<branch>/spec.md` nur mit Kerninhalt füllen:
   - 1 Haupt-User-Story
   - 3-5 funktionale Anforderungen
   - 2-3 messbare Erfolgskriterien
   - wichtigste Edge Cases
3. `npm run speckit:plan:init`
4. `specs/<branch>/plan.md` schlank füllen:
   - Summary
   - Technical Context
   - Constitution Check
   - 3-7 konkrete Umsetzungsschritte
5. Implementieren und nur relevante Verifikation laufen lassen
   (`npm test` scoped oder voll, plus `npm run typecheck` für geänderten Scope).

## Mikro-Änderungen (ohne vollen Flow)

Für rein kosmetische oder dokumentarische Änderungen darfst du ohne neuen
Feature-Ordner arbeiten, wenn:

- kein Laufzeitverhalten geändert wird
- keine API-Verträge geändert werden
- kein Security-Risiko entsteht

Dann reicht:

- kurze Notiz im Commit/Change-Text, was geändert wurde und warum
- passende Verifikation für den geänderten Bereich

## Codex-Kommandos

Wenn deine Codex-Umgebung Repo-Prompts unterstützt, sind diese Kommandos verfügbar:

- `/speckit.constitution`
- `/speckit.specify`
- `/speckit.clarify`
- `/speckit.plan`
- `/speckit.tasks`
- `/speckit.implement`
- `/speckit.checklist`
- `/speckit.analyze`

## Hinweise

- `check-prerequisites.ps1` erwartet für Plan-/Task-Phasen einen Feature-Branch
  im Format `###-short-name`.
- Änderungen an Workflow-Regeln laufen über
  `.specify/memory/constitution.md`.
