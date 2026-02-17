# Skills System

**Stand:** 2026-02-17

## 1. Funktionserläuterung

Das Skills-System verwaltet installierte Skills und stellt eine kontrollierte Ausführung für vordefinierte Skill-Handler bereit.

### Kernkonzepte

- **Skill Registry**: Persistierte Skill-Metadaten inkl. Install/Enabled-Status
- **Built-in-Startbestand**: Standard-Skills beim Systemstart
- **Runtime-Konfiguration**: Secret/Text-Konfiguration pro Skill-Feld
- **Ausführungs-Dispatch**: Name-basierter Handler-Aufruf mit Argument-Normalisierung

---

## 2. Architektur

### 2.1 Komponenten

- `src/server/skills/builtInSkills.ts`
- `src/server/skills/skillRepository.ts`
- `src/server/skills/skillInstaller.ts`
- `src/server/skills/runtimeConfig.ts`
- `src/server/skills/executeSkill.ts`
- `src/server/skills/handlers/*`
- `app/api/skills/*`

### 2.2 Built-in Skills (Seed)

Quelle: `src/server/skills/builtInSkills.ts`

| Skill ID     | Default installiert |
| ------------ | ------------------- |
| `browser`    | ja                  |
| `search`     | ja                  |
| `python`     | ja                  |
| `shell`      | nein                |
| `github`     | nein                |
| `vision`     | ja                  |
| `sql`        | nein                |
| `filesystem` | ja                  |

---

## 3. API-Referenz

| Methode | Pfad                         | Zweck                              |
| ------- | ---------------------------- | ---------------------------------- |
| GET     | `/api/skills`                | Skills auflisten                   |
| POST    | `/api/skills`                | Skill installieren                 |
| PATCH   | `/api/skills/[id]`           | Skill aktiviert/deaktiviert setzen |
| DELETE  | `/api/skills/[id]`           | Skill entfernen (keine built-ins)  |
| POST    | `/api/skills/execute`        | Skill-Handler ausführen            |
| GET     | `/api/skills/runtime-config` | Runtime-Konfigurationsstatus lesen |
| PUT     | `/api/skills/runtime-config` | Runtime-Konfigurationswert setzen  |
| DELETE  | `/api/skills/runtime-config` | Runtime-Konfigurationswert löschen |

### Ausführungsanfrage

```json
{
  "name": "file_read",
  "args": {
    "path": "README.md"
  }
}
```

Unterstützte direkte Handler-Namen (`executeSkill.ts`):

- `file_read`
- `shell_execute`
- `python_execute`
- `github_query`
- `db_query`
- `browser_snapshot`
- `vision_analyze`

---

## 4. Runtime-Konfiguration

Quelle: `src/server/skills/runtimeConfig.ts`

Aktuelle Felder:

- `vision.gemini_api_key` (secret, erforderlich)
- `github-manager.github_token` (secret, optional)
- `sql-bridge.sqlite_db_path` (text, erforderlich)

Werte können aus Store oder ENV aufgelöst werden; der Status zeigt Quelle + maskierten Wert.

---

## 5. Verifikation

```bash
npm run test -- tests/unit/skills
npm run test -- tests/integration/skills
npm run typecheck
npm run lint
```

---

## 6. Siehe auch

- `docs/CLAWHUB_SYSTEM.md`
- `docs/API_REFERENCE.md`
- `docs/WORKER_SYSTEM.md`
