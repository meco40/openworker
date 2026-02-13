# Skills System

**Stand:** 2026-02-13

## Überblick

Das Skills-System ermöglicht die Erweiterung der KI-Fähigkeiten durch installierbare Tools. Es unterstützt:

- **8 Built-in Skills** (Core Extensions, Automation, Data & Media, System)
- **Externe Skill-Installation** via npm, GitHub oder ClawHub
- **Skill-basierte Tool-Execution** mit Approval-Workflow

## Architektur

```
skills/
├── definitions.ts          # Skill-Manifest-Definitionen
├── execute.ts             # Statische Funktions-Mappings
├── runtime-client.ts       # Client-seitiger Skill-Zugriff
├── SkillsRegistry.tsx     # UI-Komponente für Skill-Verwaltung
├── browser/               # Browser-Skill
├── filesystem/            # Dateisystem-Skill
├── github-manager/        # GitHub-API-Skill
├── python-runtime/        # Python-Execution-Skill
├── search/                # Web-Suche-Skill
├── shell-access/          # Shell-Command-Skill
├── sql-bridge/            # SQL-Query-Skill
└── vision/                # Bildanalyse-Skill
```

## Built-in Skills

| Skill        | Default | Beschreibung                            |
| ------------ | ------- | --------------------------------------- |
| `browser`    | ✅      | Website-Inhalte fetchen und analysieren |
| `search`     | ✅      | Web-Suche durchführen                   |
| `python`     | ✅      | Python-Code ausführen                   |
| `vision`     | ✅      | Bilder analysieren (OCR, Beschreibung)  |
| `filesystem` | ✅      | Dateien lesen/schreiben im Workspace    |
| `shell`      | ❌      | Shell-Kommandos ausführen (riskant)     |
| `github`     | ❌      | GitHub-API-Abfragen                     |
| `sql`        | ❌      | SQL-Queries (read-only)                 |

## Skill-Installation

### Via npm

```bash
# Lokale Installation
npm install <skill-package>

# Skill-Manifest in skills/ einfügen
```

### Via GitHub

```bash
# Über UI: Skills Registry → GitHub Tab
# API: POST /api/skills mit { source: 'github', repo, manifest }
```

### Via ClawHub

```bash
# Über UI: Skills Registry → ClawHub Tab
# CLI: clawhub install <slug>
```

## API-Oberfläche

### GET /api/skills

Liste aller installierten Skills.

**Response:**

```json
{
  "ok": true,
  "skills": [
    {
      "id": "browser",
      "name": "Browser",
      "description": "Fetch and analyze website content",
      "enabled": true,
      "installedByDefault": true
    }
  ]
}
```

### POST /api/skills

Skill installieren.

**Body:**

```json
{
  "source": "npm|github|clawhub",
  "name": "skill-name",
  "manifest": { ... }
}
```

### DELETE /api/skills/[id]

Skill deinstallieren.

## Skill-Execution

Skills werden über den Model-Hub mit Tool-Calling integriert:

```typescript
// skills/execute.ts
import { browser } from '../skills/browser';
import { filesystem } from '../skills/filesystem';

const SKILL_HANDLERS = {
  browser_fetch: browser.fetch,
  file_read: filesystem.readFile,
  file_write: filesystem.writeFile,
  // ...
};

export async function executeSkill(name: string, args: Record<string, unknown>) {
  const handler = SKILL_HANDLERS[name];
  if (!handler) throw new Error(`Unknown skill: ${name}`);
  return handler(args);
}
```

## Sicherheit

### Command Approval

Shell-Kommandos erfordern Benutzer-Approval:

```
User: Führe `rm -rf /` aus
System: ⚠️ Genehmigung erforderlich für Shell-Kommando
        [Genehmigen] [Immer erlauben] [Ablehnen]
```

### Risk-Levels

Skills werden nach Risiko eingestuft:

- **Low**: browser, search, filesystem (lesen), vision
- **Medium**: filesystem (schreiben), python, sql
- **High**: shell, github

## Verifikation

```bash
npm run test -- tests/unit/skills
npm run test -- tests/integration/skills
npm run lint
npm run typecheck
```

## Siehe auch

- [docs/CORE_HANDBOOK.md](CORE_HANDBOOK.md) – Architekturübersicht
- [docs/plans/2026-02-13-clawhub-dual-lane-design.md](plans/2026-02-13-clawhub-dual-lane-design.md) – ClawHub-Integration
