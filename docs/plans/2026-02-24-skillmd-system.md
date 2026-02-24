# SKILL.md System — Implementation Notes

**Date:** 2026-02-24  
**Scope:** Migrate the OpenClaw demo's SKILL.md-based skill metadata system into the main project.

---

## Ziel

Das Demo-Projekt verwendet `SKILL.md`-Dateien, um Skill-Metadaten (Emoji, OS-Einschränkungen, LLM-Guidance-Bodies) deklarativ zu beschreiben. Ziel war es, dieses Konzept in den Hauptserver zu übernehmen, zu verbessern und mit einer Zwei-Tier-Architektur zu erweitern.

---

## Architektur: Zwei-Tier-System

### Tier-1 — Built-in Skills (`src/skills/*/SKILL.md`)

- `SKILL.md` ist **additiv** — ergänzt nur Emoji, OS-Einschränkungen, Env-/Binary-Requirements und einen LLM-Guidance-Body
- Die **Tool-Schema-Definition** (JSON Schema) bleibt in `index.ts` (browser-kompatibel, kein Node.js `fs`)
- `index.ts` darf **nicht** gelöscht werden (wird von `useAgentRuntime.ts` im Browser importiert)

### Tier-2 — User/Workspace Skills

- Standalone `SKILL.md` mit vollständigem `tool:` YAML-Block
- Kein TypeScript notwendig
- Unterstützt eigene Skills in `~/.config/openclaw/skills/` oder per `OPENCLAW_SKILLS_DIR`

---

## Neue Dateien

### `src/server/skills/skillMd/` — Neues Modul

| Datei         | Zweck                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------- |
| `types.ts`    | `ParsedSkillMd`, `BuiltInSkillMdFrontmatter`, `UserSkillMdFrontmatter`, `SkillSource`                      |
| `parser.ts`   | YAML-Frontmatter-Parser (`yaml`-Package, `schema: 'core'`), CRLF-sicher                                    |
| `loader.ts`   | 4-Quellen-Discovery mit 10s TTL-Cache                                                                      |
| `filter.ts`   | OS-, Env- und Binary-Eligibility-Filter                                                                    |
| `enricher.ts` | Merged `index.ts`-Manifest mit SKILL.md-Additiven (Tier-1) oder baut volles Manifest aus SKILL.md (Tier-2) |
| `prompt.ts`   | Baut System-Prompt-Sektion mit 30k-Zeichen-Cap (Binärsuche)                                                |
| `index.ts`    | Öffentliche Re-Export-API                                                                                  |

### Quellen-Priorität (loader.ts)

```
bundled  <  user  <  workspace  <  env-override
```

Gleiche `id` → höhere Priorität gewinnt. Ermöglicht User-Overrides für Built-in Skills.

### `src/skills/*/SKILL.md` — 17 Dateien

Erstellt für alle Built-in Skills:

| Skill                   | Emoji | Einschränkungen                       |
| ----------------------- | ----- | ------------------------------------- |
| browser                 | 🌐    | —                                     |
| search                  | 🔍    | `always: true`                        |
| shell-access            | 🐚    | alle OS                               |
| filesystem              | 📁    | alle OS                               |
| python-runtime          | 🐍    | `anyBins: [python3, python]`          |
| vision                  | 👁️    | alle OS                               |
| sql-bridge              | 🗄️    | `env: SQLITE_DB_PATH`                 |
| github-manager          | 🐙    | `env: GITHUB_TOKEN`                   |
| subagents               | 🤖    | alle OS                               |
| multi-tool-use-parallel | ⚡    | alle OS                               |
| process-manager         | ⚙️    | alle OS                               |
| gateway-self-heal       | 🔧    | `env: OPENCLAW_OWNER_USER_ID`         |
| web-search              | 🔎    | `env: BRAVE_API_KEY`                  |
| web-fetch               | 🌍    | alle OS                               |
| http-request            | 🔗    | `env: OPENCLAW_HTTP_SKILL_ENABLED`    |
| notifications           | 🔔    | `env: OPENCLAW_NOTIFICATIONS_ENABLED` |
| pdf-generate            | 📄    | alle OS                               |

---

## Geänderte Dateien

### `src/server/skills/builtInSkills.ts` — Bugfix: 5 fehlende Skills

Folgende Skills existierten als Module (`src/skills/*/index.ts`), wurden aber nie in die SQLite-DB geseeded:

- `web-search` (`installedByDefault: false`)
- `web-fetch` (`installedByDefault: true`)
- `http-request` (`installedByDefault: false`)
- `notifications` (`installedByDefault: false`)
- `pdf-generate` (`installedByDefault: false`)

### `src/skills/execute.ts` — Bugfix: 8 fehlende Skills

Folgende Skills fehlten im Client-Dispatcher (wurden vom AI-Modell gerufen, aber nicht ausgeführt):

- `web-search`, `web-fetch`, `http-request`, `notifications`, `pdf-generate`
- `process-manager`, `gateway-self-heal` (server-only, owner-restricted — korrekt ausgelassen)

`search` absichtlich nicht hinzugefügt — ist ein Google Search Grounding Built-in, kein Function-Call.

### `src/server/channels/messages/service/dispatchers/aiDispatcher.ts` — Skill-Guidance-Injection

In `dispatchToAI()` wird **nach** dem Memory-Context-Block die Skill-Guidance dynamisch geladen und als System-Prompt vorangestellt:

```typescript
const { loadAllSkillMd, filterEligibleSkills, enrichBuiltInManifest, buildSkillsPromptSection } =
  await import('@/server/skills/skillMd/index');
```

- Dynamischer Import verhindert Browser-Bundle-Einschluss
- Non-fatal: Bei Fehler wird einfach ohne Guidance weitergemacht
- Eligibility-Check läuft bei jeder Anfrage (OS, Env-Vars, Binaries)

---

## Neue Tests

| Datei                               | Tests | Abdeckung                                                                                    |
| ----------------------------------- | ----- | -------------------------------------------------------------------------------------------- |
| `tests/unit/skillMd-parser.test.ts` | 6     | Tier-1-Parse, Tier-2-Parse, fehlender Frontmatter, fehlende ID, fehlende Tier-2-Felder, CRLF |
| `tests/unit/skillMd-filter.test.ts` | 5     | Keine Einschränkungen, OS-Filter, `always`-Override, fehlende/vorhandene Env-Var             |
| `tests/unit/skillMd-prompt.test.ts` | 5     | Leere Rückgabe, Header, Emoji, Body-Filterung, 30k-Limit                                     |

**Gesamt: 17 neue Tests — alle grün.**

---

## Gefundene und behobene Probleme (Plananalyse)

Während der Planphase wurden 8 Probleme im ursprünglichen Entwurf identifiziert und behoben:

1. **Kein YAML-Parser** → `yaml`-Package hinzugefügt (war bereits installiert)
2. **Browser/Server-Split** → `index.ts` bleibt als Tool-Schema-Quelle (`fs`-frei)
3. **`mapSkillsToTools` braucht statische Module** → Tier-1 behält `index.ts` als Source of Truth
4. **5 Skills fehlten in `builtInSkills.ts`** → Expliziter Bugfix-Task
5. **8 Skills fehlten in `execute.ts`** → Expliziter Bugfix-Task
6. **Injection-Point unspezifiziert** → Genauer Punkt in `aiDispatcher.ts` identifiziert
7. **Kein Caching** → 10s TTL-Cache in `loader.ts`
8. **`import.meta.url` Guard-Fail** → Auf `process.cwd()`-basierte Auflösung umgestellt

---

## Validierung

```
npx tsc --noEmit   → 0 Fehler
npm test           → 17 neue Tests grün, keine Regressionen in bestehenden Tests
```

Pre-existing failures (`ws-client-stream-timeout`, `no-explicit-any-guard` für externen Test) sind unverändert und nicht durch diese Änderungen verursacht.
