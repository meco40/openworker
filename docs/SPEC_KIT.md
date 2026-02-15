# Spec Kit Workflow (OpenClaw)

Diese Codebase nutzt jetzt `spec-kit` (Codex + PowerShell Template) für
spec-driven Entwicklung.

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
