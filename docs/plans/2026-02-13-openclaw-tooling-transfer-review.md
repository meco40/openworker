# OpenClaw Tooling Transfer Review (validierter Reality-Check)

**Stand:** 2026-02-13  
**Scope:** Validierung der vorherigen Analyse gegen den aktuellen Code in `D:\web\clawtest` und Ableitung von Maßnahmen mit echtem Mehrwert.

## 1) Validierung: Was ist wirklich ein Problem?

| Thema | Realitätsstatus | Evidenz im Code | Mehrwert bei Fix/Übernahme | Aufwand |
|---|---|---|---|---|
| Externe Skills sind nicht End-to-End ausführbar | **Bestätigt** | `skills/definitions.ts`, `skills/execute.ts`, `src/server/skills/executeSkill.ts` nutzen statische Built-in-Mappings; `handlerPath` wird nur gespeichert (`src/server/skills/skillRepository.ts`) | **Sehr hoch** | **Hoch** |
| `handlerPath` wird nicht runtime-seitig geladen | **Bestätigt** | `src/server/skills/skillInstaller.ts` schreibt `handlerPath`; keine Ausführung darüber | **Sehr hoch** | **Mittel-Hoch** |
| Tool-Namensdrift zwischen Laufzeitpfaden | **Bestätigt** | Worker: `browser_fetch`, `search_web` (`src/server/worker/workerExecutor.ts`), Registry/Skills: `browser_snapshot` | **Hoch** | **Mittel** |
| Pfad-Sicherheitscheck mit `startsWith` ist unsauber | **Bestätigt** | `src/server/skills/handlers/fileRead.ts`, `src/server/skills/handlers/dbQuery.ts`; Prefix-Kollision reproduzierbar (`clawtest` vs `clawtest2`) | **Sehr hoch (Security)** | **Niedrig** |
| Security-Logik für Tool-Ausführung ist fragmentiert | **Bestätigt** | Blockliste in `shellExecute.ts`, separater Approval-Flow im Worker `workerExecutor.ts` | **Mittel-Hoch** | **Mittel** |
| Runtime-Config ist statisch/hardcoded | **Bestätigt** | `SKILL_RUNTIME_CONFIG_FIELDS` in `src/server/skills/runtimeConfig.ts` | **Mittel** | **Mittel** |
| OpenClaw-Optional/Channel-Tool-System direkt übernehmen | **Teilweise relevant** | Für OpenClaw sinnvoll, für aktuelle WebApp kein Top-Hebel | **Niedrig-Mittel** | **Hoch** |

## 2) Wo unsere WebApp heute bereits besser ist

1. **Konsequente Auth-Gates auf Skills/ClawHub-Routen**
   - `resolveRequestUserContext()` ist auf relevanten Routen durchgezogen, z. B. `app/api/skills/route.ts`, `app/api/clawhub/search/route.ts`, `app/api/skills/runtime-config/route.ts`.

2. **Gute UX für Runtime-Konfiguration**
   - Required-Config-Gating vor Aktivierung ist vorhanden (`skills/SkillsRegistry.tsx`: Aktivierung wird bei fehlenden Pflichtwerten blockiert).
   - Klarer Hinweistext für fehlende Credentials (z. B. Vision/GitHub/SQLite).

3. **Breite Testabdeckung in den kritischen Bereichen**
   - ClawHub: `tests/unit/clawhub/*`, `tests/integration/clawhub/clawhub-routes.test.ts`
   - Skill Runtime Config: `tests/unit/skills/runtime-config-store.test.ts`, `tests/integration/skills/runtime-config-route.test.ts`
   - UI/Registry-Logik: `tests/unit/skills/skills-registry.test.ts`, `tests/unit/skills/tool-guides.test.ts`

4. **Windows-robuste ClawHub-CLI-Fallbacks sind bereits umgesetzt**
   - Launcher-Kaskade + `cmd.exe`-Fallback bei `spawn EINVAL` in `src/server/clawhub/clawhubCli.ts`.

## 3) Welche OpenClaw-Ideen wirklich übernommen werden sollten

1. **Dynamische Tool Registry (statt statischer Skill-Listen)**
   - Höchster Hebel.
   - Ziel: Tool-Definitionen und Handler aus DB + Built-ins zur Laufzeit auflösen.

2. **Einheitlicher Dispatcher für Chat, Rooms, Worker**
   - Vermeidet Namensdrift und unterschiedliche Sicherheitsregeln.
   - Worker-spezifische Tools bleiben möglich, aber über gemeinsame Kernregistrierung.

3. **Policy-Layer als zentraler Sicherheitsmechanismus**
   - Nicht zwingend OpenClaw 1:1, aber Prinzip übernehmen: zentrale Allow/Deny-Entscheidung statt pro Handler.

4. **Prompt-Lane (ClawHub) beibehalten**
   - Ist bereits gut integriert (`clawhubPromptBuilder` + Runtime-Injektion), nur feinjustieren.

## 4) Priorisierte Umsetzung nach ROI

1. **P0: Security-Fix für Pfadprüfung**
   - `startsWith(workspaceRoot)` in `fileRead`/`dbQuery` auf `path.relative`-Prüfung umstellen.
   - Aufwand: niedrig, Nutzen: sehr hoch.

2. **P1: Tool-Namen und Tool-Schema zentralisieren**
   - Eine gemeinsame Tool-Konstante für `browser_snapshot`, `file_read`, `shell_execute`, usw.
   - Worker darauf umstellen (Alias-Phase möglich für Rückwärtskompatibilität).

3. **P2: Externe Skills ausführbar machen**
   - Loader für `handlerPath` implementieren.
   - `mapSkillsToTools` und `executeSkillFunctionCall` auf DB-basierte, dynamische Registry umbauen.

4. **P3: Security-/Policy-Konsolidierung**
   - Einheitliches Gate für Risk-Level, Approval, erlaubte Kommandos.
   - Einmal entscheiden, überall anwenden (API/Chat/Rooms/Worker).

5. **P4: Runtime-Config dynamisieren**
   - Konfigurationsfelder aus Manifest/Schema ableiten.
   - Aktuelles statisches Feldset als Fallback behalten.

## 5) Was nicht priorisiert werden sollte

1. **Vollständige OpenClaw-Toolparität**
   - Für euren Scope aktuell zu viel Komplexität bei begrenztem Mehrwert.

2. **Komplette Channel-/Plugin-Orchestrierung wie OpenClaw**
   - Erst sinnvoll, wenn Multi-Channel- und Subagent-Orchestrierung im Kernziel steht.

## 6) Fazit (korrigiert)

Der größte reale Hebel ist nicht ein weiteres UI-Refinement, sondern die technische Lücke zwischen **Skill-Installation** und **Skill-Ausführung**.  
Die Punkte mit sofortigem Mehrwert sind:
- Pfad-Sicherheitsfix,
- zentrale Tool-Namen,
- dynamische Runtime-Registry für externe Skills,
- einheitlicher Security-/Policy-Dispatcher.

Damit erreicht ihr messbar mehr Stabilität, weniger Inkonsistenz und echte Nutzbarkeit der installierten Skills.
