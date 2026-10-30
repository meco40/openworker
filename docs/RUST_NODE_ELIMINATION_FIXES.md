# Plan: Nacharbeiten zur Node-Eliminierung

Stand: 2026-10-29, Worktree `rust` (uncommitted). F1–F25 und die zusätzlich im
[Review](RUST_NODE_ELIMINATION_REVIEW.md) gefundenen Laufzeit- und Prüflücken
werden hier nachverfolgt. Die folgenden Planabschnitte dokumentieren die ursprüngliche
Abnahme. Konkrete Prüfergebnisse und Grenzen stehen in
[RUST_MIGRATION.md](RUST_MIGRATION.md).

## 0. Befundliste & Status

Implementierungsstand nach den Korrekturen. „Umgesetzt“ bezeichnet den Code;
vollständige Gates, Browser, Image und Produktions-Smoke werden separat belegt.

| Nr. | Schwere  | Befund                                                                                   | Ort (ursprünglicher Reviewstand)                                  | Korrektur                                                                                                                |
| --- | -------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| F1  | kritisch | Persona-Poller verwirft Telegram-Updates, setzt aber den Offset weiter                   | `rust/crates/betaclaw-gateway/src/persona_poller.rs:170`          | umgesetzt: Telegram-HTTP-Attrappe, echte Inbound-Verarbeitung in Reihenfolge, Offset nur nach Erfolg, DB-Pfad aus Config |
| F2  | kritisch | Ohne Schalter pollen Rust und Node gleichzeitig (Telegram 409)                           | `persona_poller.rs:63`, `server.ts:282`                           | umgesetzt: Gemeinsame Besitzer-Semantik in Rust, Node-Server und Node-Scheduler; normalisierte Rollenwahl                |
| F3  | kritisch | Swarm-Tick ist ein Stub; Rust-Start setzt laufende Node-Swarms auf `hold`                | `rust/crates/betaclaw-gateway/src/swarm_runtime.rs:131`, `:48`    | umgesetzt: Swarm-Dispatch, Completion/Replay/Command-Result, Phasen, Retry/Rate-Limits und TS/Rust-Trace                 |
| F4  | kritisch | `pnpm run dev` liefert die im Image eingebackene UI statt `next dev` (kein HMR)          | `scripts/dev-stack-rust.mjs:180`, `static_ui.rs:26`               | umgesetzt: Dev startet im Proxy-Modus und reicht Next-HMR weiter                                                         |
| F5  | hoch     | Offene Weiterleitung über `callbackUrl` (Präfixvergleich statt Origin)                   | `rust/crates/betaclaw-gateway/src/routes/auth.rs:125`             | umgesetzt: Callback-URL mit Origin-Prüfung und Angriffsfällen getestet                                                   |
| F6  | hoch     | Gegenprüfung fehlt: kein Test liest ein Rust-Cookie mit `next-auth/jwt`                  | `tests/unit/gateway/nextauth-reverse-parity.test.ts`              | umgesetzt: Pflicht-Fixture, Rust → next-auth decode/getToken/CSRF; Schreiben nur per Opt-in                              |
| F7  | hoch     | CSRF-Fixture wird nachgerechnet, nicht von next-auth erzeugt                             | `scripts/fixtures/generate-nextauth-token.mjs:74`                 | umgesetzt: CSRF/JWE aus echtem AuthHandler, serialisiertes Cookie; CI prüft semantisch statt Zufallsbytes                |
| F8  | hoch     | Paritätsfamilie `auth` fragt nur Rust ab; Login, Sperre, Session mit Cookie fehlen       | `scripts/verify/parity/families/auth.mjs`                         | umgesetzt: Echter NextAuth-Handler samt App-authorize gegen Rust: Login, Kreuz-Cookies, Fehler, Sperre, Logout           |
| F9  | hoch     | `route-coverage.mjs` ist eine feste Präfixliste, liest keine Rust-Router, nicht in CI    | `scripts/verify/route-coverage.mjs`                               | umgesetzt: TS-Export-AST gegen Rust-Pfad/Methoden; dynamische Segmente, Catch-all, CLI-Negativtest und CI                |
| F10 | hoch     | `build` exportiert immer; `web-ui`-Image hat keine API-Routen, Rückweg kaputt            | `package.json:53`, `Dockerfile:31`                                | umgesetzt: build und build:export getrennt; Root-Image enthält Node-APIs                                                 |
| F11 | hoch     | Seiten-Weiche nur im Modus `static`; im Modus `proxy` ist `/` ohne Login erreichbar      | `static_ui.rs:141`, `app/page.tsx`                                | umgesetzt: Seiten-Weiche vor static/proxy-Auswahl; 16-Fälle-Matrix inklusive Login-Redirect                              |
| F12 | mittel   | Limiter zählt Fehlversuche auch bei Sperre und bei leeren Feldern (TS nicht)             | `routes/auth.rs:283-297`                                          | umgesetzt: Leere/gesperrte Logins zählen nicht; zehn Fehlversuche und korrekte gesperrte Anmeldung getestet              |
| F13 | mittel   | Bot-Token kann über reqwest-Fehler ins Log gelangen                                      | `persona_poller.rs:136`                                           | umgesetzt: Reqwest-URLs entfernt und Token im Fehlertext redigiert; Regressionstest                                      |
| F14 | mittel   | Keine Kompression der statischen Dateien                                                 | `proxy.rs` (Router), `static_ui.rs`                               | umgesetzt: Kompression nur auf statischen Antworten; gzip-Verhalten getestet                                             |
| F15 | mittel   | Eigene Dateiauslieferung statt `ServeDir`: kein ETag, kein 304, keine Range-Anfragen     | `static_ui.rs:113`                                                | umgesetzt: ServeDir streamt Range/HEAD/kodierte Pfade; Last-Modified/ETag und 304 getestet                               |
| F16 | mittel   | Umgebung und `exists()` werden pro Request neu gelesen                                   | `static_ui.rs:139-140`                                            | umgesetzt: Modus und Verzeichnis einmal in AppState aufgelöst                                                            |
| F17 | mittel   | `/api/auth/csrf` ohne `Cache-Control: private, no-cache, no-store`                       | `routes/auth.rs:218`                                              | umgesetzt: CSRF-Antwort mit privaten No-cache-Headern; Regressionstest                                                   |
| F18 | mittel   | `x-forwarded-proto` vom Client schaltet Cookie-Namen und `Secure`                        | `routes/auth.rs:40`, `static_ui.rs:82`                            | umgesetzt: Cookie-Sicherheit nur anhand NEXTAUTH_URL; Header-Gegenprobe                                                  |
| F19 | mittel   | `server.ts` beantwortet `/api/health` fest mit `{ok:true}`                               | `server.ts:245`                                                   | umgesetzt: Node-Health-Kurzschluss entfernt                                                                              |
| F20 | mittel   | Paritätsfamilie `config` löscht ungefragt `/app/.local/gateway-config.db`                | `scripts/verify/parity/families/config.mjs:170`                   | umgesetzt: Config-Parität stellt den ursprünglichen Zustand per API wieder her                                           |
| F21 | mittel   | `dev:static` baut den Export nicht und nutzt das alte `out/` im Image                    | `scripts/dev-stack-rust.mjs:362`                                  | umgesetzt: dev:static baut den Export bei jedem Start neu                                                                |
| F22 | klein    | `pnpm@latest` im Gateway-Dockerfile, Root-Dockerfile pinnt `10.30.1`                     | `docker/Dockerfile.gateway:10`                                    | umgesetzt: pnpm 10.30.1 gepinnt                                                                                          |
| F23 | klein    | `std::env::set_var` im Test kollidiert mit parallelen Tests                              | `static_ui.rs:266`                                                | umgesetzt: UiMode::parse reine Funktion; Tests ohne globale Umgebungsänderung                                            |
| F24 | klein    | Weitere Abweichungen von next-auth (Format `expires`, CSRF-Fehlerantwort, `x-real-ip`)   | `routes/auth.rs`                                                  | umgesetzt: Session-Format, CSRF-Fehler, IP-Auswertung und Löschen ungültiger Cookie-Chunks korrigiert                    |
| F25 | Doku     | „ABGESCHLOSSEN“ für Phase 3 und Phase 5 Punkt 1 trifft nicht zu; Schalter undokumentiert | `docs/RUST_NODE_ELIMINATION_PLAN.md` §8, `docs/RUST_MIGRATION.md` | umgesetzt: Abschlussdokumentation beschreibt tatsächliche Nachweise und Node als Playwright-Werkzeuglaufzeit             |

Zusätzlich korrigiert: Tool-Laufzeiten Python/Playwright/Chromium im Rust-Image,
stabile Fixture-CI, aktuelle Rust-Compose-Smoke-Topologie samt echtem Swarm-Turn,
Scheduler-/API-/Health-Zugriff auf dieselbe Automationsdatenbank, Cleanup nur im
Scheduler, JSON-404 bei unbekannten API-Pfaden und begrenztes Drain laufender Jobs.

Der Standard-Stack startet Rust-Gateway und Rust-Scheduler. Das Image enthält
Node für explizit aufgerufene Playwright-Werkzeuge; ein Node-Anwendungsserver ist
nur im optionalen Profil `legacy-node-ui` aktiv.

### Nachprüfung am Code (2026-10-30)

Die Punkte, die in der Migrationsdoku noch als offen standen, wurden am Code geprüft:

- **F3, A3 (Swarm):** umgesetzt. Orchestrator und die drei Dienste `turn_dispatch`,
  `turn_completion`, `swarm_resolution` liegen in `betaclaw-core`. `SwarmRuntime::tick_once`
  dispatcht, prüft Completion über Replay und Command-Result, zählt Retries und wendet
  Rate-Limits an. Die Recovery läuft nur bei `BETACLAW_SWARM_RUNNER=rust`. `llmFriction` ist im
  Orchestrator-Pfad nicht aufgerufen, deshalb entfällt A3 Schritt 4. Abgrenzung: Die Parität
  `swarm` vergleicht über eine gemeinsame Trace-Datei (TS-Test und Rust-Test), nicht über zwei
  live laufende Server.
- **A5 (Shutdown):** Persona-Poller und Swarm stoppen über `BackgroundTask` mit fünf Sekunden
  Drain. Der Scheduler (`AutomationRuntime`, Prospective-Timer) brach den Tick bisher mit
  `abort()` ab und gab den Lease frei, während der Tick noch lief. Er wartet jetzt auf den
  laufenden Tick, bevor der Lease frei wird. Test `automation_stop_waits_for_the_in_flight_tick`.
  Der Heartbeat-Ticker in `main.rs` bleibt beim `abort()`. Er schreibt keinen Zustand.
- **F8 (Parität `auth`):** umgesetzt. Die Familie prüft Login, Kreuz-Cookies, falsches
  Passwort, Sperre, Signout und CSRF. Der Lauf schließt jetzt den globalen Auth-Store, bevor
  das Scratch-Verzeichnis gelöscht wird. Unter Windows verhinderte das vorher einen Abschluss.
- **F9 (Routen-Abdeckung):** umgesetzt. `route-coverage.mjs` liest die TS-Exporte per AST und
  prüft gegen die Rust-Router. Ergebnis: 188 Verträge, Selbsttest besteht, CI-Schritt vorhanden.
- **F14 (Kompression):** umgesetzt. `CompressionLayer` liegt nur auf der statischen Auslieferung.
  Test mit `Accept-Encoding: gzip`.
- **F23 (`set_var`):** in `static_ui` umgesetzt. `UiMode::parse` ist eine reine Funktion. Andere
  Tests außerhalb von `static_ui` setzen weiterhin Umgebungsvariablen (`clawhub.rs`,
  `chat_runtime/mod.rs`, `skill_md/filter.rs`). Das ist nicht Teil von F23.
- **E7 (Block E Punkt 7):** umgesetzt. Im Modus `static` liefert ein unbekannter `/api/*`-Pfad
  404 als JSON statt 502.

Zusätzlich gefunden und behoben: Der Check 8 des World-Model-Health (`checks.scheduler`) fehlte
im Rust-Port. Er ist jetzt portiert, inklusive der Statusfolge (veraltete Lease degradiert,
fehlende Lease degradiert, Lesefehler `unavailable`). Die Parität `ops` prüft ihn.

## 1. Leitlinien für alle Schritte

- Verhalten portieren, nicht Signaturen. Jedes neue Rust-Modul nennt die TS-Datei, die es
  spiegelt.
- Vorhandene Bausteine zuerst: `TelegramInbound::process_update`, die Agent-v2-Ports in
  `betaclaw-core/src/channels/ws/ports.rs`, `MessageRepository` in `messages_store`.
- Keine neue Abhängigkeit, wenn eine vorhandene reicht. `tower-http` hat die Features `fs`
  und, falls nötig, `compression-gzip`/`compression-br`.
- Sicherheitsgrenzen nicht abschwächen: Limiter, CSRF, Cookie-Namen, Loopback-Marker.
- Pro Block einmal die Gates laufen lassen, nicht pro Schritt.

## 2. Block A: Hintergrundjobs korrekt machen (F1, F2, F3, F13)

Ziel: Produktion ohne Node verliert keine Telegram-Nachricht und führt Swarms weiter.

### A1. Ein Besitzer pro Job, ein Schalter für beide Prozesse (F2)

Problem: Der Rust-Poller und der Rust-Swarm sind ohne Schalter an. Node ist ohne Schalter
ebenfalls an. Beide laufen dann parallel.

Schritte:

1. Gemeinsame Semantik festlegen. Ein Schalter je Job, den beide Prozesse lesen:
   - `BETACLAW_TELEGRAM_POLLER=node|rust|off`, Standard `node`.
   - `BETACLAW_SWARM_RUNNER=node|rust|off`, Standard `node`.
   - `BETACLAW_WORKSPACE_CLEANUP=node|rust|off`, Standard `node`.
     Rust läuft nur bei `rust`, Node nur bei `node`. Damit gibt es bei gleichem Wert in beiden
     Prozessen nie zwei Besitzer.
2. Rust: `PersonaPoller::parse_enabled` so ändern, dass nur `rust` aktiviert. Gleiches in
   `SwarmRuntime::parse_should_run` (heute `unwrap_or("rust")`) und in
   `WorkspaceCleanup::start` (heute nur `TASK_WORKSPACES_CLEANUP_ENABLED`).
   `SWARM_RUNNER=server|scheduler` bleibt die Rollenwahl innerhalb von Rust.
3. Node (`server.ts`): die drei Prüfungen auf `=== 'node'` (bzw. leer) umstellen. Der
   Sammelschalter `BETACLAW_NODE_BACKGROUND_JOBS=off` bleibt als Notschalter.
4. Compose: die drei Schalter in den Anker `x-runtime-env` aufnehmen, damit `gateway`,
   `scheduler` und das Profil `legacy-node-ui` denselben Wert sehen. Werte erst nach A2 bzw.
   A3 auf `rust` setzen.
5. Dev-Stack (`scripts/dev-stack-rust.mjs`): die drei Schalter name-only an den
   Gateway-Container durchreichen (`-e BETACLAW_TELEGRAM_POLLER` usw.), Node erbt sie aus
   `.env.local`.
6. Start-Log in beiden Prozessen: eine Zeile pro Job mit dem Besitzer, zum Beispiel
   `[telegram-poller] owner=rust`.

Tests:

- Rust: Tabellentest für `parse_enabled` / `parse_should_run` mit `None`, `node`, `rust`,
  `off`, Großschreibung, Leerzeichen.
- TS: Unit-Test für eine kleine Hilfsfunktion `resolveJobOwner(name)` in `server.ts`
  (auslagern nach `src/server/runtime/jobOwner.ts`), gleiche Tabelle.

### A2. Persona-Poller verarbeitet Updates (F1, F13)

Problem: `poll_bot_once` liest nur `update_id` und schreibt den Offset. Die Nachricht geht
verloren. TS ruft für jedes Update `processTelegramInboundUpdate(update, { botId, personaId,
token })` auf.

Schritte:

1. `TelegramUpdateStub` durch den vollständigen Typ `TelegramUpdate` aus
   `betaclaw-core/src/channels/pairing` ersetzen.
2. Den Poller mit einem `Arc<TelegramInbound>` bauen, nicht mit einem nackten
   `reqwest::Client`. Quelle ist der Inbound, den `ChannelPairing` mit dem echten
   `TelegramBridge` (`families/channels_wire/inbound.rs`) baut. Nicht den
   `OpsNoopTelegramInbound` aus `ops_wire` verwenden. In `main.rs` den Poller erst starten,
   wenn `state.channels` gesetzt ist.
3. Pro Update `inbound.process_update(&update, Some(&TelegramBotContext { bot_id,
persona_id, token }))` aufrufen, in Reihenfolge, wie TS.
4. Offset-Regel wie TS: `max_update_id` über alle Updates, Offset nach der Schleife
   schreiben. Bei einem Fehler in `process_update` die Runde abbrechen und den Offset
   beibehalten (wie TS: Catch erst um den ganzen Zyklus).
5. `allowed_updates` aus der vorhandenen Konstante
   `betaclaw_core::channels::adapters::telegram::api::TELEGRAM_ALLOWED_UPDATES` erzeugen
   statt des fest eingetragenen Query-Strings.
6. Token-Schutz (F13): `getUpdates` als POST mit JSON-Body wie `telegram_polling.rs`; im
   Fehlerfall `err.without_url()` loggen. Kein `%err` mit URL.
7. DB-Pfad aus `state.config.personas_db_path` statt eigener Umgebungsvariable.
8. Duplikat-Token: Warnung nur einmal pro Token und Prozess, nicht in jedem 2-s-Zyklus.

Tests:

- Unit-Test mit `ScriptedTransport` (aus `pairing/test_support.rs`): zwei Updates, beide
  erreichen den Port, Offset = letzte `update_id` + 1.
- Unit-Test: Fehler im Port, Offset-Verhalten wie TS.
- Unit-Test: Fehlermeldung enthält den Token nicht.
- Integrationstest mit einer Telegram-Attrappe (lokaler HTTP-Server statt
  `api.telegram.org`). TS kennt keine konfigurierbare Basis-URL; in Rust die Basis-URL als
  Konstruktor-Parameter des Pollers führen (Standard `https://api.telegram.org`), im Test
  auf die Attrappe setzen. Keine neue Umgebungsvariable.

### A3. Swarm-Orchestrator portieren (F3)

Problem: `tick_once` loggt nur. TS führt `runOrchestratorOnce()` aus
(`src/server/agent-room/orchestrator.ts`), das `dispatchNextTurn` und `checkTurnCompletion`
aufruft. Zusätzlich setzt der Rust-Start laufende Swarms auf `hold`, auch wenn Node sie gerade
ausführt.

Schritte:

1. Neues Modul `betaclaw-core/src/agent_room/orchestrator.rs`, spiegelt
   `orchestrator.ts`:
   - `processing`-Menge und `retry_counters` (max. 3) als Zustand des Laufzeit-Objekts.
   - Rate-Limit-Erkennung mit demselben Muster
     (`429|too many requests|rate.limit|resource.exhausted`, ohne Groß/Klein).
   - Nach 3 Fehlern `status = error`, `hold_flag = true`, Broadcast
     `AGENT_ROOM_SWARM` mit `protocol v2`.
2. Dienste portieren, je ein Modul unter `agent_room/services/`:
   - `turn_dispatch.rs` ← `turnDispatch.service.ts` (211 Zeilen).
   - `turn_completion.rs` ← `turnCompletion.service.ts` (226 Zeilen).
   - `swarm_resolution.rs` ← `swarmResolution.service.ts`.
     Vorhandene Bausteine nutzen: `agent_session.rs`, `swarm_artifact.rs`,
     `conflict_radar.rs`, `swarm_phases.rs`, `MessageRepository::{get,update}_agent_room_swarm`.
3. Agent-v2-Aufrufe (`getSession`, `startSession`, `enqueueInput`, `enqueueFollowUp`,
   `replaySessionEvents`, `getCommandResult`) über die Ports in
   `betaclaw-core/src/channels/ws/ports.rs` bzw. `agent_v2/session/*` abbilden. Fehlende
   Operation: im Port ergänzen, nicht direkt in die Tabellen schreiben.
4. `llmFriction.service.ts` nutzt `@google/genai`. Prüfen, ob der Orchestrator-Pfad es
   aufruft. Falls ja: über den Model-Hub-Gateway in Rust leiten, nicht direkt Gemini.
5. `swarm_runtime.rs`: `tick_once` ruft den Orchestrator. Erster Tick sofort nach dem Start
   wie TS (`void this.tick()`), dann Intervall.
6. Recovery nur ausführen, wenn Rust Besitzer ist (A1). Damit setzt Rust nie einen
   Swarm auf `hold`, den Node gerade führt.
7. `tokio::time::interval` mit `MissedTickBehavior::Skip` statt `sleep`, damit lange Ticks
   sich nicht stauen.

Tests:

- Unit-Tests je Dienst mit In-Memory-SQLite (`messages_store`) und Fake-Ports: Dispatch
  ohne `current_deploy_command_id`, Completion mit Ergebnis, Retry-Zähler, Rate-Limit ohne
  Zähler, Fehlerstatus nach 3 Versuchen.
- Paritätsfamilie `swarm` in `scripts/verify/parity/families/`: denselben Swarm in TS und
  Rust anlegen, Ticks auslösen, Status und Phasen-Puffer vergleichen.

### A4. Workspace-Aufräumen absichern

1. `run_once` ist synchron und blockiert den Tokio-Worker. In `tokio::task::spawn_blocking`
   ausführen; Start-Lauf ebenfalls.
2. Besitzer-Regel aus A1 anwenden.
3. Test: verwaiste und aktive Verzeichnisse in einem Temp-Root, nur verwaiste werden gelöscht,
   `max_removals` greift.

### A5. Shutdown

1. `PersonaPollerHandle::stop` und `SwarmRuntimeHandle::stop` brechen heute hart ab
   (`abort`). Ein halb verarbeitetes Update oder ein halber Tick kann verloren gehen. Wie
   `telegram_polling.rs` eine Generation bzw. das Stopp-Flag prüfen und auf das Ende der
   Runde warten (mit Zeitlimit, z. B. 5 s), erst dann `abort`.
2. Plan-Punkt 3.4 (laufende Generierungen abbrechen, verwaltete Prozesse beenden) prüfen und
   im Shutdown von `main.rs` ergänzen, wo es fehlt.

Abnahme Block A: Gates grün, neue Tests grün, Paritätsfamilien `swarm` und ein Telegram-Test
gegen die Attrappe grün. Danach in Compose die drei Schalter auf `rust`.

## 3. Block B: Sicherheit im Login (F5, F12, F17, F18, F24)

### B1. Offene Weiterleitung schließen (F5)

1. `sanitize_callback_url` wie der next-auth-Standard-`redirect`-Callback:
   - beginnt mit `/` (und nicht `//` oder `/\`): `base_url + url`.
   - sonst `url::Url` parsen (Crate prüfen: `url` ist über reqwest im Lockfile, als direkte
     Abhängigkeit aufnehmen) und `origin` mit `base_url` vergleichen.
   - alles andere: `base_url`.
2. Tests: `http://localhost:3000.evil.com/`, `http://localhost:3000@evil.com/`, `//evil.com`,
   `/\evil.com`, `javascript:alert(1)`, gültiger Pfad, gültige absolute URL.

### B2. Limiter wie TS (F12)

1. Leere E-Mail oder leeres Passwort: `None` ohne `record_failure`.
2. Gesperrt: `None` ohne `record_failure`.
3. Nur bei falschen Zugangsdaten beide Schlüssel zählen.
4. Fehlerantwort bleibt für Sperre und falsches Passwort gleich.
5. Tests: je Fall Zählerstand prüfen; zehn Fehlversuche sperren, der elfte mit richtigem
   Passwort scheitert mit derselben Antwort.

### B3. Cookie-Entscheidung nur über `NEXTAUTH_URL` (F18)

1. `use_secure_cookies` wie next-auth: nur `nextauth_url.starts_with("https://")`.
   `x-forwarded-proto` nicht mehr auswerten, auch nicht in `static_ui::is_authenticated`.
2. Eine gemeinsame Funktion in `auth_gate.rs` bzw. `betaclaw-core::auth` für Cookie-Namen,
   die `routes/auth.rs`, `static_ui.rs` und `auth_gate.rs` nutzen. Heute gibt es drei Stellen.
3. Test: Header `x-forwarded-proto: https` ändert Cookie-Name und `Secure` nicht.

### B4. Antwort-Header und Formate (F17, F24)

1. `/api/auth/csrf`: `Cache-Control: private, no-cache, no-store`, `Pragma: no-cache`,
   `Expires: 0` wie next-auth.
2. `/api/auth/session`: `expires` mit Millisekunden und `Z` (`to_rfc3339_opts(Millis, true)`).
3. CSRF-Fehler beim Login: next-auth antwortet mit Status 200 und
   `{url: "<base>/api/auth/signin?csrf=true"}`. Gleich übernehmen; `LoginForm` behandelt
   beide Fälle als Fehlschlag.
4. Falsche Zugangsdaten: next-auth antwortet 401 mit
   `<base>/api/auth/error?error=CredentialsSignin&provider=credentials`. Gleich übernehmen.
5. `x-real-ip` nicht auswerten (TS liest nur `x-forwarded-for`).
6. Session-Cookie zusätzlich mit `Expires` wie next-auth.
7. Ungültiges Session-Cookie bei `/api/auth/session`: Cookie löschen wie next-auth.
8. JSON-Body: `json` als String `"true"` und als Bool akzeptieren, Standard `false`
   (heute `unwrap_or(true)`).

Abnahme Block B: neue Tests grün, Paritätsfamilie `auth` (Block C) grün.

## 4. Block C: Prüfungen, die beweisen, was sie behaupten (F6, F7, F8, F9, F20)

### C1. Fixtures aus echtem next-auth (F7)

1. `scripts/fixtures/generate-nextauth-token.mjs`: CSRF über den echten Handler erzeugen,
   nicht mit `crypto` nachrechnen. Weg: `AuthHandler` aus `next-auth/core` mit
   `action: 'csrf'` aufrufen und `csrfToken` sowie das `Set-Cookie` lesen. Den Cookie-Wert
   unverändert (URL-kodiert, `%7C`) in die Fixture schreiben.
2. Rust muss beide Schreibweisen lesen: `|` und `%7C`. `extract_cookie` in
   `routes/auth.rs` dekodiert Prozent-Kodierung wie `next/headers`. Test mit beiden Formen.
3. Freshness-Check in CI für die Fixture (Regel aus AGENTS.md) prüfen bzw. ergänzen.

### C2. Gegenprüfung Rust → next-auth (F6)

1. Neuer Rust-Test `writes_rust_issued_session_fixture` in `tests/nextauth_parity.rs`, der
   ein Rust-Token und ein Rust-CSRF-Cookie nach
   `tests/fixtures/rust-issued-session-token.json` schreibt (nur mit Umgebung
   `BETACLAW_WRITE_FIXTURES=1`, sonst Vergleich mit der eingecheckten Datei).
2. `tests/unit/gateway/nextauth-reverse-parity.test.ts` liest diese Datei:
   - `decode()` aus `next-auth/jwt` akzeptiert das Rust-Token, Claims stimmen.
   - `getToken()` mit einem Request-Objekt und dem Cookie-Namen akzeptiert es.
   - Das Rust-CSRF-Cookie wird von `createCSRFToken` (next-auth) als gültig erkannt.
3. Bestehenden Test, der nur das next-auth-Token dekodiert, umbenennen oder löschen; er
   prüft next-auth gegen sich selbst.

### C3. Paritätsfamilie `auth` wirklich vergleichen (F8)

`scripts/verify/parity/families/auth.mjs` nach dem Muster von `config.mjs` (TS-Aufruf plus
Rust-Aufruf, Vergleich):

1. providers: gleiche Struktur.
2. csrf: beide liefern 64 Hex-Zeichen und ein Cookie im Format `token|hash`.
3. Login richtig: Status, `url`, Session-Cookie vorhanden; anschließend
   `/api/auth/session` mit diesem Cookie in **beiden** Implementierungen (Kreuztest).
4. Login falsch: Status und `error`-Parameter gleich.
5. Sperre: zehn Fehlversuche, elfter mit richtigem Passwort scheitert, gleiche Antwort.
6. Session ohne Cookie: `{}`.
7. signout mit gültigem CSRF: Cookies gelöscht.
8. CSRF falsch: gleiche Antwort.
   Testkonto über Umgebung (`AUTH_DEFAULT_EMAIL`, Passwort nur aus `.env.local`), nie im
   Skript.

### C4. Routen-Abdeckung echt prüfen (F9)

1. `scripts/verify/route-coverage.mjs` durch die Variante ersetzen, die die Rust-Router liest
   (`.route("/api/…", get(…).post(…))`) und pro `route.ts` die exportierten Methoden
   (`GET`, `POST`, …) vergleicht. Grundlage ist das Skript aus dem Review.
2. Catch-all (`[...nextauth]`) gegen die explizit registrierten `/api/auth/*`-Pfade
   abgleichen: Liste der next-auth-Aktionen, die die UI und Skripte nutzen.
3. Dynamische Segmente: `[id]` ↔ `{id}` normalisieren.
4. Ausgabe: fehlende Methode pro Route, Exit 1 bei Lücke.
5. In `.github/workflows/ci.yml` als Schritt aufnehmen.
6. Selbsttest: eine Attrappe `route.ts` ohne Rust-Handler im Temp-Verzeichnis lässt das
   Skript fehlschlagen.

### C5. Paritätsfamilie `config` ohne Löschen (F20)

1. Den `docker exec … rm -f /app/.local/gateway-config.db` entfernen.
2. Stattdessen eine eigene Config-DB für den Lauf: Gateway-Container der Paritätsläufe mit
   `GATEWAY_CONFIG_DB_PATH` auf eine Temp-Datei starten, oder den Ausgangszustand über
   `PUT /api/config` mit der vorher gelesenen Revision wiederherstellen.
3. Wenn Löschen nötig bleibt: nur hinter `--reset-config` und nur, wenn der Container-Name
   auf `-parity` endet.

## 5. Block D: Rückweg und Entwicklung (F4, F10, F11, F19, F21)

### D1. Build-Skripte trennen (F10)

1. `package.json`:
   - `build`: wieder `next build --turbopack` (Node-Build mit API-Routen; Validierung in
     AGENTS.md und Root-`Dockerfile` nutzen ihn).
   - neu `build:export`: `cross-env NEXT_EXPORT=true next build --turbopack`.
2. `docker/Dockerfile.gateway`, Stufe `ui-builder`: `pnpm run build:export`.
3. Root-`Dockerfile` bleibt bei `pnpm run build`; damit funktioniert das Profil
   `legacy-node-ui` wieder.
4. Probe: `pnpm run build` erzeugt `.next` mit API-Routen; `pnpm run build:export` erzeugt
   `out/` mit `index.html` und `login.html`.

### D2. Seiten-Weiche in beiden Modi (F11)

1. In `static_fallback` die Weiche für `GET /` und `GET /login` vor die Modus-Prüfung ziehen,
   sodass sie auch im Modus `proxy` gilt.
2. Gleiche Regeln wie früher in `app/page.tsx` und `app/login/page.tsx`:
   - `/` ohne Session und mit `REQUIRE_AUTH=true`: 302 auf `/login?callbackUrl=%2F`.
   - `/login` mit gültiger Session: 302 auf `/`, unabhängig von `REQUIRE_AUTH` (wie die
     frühere Login-Seite).
3. RSC-Anfragen (`RSC: 1`, `?_rsc=`) und Prefetch nicht umleiten, sondern 401 für `/` ohne
   Session; sonst lädt der Client eine HTML-Umleitung als RSC.
4. Tests mit `tower::ServiceExt::oneshot`: Modus `static` und `proxy` × mit/ohne Session ×
   `REQUIRE_AUTH` an/aus × `/` und `/login`.

### D3. Dev-Stack im richtigen Modus (F4, F21)

1. `scripts/dev-stack-rust.mjs`, Docker-Weg:
   - normaler Modus: `-e BETACLAW_UI_MODE=proxy` setzen.
   - `--static`: vorher `pnpm run build:export` ausführen, `-e BETACLAW_UI_MODE=static` und
     `-v <repo>/out:/app/out:ro` mounten, damit das aktuelle `out/` gilt und nicht das im
     Image.
2. Host-Binary-Weg: dieselben Umgebungswerte setzen.
3. `UiMode::from_env`: Standard ohne Schalter bleibt automatisch, aber Start-Log mit Modus
   und Verzeichnis (`[ui] mode=static dir=/app/out`), damit der Modus sichtbar ist.
4. Prüfung: `pnpm run dev`, Datei in `app/` ändern, HMR greift; `pnpm run dev:static` liefert
   `out/` vom Host.

### D4. `/api/health` in Node (F19)

1. Den festen `{ok:true}`-Kurzschluss in `server.ts` entfernen. Falls er für einen
   Healthcheck des `web-ui`-Containers gebraucht wird: eigenen Pfad `/__node/health` ohne
   Daten, analog `/__rust/health`, und den Healthcheck im Profil `legacy-node-ui` darauf
   umstellen.

## 6. Block E: Statische Auslieferung schneller (F14, F15, F16, F23)

1. `ServeDir` aus `tower_http::services` (Feature `fs` ist bereits aktiv) für
   `/_next/static/**` und die übrigen Dateien unter `out/` einsetzen. Liefert ETag/
   `Last-Modified`, 304, Range und HEAD. Die Weiche (D2) und die Header bleiben davor.
2. Cache-Header per `SetResponseHeader`-Layer bzw. eigener `map_response`:
   `/_next/static/**` immutable, HTML und `.txt` `no-cache`, Rest `max-age=86400`.
3. Kompression: `tower-http` Features `compression-gzip` und `compression-br`,
   `CompressionLayer` nur auf den statischen Teil (nicht auf `/ws`, nicht auf SSE-Routen).
   Alternativ `ServeDir::precompressed_br()/precompressed_gzip()` mit beim Export erzeugten
   `.br`/`.gz`-Dateien; das spart CPU zur Laufzeit. Entscheidung nach Messung (Block F).
4. Modus und Verzeichnis einmal beim Start auflösen und in `AppState` (oder als
   `Extension`) ablegen; kein `env::var` und kein `exists()` pro Request (F16).
5. Prozent-kodierte Pfade: `ServeDir` dekodiert selbst. Test für eine Datei mit `[` im
   Namen, falls der Export solche erzeugt.
6. Test ohne `std::env::set_var` (F23): `UiMode::parse(Option<&str>, index_exists: bool)`
   als reine Funktion testen.
7. `/api/*` ohne Rust-Handler im Modus `static`: 404 JSON statt Proxy auf eine nicht
   vorhandene Upstream-Adresse (heute 502).

## 7. Block F: Auslieferung, Doku, Messung (F22, F25)

1. `docker/Dockerfile.gateway`: `corepack prepare pnpm@10.30.1 --activate` wie das
   Root-Dockerfile (F22). `NODE_ENV=production` erst nach `pnpm install` setzen, damit
   Dev-Abhängigkeiten für den Build sicher installiert sind.
2. `.env.local.example`, README und `AGENTS.md`: Schalter `BETACLAW_TELEGRAM_POLLER`,
   `BETACLAW_SWARM_RUNNER`, `BETACLAW_WORKSPACE_CLEANUP`, `BETACLAW_UI_MODE`,
   `UI_STATIC_DIR`, Bedeutung der Werte, Umschalten in einem Schritt.
3. `AGENTS.md`: Satz „answers 100% of requests natively“ erst nach Block A stehen lassen;
   bis dahin den Stand ehrlich beschreiben. `pnpm run dev` beschreibt den Proxy-Modus,
   `pnpm run dev:static` den Export.
4. `docs/RUST_NODE_ELIMINATION_PLAN.md` §8 und `docs/RUST_MIGRATION.md` korrigieren (F25):
   Phase 3 und Phase 5 Punkt 1 als offen markieren, Verweis auf dieses Dokument; nach jedem
   Block den Stand und die Testzahl nachtragen.
5. Benchmark wiederholen (Plan Phase 5.2): beide Varianten im Compose-Netz, `/` mit allen
   Assets, `/api/auth/session`, `/api/health`, RAM aller Prozesse. Container
   `betaclaw-bench-gateway` mit dem neuen Image neu erzeugen. Ergebnisse in
   `RUST_MIGRATION.md`.

## 8. Reihenfolge und Abnahme

| Schritt | Inhalt                                | Voraussetzung | Abnahme                                                                |
| ------- | ------------------------------------- | ------------- | ---------------------------------------------------------------------- |
| 1       | A1 Schalter                           | –             | Tabellentests Rust und TS; Start-Log zeigt genau einen Besitzer je Job |
| 2       | B1, B2, B3, B4                        | –             | neue Rust-Tests grün                                                   |
| 3       | D1, D2, D3, D4                        | –             | `build` und `build:export` getrennt; Weiche-Tests; HMR im Dev-Stack    |
| 4       | C1 bis C5                             | 2             | Fixtures aus next-auth; Kreuztest; `auth`-Parität; Coverage in CI      |
| 5       | A2 Poller                             | 1             | Telegram-Attrappe: Updates erreichen den Port; Token nicht im Log      |
| 6       | A3, A4, A5 Swarm, Aufräumen, Shutdown | 1             | Parität `swarm`; Aufräum-Test; Shutdown ohne verlorene Runde           |
| 7       | Compose-Schalter auf `rust`           | 5, 6          | Compose ohne `web-ui`: Telegram-Nachricht und Swarm laufen durch       |
| 8       | E statische Auslieferung              | 3             | 304 und Kompression nachgewiesen; keine Umgebung pro Request           |
| 9       | F Doku, Dockerfile, Benchmark         | 7, 8          | Doku stimmt mit Code; Benchmark-Tabelle aktualisiert                   |

Gates nach jedem Block einmal: `pnpm run rust:fmt:check`, `pnpm run rust:clippy`,
`pnpm run rust:test`, `pnpm run typecheck`, `pnpm run lint`, `pnpm run test`,
`pnpm run verify:route-coverage`, `pnpm run verify:route-parity`. Vor Schritt 7 zusätzlich
`pnpm run test:e2e:browser` und `scripts/e2e/production-smoke.mjs` gegen Compose ohne
`web-ui`.

## 9. Umfang grob

| Block | Umfang | Hauptarbeit                                                        |
| ----- | ------ | ------------------------------------------------------------------ |
| A     | groß   | Orchestrator-Port (rund 500 TS-Zeilen), Poller an Inbound anbinden |
| B     | klein  | Redirect-Prüfung, Limiter, Header, Tests                           |
| C     | mittel | Fixture über next-auth-Handler, Kreuztest, Paritätsfamilie, CI     |
| D     | klein  | Skripte trennen, Weiche verschieben, Dev-Stack-Schalter            |
| E     | klein  | `ServeDir`, Kompression, Start-Auflösung                           |
| F     | klein  | Dockerfile, Doku, Benchmark                                        |
