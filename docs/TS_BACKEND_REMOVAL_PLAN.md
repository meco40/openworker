# Plan: Entfernen des TypeScript-Backends

Stand: 2026-11-01 · Ausgangscommit `273c7879` (Tag `legacy-ts-backend`) · **Umgesetzt**: alle Phasen, Ergebnis in `docs/RUST_MIGRATION.md` Abschnitt 7

## Ziel

Das alte TypeScript-Backend wird gelöscht. Danach gibt es nur noch ein Backend (Rust) und
eine UI (Next.js als statischer Export). Rust-Code muss das TypeScript nicht mehr Zeile für
Zeile spiegeln.

Abnahme:

- `src/server`, `app/api`, `server.ts`, `scheduler.ts`, `proxy.ts` und `src/auth.ts` sind
  gelöscht.
- Kein produktiver oder Test-Pfad startet Node als Anwendungsserver.
- Compose, CI, E2E-Lanes und die Ops-Befehle laufen nur gegen Rust.
- Die Verhaltensprüfungen, die heute TS mit Rust vergleichen, gibt es weiter, aber als
  feste Referenzdaten.

## Was nicht entfällt

Diese Verträge bestehen unabhängig vom TS-Backend und bleiben:

- das Format des NextAuth-Session-Cookies (`app/login/LoginForm.tsx` nutzt `signIn` aus
  `next-auth/react`; bestehende Sessions bleiben gültig). Das Paket `next-auth` bleibt für den
  Client, die Fixture `nextauth_parity` bleibt.
- SQLite-Schemas mit `_migrations`, die World-Model-SQL-Dateien, RLS-Rollen und Grants
- das WS-Protokoll `v2` und die JSON-Formate der API (UI und CLI)
- JavaScript-Semantik in Rust (`js.rs`, `js_string`, `js_trim`), soweit sie gespeicherte Daten
  oder Wire-Formate betrifft

## Bestandsaufnahme

| Bereich           | Befund                                                                                                                                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TS-Backend        | `src/server` mit 734 Dateien und 85.520 Zeilen, 113 `app/api/**/route.ts`, `server.ts`, `scheduler.ts`, `proxy.ts`, `src/auth.ts`                                                                                                                                                          |
| Laufzeit, Compose | Der Dienst `migrate` baut das Node-Image (`Dockerfile` im Repo-Root) und führt `scripts/world-model-migrate.ts` und `scripts/world-model-provision-roles.ts --apply` aus. **Der Standard-Stack hängt damit heute noch an TS.** Rust hat `apply_migrations`, aber kein Rollen-Provisioning. |
| Laufzeit, Dateien | Die 19 World-Model-Migrationen liegen in `src/server/world-model/migrations`. Rust liest sie von dort (`betaclaw-world-model/src/world_model/migrations.rs:57`, `betaclaw-gateway/src/scheduler_runtime.rs:446`).                                                                          |
| CLI               | `src/cli` importiert aus `src/server/gateway/*`: `protocol`, `events`, `method-scopes`, `exec-approval-manager`, `node-command-policy`                                                                                                                                                     |
| Übrige `src`      | `src/lib/persona-templates.ts` importiert `personas/personaTypes`. `src/commands` und `src/logging` werden nur von `app/api` benutzt. `src/core`, `src/shared`, `src/skills`, UI-Module: keine Importe aus `src/server`.                                                                   |
| E2E               | `test:e2e:smoke` (`tests/e2e/_shared/managedServer.ts`) und `test:e2e:browser` (`scripts/e2e/start-e2e-server.ts`, importiert `server.ts`) laufen **gegen das Node-Backend**. Nur `test:e2e:production` prüft Rust.                                                                        |
| Paritäts-Suite    | `verify:route-parity` (16 Familien in `scripts/verify/parity/families`, CI gegen das Release-Binary) und `verify:logs-parity` importieren TS-Module als Referenz                                                                                                                           |
| Vitest            | 444 von 666 Testdateien importieren `@/server` (unit 370/538, integration 65/111, e2e 3/8, contract 1/2). Coverage-Gate und Ausschlussliste in `vitest.config.ts` beziehen sich auf `src/server/**`.                                                                                       |
| Ops-Skripte       | 26 Skripte importieren `src/server`: `world-model:*` (13), `memory:*` (4), `knowledge:ingest`, `attachments:consistency`, `workspaces:cleanup`, `fixtures:gemini-traffic`, `mem0-factual-memory-audit`, `ci/main-policy-check.ts` (`harnessDomainRegistry`), `ci/cleanup-low-risk.mjs`     |
| Dev-Stack         | `dev:node`, `dev:web`, `dev:web-ui`, `dev:scheduler`, `start:web`, `start:scheduler`, `scripts/dev-stack.mjs`, Compose-Profil `legacy-node-ui`, Schalter `BETACLAW_*=node`                                                                                                                 |
| Build             | `next.config.ts:67` nimmt `src/server/skills/handlers/**` in das Output-Tracing auf                                                                                                                                                                                                        |

## Phasen

Jede Phase endet mit grünen Gates und einem eigenen Commit. Bis Phase 5 bleibt der TS-Code
im Repo, damit Phase 2 noch Referenzdaten aus ihm erzeugen kann.

### Phase 0: Sicherung

1. Tag `legacy-ts-backend` auf den letzten Commit mit vollständigem TS-Backend setzen. Er ist
   der Rückweg, kein Branch zum Weiterpflegen.
2. In `docs/RUST_MIGRATION.md` festhalten: Ab hier gibt es keinen Node-Rückfall mehr.

### Phase 1: Laufzeit-Abhängigkeiten lösen

1. **SQL-Migrationen verschieben** nach `rust/crates/betaclaw-world-model/migrations/`
   (`git mv`, Inhalt unverändert, `_world_model_migrations` merkt sich Dateinamen). Default-Pfad
   an beiden Rust-Stellen ändern. Das Gateway-Image kopiert den Ordner.
2. **Rollen-Provisioning nach Rust portieren**, aus `scripts/world-model-provision-roles.ts`
   (Rollen `world_model_app`, `world_model_worker`, Passwörter aus der Umgebung, Grants).
   Ein Subcommand, etwa `betaclaw-scheduler migrate [--provision-roles]`, führt Migration und
   Provisioning aus. Sicherheitsgrenze: gleiche Grants, Admin-Credentials nur im Dienst
   `migrate`.
3. **Compose:** `migrate` nutzt das Gateway-Image und dieses Subcommand. Danach braucht
   `docker-compose.yml` ohne Legacy-Profil kein Node-Image mehr. `world-model:verify-rls`
   prüft die Grants vorher und nachher gleich.
4. **CLI-Typen nach `src/shared/gateway/` verschieben**: `protocol`, `events`,
   `method-scopes`, `exec-approval-manager`, `node-command-policy`. Ebenso
   `personas/personaTypes` für `src/lib/persona-templates.ts`. Prüfen, ob die beiden
   Policy-Dateien reine Daten und Funktionen sind und nichts aus dem Server-Laufzeitzustand
   brauchen.

Gates: `rust:*`, `typecheck`, `lint`, `test`, `test:e2e:production` (frische Volumes, prüft
Migration und Rollen).

### Phase 2: Tests von TS auf Rust umstellen

1. **E2E-Lanes auf das Rust-Gateway umstellen.** `managedServer.ts` und
   `start-e2e-server.ts` starten das Gateway im Static-Modus (`out/` aus `build:export`) mit dem
   vorhandenen Mem0-Mock. Erst danach prüfen Smoke (11) und Browser-E2E (69) das Backend, das
   wirklich läuft. **Rote Tests sind hier echte Rust-Abweichungen**: in Rust beheben, nicht im
   Test.
2. **Paritäts-Suite auf Referenzdaten umstellen.** Mit dem noch vorhandenen TS-Code
   die Referenzantworten jeder Familie einmal als JSON unter
   `scripts/verify/parity/golden/<familie>.json` aufnehmen (Werte wie IDs und Zeitstempel
   normalisiert, wie es der Harness schon tut). Danach vergleichen die Familien Rust gegen diese
   Dateien. Der CI-Schritt „Route parity against the release binary“ bleibt. Gleiches für
   `verify:logs-parity`.
3. **Vitest aufteilen.** Die 444 Dateien mit `@/server` gehören zum TS-Backend und werden in
   Phase 5 gelöscht. Vorher je Domäne abgleichen, ob ein Fall ein Verhalten prüft, das Rust
   nicht testet. Solche Fälle als Rust-Test nachziehen. Rust hat heute 3540 Tests. Die übrigen
   222 Dateien (UI, Shared, CLI) bleiben.
4. `nextauth-reverse-parity.test.ts` und `agent-room-rust-parity.test.ts` prüfen: Die erste
   bleibt (Cookie-Vertrag mit `next-auth`). Die zweite wird ein Referenzdaten-Test wie in 2.

Gates: alle E2E-Lanes gegen Rust grün, Paritäts-Suite gegen Referenzdaten grün.

### Phase 3: Ops-Skripte

Je Skript eine von drei Entscheidungen. Vorschlag:

| Skript                                                                                                       | Vorschlag                                                               |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `world-model:migrate`, `world-model:provision-roles`                                                         | Rust-Subcommand (Phase 1)                                               |
| `world-model:verify-rls`, `world-model:reconcile`, `world-model:rebuild-projections`, `world-model:backfill` | Rust-Subcommand (Betrieb, Wiederherstellung)                            |
| `knowledge:ingest`, `workspaces:cleanup`, `attachments:consistency`                                          | Aufruf einer Gateway-Route, wo es sie gibt; sonst Subcommand            |
| `world-model:runtime-evidence`, `world-model:lifecycle`, `world-model:rollout-gate`, `world-model:drill`     | prüfen, ob noch gebraucht; sonst löschen                                |
| `memory:migrate-to-postgres`, `memory:backfill-channel-scope`, `world-model:rekey-chat-sources`              | löschen (einmalige Datenmigration, bereits gelaufen?)                   |
| `memory:reset`, `memory:cleanup-noise`, `mem0-factual-memory-audit`                                          | prüfen, ob noch gebraucht                                               |
| `world-model:graphiti-evaluate`, `world-model:benchmark-embeddings`, `fixtures:gemini-traffic`               | Werkzeuge der Migration, löschen oder als Rust-Beispiel                 |
| `ci/main-policy-check.ts`                                                                                    | `harnessDomainRegistry` nach `src/shared` oder `scripts/ci` verschieben |
| `ci/cleanup-low-risk.mjs`                                                                                    | Pfadeintrag `src/server/` entfernen                                     |

Die Tabelle braucht vor Phase 3 eine Entscheidung des Teams. `README.md` und `AGENTS.md`
listen die Befehle; sie werden mitgeändert.

### Phase 4: Dev-Stack und Schalter

1. Löschen: `dev:node`, `dev:web`, `dev:web-ui`, `dev:scheduler`, `start:web`,
   `start:scheduler`, `scripts/dev-stack.mjs`, Compose-Profil `legacy-node-ui` und das Root-`Dockerfile`,
   wenn es danach niemand mehr baut.
2. `BETACLAW_TELEGRAM_POLLER`, `BETACLAW_SWARM_RUNNER`, `BETACLAW_WORKSPACE_CLEANUP`: nur noch
   `rust` und `off`. Default wird `rust` (heute: `node`, wenn nicht gesetzt). `node` als Wert
   gibt eine klare Fehlermeldung beim Start.
3. `BETACLAW_UI_MODE=proxy` bleibt für `pnpm run dev` (Next-Dev-Server für UI-HMR); der
   Next-Server liefert dann nur noch Seiten.

### Phase 5: Löschen

1. `src/server`, `app/api`, `server.ts`, `scheduler.ts`, `proxy.ts`, `src/auth.ts`,
   `src/commands`, `src/logging` und die 444 Testdateien löschen.
2. `next.config.ts` (Output-Tracing), `vitest.config.ts` (Coverage-Pfade und
   Ausschlussliste) und die Architektur-Guards (`test:architecture:guards`) anpassen.
3. Abhängigkeiten aufräumen, die nur das TS-Backend brauchte (zum Beispiel `better-sqlite3`,
   `pg`, `@google/genai`). Prüfen mit einem Lauf von `knip` oder `depcheck` gegen den neuen Stand,
   nicht nach Liste.
4. `scripts/verify/route-coverage.mjs` prüfen: Es vergleicht heute die TS-Routen mit den
   Rust-Routen. Danach ist die Rust-Routentabelle die einzige Quelle.

Gates: alle aus `AGENTS.md`, dazu alle E2E-Lanes und die Paritäts-Suite.

### Phase 6: Rust-Regeln lockern

1. `AGENTS.md`: Die Regeln „Port behaviour, not just signatures“ und „Every Rust module names
   the TypeScript file it mirrors“ werden ersetzt durch: Verhalten ist durch Rust-Tests,
   Referenzdaten und E2E festgelegt.
2. Die rund 630 Modulköpfe mit `Port of src/...` bleiben als Historie. Sie werden nur
   angepasst, wenn das Modul ohnehin geändert wird.
3. `docs/RUST_MIGRATION.md` abschließen: Status, S13 als erledigt, Verweis auf diesen Plan.

## Reihenfolge und Aufwand

| Phase | Abhängig von | Grobe Größe | Risiko                                                   |
| ----- | ------------ | ----------- | -------------------------------------------------------- |
| 0     | —            | klein       | keins                                                    |
| 1     | 0            | mittel      | Grants beim Provisioning; durch `verify-rls` abgesichert |
| 2     | 1            | groß        | E2E gegen Rust deckt Abweichungen auf (gewollt)          |
| 3     | 1            | mittel      | braucht Entscheidungen; einzelne Skripte unabhängig      |
| 4     | 2, 3         | klein       | Default-Wechsel der Schalter                             |
| 5     | 2, 3, 4      | mittel      | vergessene Importe; Typecheck und Build finden sie       |
| 6     | 5            | klein       | keins                                                    |

Phase 2 und Phase 3 können parallel laufen, sie berühren verschiedene Dateien.

## Offene Entscheidungen

1. Braucht noch jemand den Node-Rückfall (Profil `legacy-node-ui`)? Der Plan setzt „nein“
   voraus.
2. Ops-Skripte: die Tabelle in Phase 3.
3. Sind die einmaligen Datenmigrationen (`memory:migrate-to-postgres`,
   `world-model:rekey-chat-sources`, `memory:backfill-channel-scope`) auf allen Installationen
   gelaufen? Wenn nicht, vorher ausführen oder nach Rust portieren.
