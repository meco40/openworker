# Plan: Node.js aus dem Laufzeitpfad entfernen

Stand: 2026-10-29, Worktree `rust` (uncommitted). Ziel ist, dass das Rust-Gateway jeden
Request selbst beantwortet. Node.js bleibt danach nur noch Build-Werkzeug für die UI und
Entwicklungsserver mit HMR. In Produktion läuft kein Node-Anwendungsserver;
Node bleibt für aufgerufene Playwright-Werkzeuge im Image enthalten.

Verwandte Dokumente: `docs/RUST_MIGRATION.md` (Slices, Abschlusskriterien, offene Punkte).

## 1. Ist-Stand: was heute noch an Node geht

Ermittelt durch Abgleich aller `app/api/**/route.ts` mit den Rust-Routern, durch Lesen von
`server.ts`, `proxy.ts`, `app/**` und `next.config.ts`, und durch den Benchmark vom
2026-10-29.

### 1.1 HTTP-Routen

| Pfad                                | Wer braucht ihn                                                                                                                      | Heute                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| `/api/auth/[...nextauth]`           | `LoginForm.tsx` über `signIn('credentials')`: `GET /api/auth/providers`, `GET /api/auth/csrf`, `POST /api/auth/callback/credentials` | Node (next-auth v4)      |
| `/` (`app/page.tsx`)                | Server-Komponente: prüft die Session mit `auth()`, lädt `loadGatewayConfig()` für `initialView`, rendert `AppShell` (Client)         | Node (SSR)               |
| `/login` (`app/login/page.tsx`)     | Server-Komponente: leitet bei gültiger Session nach `/` um, sonst `LoginForm` (Client)                                               | Node (SSR)               |
| `/_next/static/*`, `public/*`, Icon | Jede Seite; rund 7 MB Bundles                                                                                                        | Node                     |
| `/_next/image`                      | `ChatInputArea.tsx`, `ChatMessageAttachment.tsx` nutzen `next/image` ohne `unoptimized`                                              | Node (Bild-Optimierer)   |
| `/_next/hmr`, Webpack-Dev           | Nur `pnpm run dev`                                                                                                                   | Node, per Upgrade-Tunnel |

Alle anderen 112 Routen-Dateien unter `app/api` beantwortet das Gateway selbst. Alle 38
WebSocket-Methoden sind in Rust vorhanden.

`/api/auth/session` ruft die UI nur einmal auf: `signIn()` aus `next-auth/react` lädt nach
erfolgreichem Login die Session neu. Es gibt keinen `SessionProvider`, kein `useSession`
und kein `signOut`. `/api/auth/signout` und `/api/auth/error` werden trotzdem portiert,
weil Skripte (`scripts/e2e/production-smoke.mjs`) und externe Clients sie nutzen können.

Die Next-Middleware `proxy.ts` greift nur für `/api/*`. Da das Gateway diese Pfade selbst
beantwortet und `/api/auth` dort öffentlich ist, hat sie im Rust-Betrieb keine Wirkung mehr.

### 1.2 Hintergrundjobs im Node-Prozess

`server.ts` startet auch mit `BETACLAW_DISABLE_WS=true` (Compose-Dienst `web-ui`) weiterhin
eigene Laufzeiten. Für drei davon gibt es keinen Rust-Gegenpart:

| Job                                        | TS-Quelle                                     | Rust                                                                                                                      |
| ------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Telegram-Polling der Persona-Bots          | `server.ts:276-288`, `startPersonaBotPolling` | Bausteine in `betaclaw-core` (`personas/telegram_bots.rs`, `channels/pairing/telegram_polling.rs`), kein Start im Gateway |
| Swarm-Orchestrator (`SWARM_RUNNER=server`) | `src/server/agent-room/swarmRuntime.ts`       | Bausteine in `betaclaw-core/src/agent_room`, keine Laufzeitschleife                                                       |
| Aufräumen der Task-Workspaces              | `src/server/tasks/workspaceCleanupRuntime.ts` | fehlt                                                                                                                     |

Dazu kommen Start-Prüfungen und Initialisierung, die nur diesen Jobs dienen
(`bootstrapMessageRuntime`, `ensureMemoryRuntimeReadyForStartup`), und das Aufräumen beim
Beenden (laufende Generierungen abbrechen, verwaltete Prozesse beenden).

Solange diese Jobs nur in Node laufen, ist Node fachlich nötig, auch wenn kein Request mehr
dorthin geht.

## 2. Zielbild

```text
Browser ──► Rust-Gateway :3000
             ├─ /api/**            nativ (inkl. /api/auth/*)
             ├─ /ws                nativ
             ├─ /, /login          statisches HTML aus out/, Auth-Weiche im Gateway
             ├─ /_next/static/**   Dateien aus out/, immutable gecacht
             └─ Hintergrundjobs    Gateway- bzw. Scheduler-Laufzeit

Node.js: UI-Build und HMR in der Entwicklung sowie bei Bedarf Playwright-Werkzeugprozesse.
```

Die UI wird mit `output: 'export'` als statische Dateien gebaut. Das Gateway liefert sie mit
`tower_http::services::ServeDir` aus. `tower-http` ist bereits Abhängigkeit; nötig ist nur
das Feature `fs`.

## 3. Phasen

Reihenfolge nach Nutzen und Abhängigkeit. Jede Phase ist für sich auslieferbar und über einen
Schalter rückholbar.

### Phase 1: `/api/auth/*` nativ in Rust

Nutzen: Login und Session ohne Node. Voraussetzung für Phase 2, weil der statische Export
keine next-auth-Route mehr enthält.

Umfang (Port von `src/auth.ts` und next-auth v4.24.15, Strategie `jwt`):

1. `GET /api/auth/providers`: statische Antwort für den Provider `credentials`.
2. `GET /api/auth/csrf`: Token erzeugen bzw. aus dem Cookie lesen. Cookie
   `next-auth.csrf-token` (mit `__Host-`-Präfix bei HTTPS) im Format
   `token|sha256(token + secret)`.
3. `POST /api/auth/callback/credentials`:
   - CSRF-Token aus Formular gegen Cookie prüfen, in konstanter Zeit (`subtle`).
   - Login-Limiter mit Schlüsseln `email:` und `ip:` wie `src/auth.ts` (Bausteine in
     `betaclaw-core/src/auth/limiter.rs`).
   - `verify_credentials` aus `betaclaw-core/src/auth/user_store.rs`.
   - Bei Erfolg Session-JWE ausstellen: `dir`/`A256GCM`, Schlüssel per HKDF wie in
     `auth/jwe.rs`, Claims `name`, `email`, `sub`, `id`, `iat`, `exp` (30 Tage), `jti`.
     Cookie `next-auth.session-token` (`__Secure-` bei HTTPS), `HttpOnly`, `SameSite=Lax`,
     `Path=/`, aufgeteilt mit `chunk_cookie_value`.
   - Antwort für `json=true`: `{ "url": ... }`, sonst 302. Fehlschlag: gleiche Antwort für
     gesperrte und falsche Zugangsdaten, wie heute.
4. `GET /api/auth/session`: Cookie dekodieren, `{ user: { name, email, id }, expires }`,
   Cookie mit neuem `exp` neu ausstellen (rollende Session wie next-auth `jwt`).
5. `POST /api/auth/signout`: CSRF prüfen, Session-Cookies löschen.
6. `GET /api/auth/error`, `GET /api/auth/signin`: Weiterleitung auf `/login` wie
   `pages.signIn`.

Vorhandene Bausteine: `aes-gcm`, `hkdf`, `sha2`, `subtle`, `getrandom`, `uuid` sind im
Workspace. Neu ist nur das Verschlüsseln in `auth/jwe.rs` (`encode_session_token`).

Prüfung (Pflicht, Sicherheitsgrenze):

- Fixture-Generator `scripts/fixtures/generate-nextauth-token.mjs` erweitern: echte
  `next-auth@4.24.15` erzeugt csrf- und Session-Werte, Rust muss sie annehmen.
- Gegenrichtung: Rust ausgestellte Cookies müssen von `getToken()` aus `next-auth/jwt`
  akzeptiert werden (Node-Skript im Test-Lauf, solange die TS-UI noch existiert).
- Neue Paritätsfamilie `auth` in `scripts/verify/parity/families/` für providers, csrf,
  Login (Erfolg, falsches Passwort, Sperre nach 10 Fehlversuchen), session, signout.
- E2E: `pnpm run test:e2e:browser` (Login-Flow) und `scripts/e2e/production-smoke.mjs`.

Rückweg: Familie `auth` in `families/cutover` aufnehmen, damit `BETACLAW_RUST_FAMILIES`
sie wieder an Node geben kann.

### Phase 2: Seiten als statischer Export

Nutzen: `/`, `/login`, `/_next/static/*` und `/_next/image` ohne Node. Das sind die meisten
Requests beim Laden einer Seite.

UI-Änderungen:

1. `app/page.tsx` wird Client-Seite:
   - Auth-Prüfung entfällt dort; das Gateway leitet um (siehe unten).
   - `initialView`: `AppShell` lädt `GET /api/config` (nativ) und ruft
     `resolveDefaultViewFromConfig`. Die Funktion hängt nur von `@/shared/**` ab und zieht
     nach `src/shared/config/` um. Bis zur Antwort einen Ladezustand zeigen, damit die
     Ansicht nicht springt.
2. `app/login/page.tsx`: Server-Prüfung entfällt; `LoginForm` in `<Suspense>`, weil
   `useSearchParams` im Export eine Suspense-Grenze verlangt.
3. `next.config.ts`:
   - `output: 'export'` und `images: { unoptimized: true }` für den Produktions-Build.
   - `headers()` gilt im Export nicht. Die Header übernimmt das Gateway.
   - Damit die TS-Routen (`route.ts`) den Export nicht brechen: im Export-Build
     `pageExtensions: ['tsx']` setzen. Dann zählen nur `page.tsx`/`layout.tsx`. Vorab
     geprüft: es gibt kein `route.tsx` und kein `page.ts`. Im ersten Schritt dieser Phase
     mit einem Probe-Build bestätigen.

Gateway-Änderungen:

1. `tower-http` Feature `fs`, `ServeDir` auf das Export-Verzeichnis (`UI_STATIC_DIR`).
   Reihenfolge im Router: `/__rust/health`, `/ws`, `/api/**`, dann statische Dateien, dann
   `404.html`.
2. Auth-Weiche für Seiten: `/` ohne gültige Session bei `REQUIRE_AUTH=true` 302 auf
   `/login?callbackUrl=...`; `/login` mit gültiger Session 302 auf `/`. Gleiche
   Session-Prüfung wie `auth_gate.rs`.
3. Header wie `next.config.ts`: `X-Content-Type-Options`, `X-Frame-Options`,
   `Referrer-Policy`, `Content-Security-Policy: frame-ancestors 'none'; base-uri 'self';
object-src 'none'`. Bei `DEMO_MODE=true` zusätzlich `X-Demo-Mode: true`.
4. Cache: `/_next/static/**` `public, max-age=31536000, immutable`; HTML `no-cache`.
5. Schalter `BETACLAW_UI_MODE=static|proxy`: `proxy` behält den heutigen Proxy als Rückweg
   und für `pnpm run dev`.

Prüfung: Playwright-Lauf gegen das Gateway im Modus `static`, Header-Test, Weiche-Tests
(mit/ohne Session, `REQUIRE_AUTH` an/aus), Cache-Header-Test.

### Phase 3: Hintergrundjobs nach Rust

Nutzen: Danach braucht Produktion keinen Node-Anwendungsserver mehr.

1. Telegram-Polling der Persona-Bots im Gateway starten, aus
   `PersonaTelegramBotRegistry` (nur `transport = polling`). Wichtig: Telegram erlaubt pro
   Bot nur einen `getUpdates`-Abnehmer. Node und Rust dürfen nie gleichzeitig pollen, sonst
   antwortet Telegram mit 409. Umschalten daher in einem Schritt: Rust startet, Node-Start
   in `server.ts` wird per Schalter abgeschaltet.
2. Swarm-Orchestrator als Rust-Laufzeit mit derselben `SWARM_RUNNER`-Semantik (`server`
   im Gateway, `scheduler` in `betaclaw-scheduler`).
3. Task-Workspace-Aufräumen als Intervall-Job im Scheduler.
4. Abbruch laufender Generierungen und Beenden verwalteter Prozesse beim Shutdown im
   Gateway prüfen und ergänzen, wo es fehlt.

Jeder Job bekommt einen Paritätstest gegen die TS-Implementierung und einen Eintrag in
`docs/RUST_MIGRATION.md`.

### Phase 4: Auslieferung ohne Node

1. `docker/Dockerfile.gateway`: zusätzliche Build-Stufe mit Node, die `next build` im
   Export-Modus ausführt; das Ergebnis wird ins Gateway-Image kopiert. Laufzeit-Image ohne
   Node.
2. `docker-compose.yml`: Dienst `web-ui` entfällt; `GATEWAY_UPSTREAM_ORIGIN` wird optional.
3. `scripts/dev-stack-rust.mjs`: `pnpm run dev` behält `next dev` für HMR (Modus `proxy`).
   Neues `pnpm run dev:static` baut den Export und startet nur das Gateway.
4. README und `AGENTS.md` anpassen.

Rückweg: ein Release lang bleibt `web-ui` als optionales Compose-Profil erhalten, und
`BETACLAW_UI_MODE=proxy` funktioniert weiter.

### Phase 5: Absicherung und Messung

1. Das Abgleich-Skript für Routen (heute im Scratchpad) nach
   `scripts/verify/route-coverage.mjs` übernehmen und in CI laufen lassen. Es schlägt fehl,
   wenn eine `app/api`-Route ohne Rust-Handler ist.
2. Benchmark wiederholen, beide Varianten unter gleichen Bedingungen (beide im
   Compose-Netz). Messgrößen: rps und p50/p95 pro Route, Seitenaufbau `/` mit allen
   Assets, RAM aller Prozesse.
3. Erst nach einer störungsfreien Release-Phase die TS-Backend-Dateien entfernen, gemäß den
   Abschlusskriterien in `docs/RUST_MIGRATION.md`. Für die Paritätsprüfungen bleibt bis
   dahin der Stand von `main` die Referenz.

## 4. Entscheidungen, die vor dem Start fallen müssen

1. **TS-Backend als Paritätsreferenz.** Die Paritätsskripte brauchen eine laufende
   TS-Implementierung. Empfehlung: Referenz ist ein Checkout von `main` (wie
   `.worktrees/bench-orig`), nicht der Laufzeit-Stack.
2. **Rollende Session.** next-auth stellt das Cookie bei jedem `/api/auth/session`-Aufruf
   neu aus. Die UI ruft die Route nur direkt nach dem Login auf. Empfehlung: Verhalten
   trotzdem gleich portieren, damit externe Clients nicht brechen.
3. **`/_next/image`.** Empfehlung: `unoptimized: true`. Die Bilder sind Anhänge
   (Blob-/API-URLs); ein Optimierer im Gateway lohnt nicht.

## 5. Risiken

| Risiko                                                        | Gegenmaßnahme                                                                 |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Cookie- oder CSRF-Format weicht von next-auth ab              | Fixtures aus echtem `next-auth@4.24.15`, Prüfung in beide Richtungen          |
| Schwächere Login-Sperre oder Konto-Enumeration                | Limiter-Port 1:1, gleiche Antwort für Sperre und falsches Passwort, Tests     |
| Statischer Export bricht an Server-Features                   | Probe-Build zu Beginn von Phase 2; `pageExtensions` trennt Routen und Seiten  |
| Doppeltes Telegram-Polling (409) beim Umschalten              | Umschalten in einem Schritt mit Schalter, Start-Log prüfen                    |
| Ansicht springt, weil `initialView` erst nach dem Laden kommt | Ladezustand bis `/api/config` antwortet                                       |
| Rückweg nötig                                                 | `BETACLAW_UI_MODE=proxy`, Cutover-Familie `auth`, `web-ui` als Compose-Profil |

## 6. Erwarteter Effekt

Grundlage ist der Benchmark vom 2026-10-29. Dort waren durchgereichte Routen langsamer als
das Original (`/login` 132 statt 172 rps, `/api/auth/session` 368 statt 571 rps), nativ
beantwortete 2- bis 6-mal schneller. Nach Phase 1 und 2 gibt es im Produktionsbetrieb keine
durchgereichten Routen mehr. Nach Phase 4 entfällt der Node-Prozess der UI (im Benchmark
136 bis 268 MB RSS); das Gateway lag bei rund 22 MiB. Diese Zahlen sind eine Erwartung und
werden in Phase 5 gemessen.

## 7. Umfang grob

| Phase | Umfang | Hauptarbeit                                                          |
| ----- | ------ | -------------------------------------------------------------------- |
| 1     | mittel | JWE-Verschlüsselung, CSRF, fünf Endpunkte, Fixtures, Paritätsfamilie |
| 2     | mittel | zwei Seiten umbauen, `ServeDir`, Weiche, Header, Probe-Build         |
| 3     | groß   | drei Laufzeiten portieren, Umschalten ohne Doppelbetrieb             |
| 4     | klein  | Dockerfile, Compose, Dev-Skript, Doku                                |
| 5     | klein  | CI-Check, Benchmark, Aufräumen nach Release-Phase                    |

## 8. Umsetzungsstand (2026-10-29)

Die Implementierung der Nacharbeiten F1–F25 steht in
[RUST_NODE_ELIMINATION_FIXES.md](RUST_NODE_ELIMINATION_FIXES.md). Die dortigen
Prüfergebnisse ersetzen frühere pauschale Abschlussmeldungen.

- Auth: echte NextAuth-Fixtures und Kreuzprüfung von Login, Session, CSRF,
  Rate-Limit und Logout. Fixture-Schreiben ist explizit; CI prüft Kompatibilität.
- UI: getrennte Node-/Export-Builds; Rust liefert Dateien mit ServeDir,
  Range/HEAD, Last-Modified/ETag/304, Kompression, Cache- und Sicherheits-Headern.
  Seiten-Weiche gilt in static und proxy; UI-Modus wird einmal aufgelöst.
- Jobs: ein gemeinsamer Besitzer je Job; Telegram bestätigt den Offset erst nach
  erfolgreicher Inbound-Runde. Swarm-Turns werden über Agent-v2 dispatcht,
  abgeschlossen und bei Fehlern wiederholt. Cleanup gehört dem Scheduler.
  Job-Stopp wartet bis zu fünf Sekunden auf die laufende Runde.
- Lieferung: Rust-Gateway und Rust-Scheduler als Standard; `web-ui` bleibt im
  Profil `legacy-node-ui`. Python sowie Node/Playwright/Chromium bleiben als
  Werkzeuglaufzeiten im Image. Die Aussage „das Image enthält kein Node“ ist
  deshalb zurückgenommen.
- Prüfungen: Route-Coverage liest exportierte TS-Methoden per AST und deklarierte
  Rust-Pfade/Methoden per Quelltextparser, einschließlich eines echten negativen
  CLI-Tests. Das beweist deklarierte Abdeckung, keine vollständige Verhaltensparität.
  Echte Auth- und Swarm-Vergleiche ergänzen die bestehenden Paritätsfamilien.
  Produktions-Smoke und Benchmark verwenden die aktuelle Compose-Topologie.

Aktuelle Gate-Ergebnisse, Messwerte und verbleibende externe Grenzen:
[RUST_MIGRATION.md](RUST_MIGRATION.md). Historische Testzahlen gelten nur für den
jeweils bezeichneten Stand; Testzahl oder Route-Coverage allein belegen keinen
vollständigen Produktions-Cutover.
