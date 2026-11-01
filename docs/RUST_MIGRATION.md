# Backend-Migration nach Rust

Status: Migration abgeschlossen, das TypeScript-Backend ist entfernt (letzter Stand mit TS: Tag `legacy-ts-backend`, `273c7879`); externe Produktionsfreigabe nicht belegt
Letzte Aktualisierung: 2026-11-01

Ziel: Das produktive Backend gehört Rust. HTTP, WebSocket, Auth, Geschäftslogik,
Datenzugriff, Integrationen sowie Scheduler und Hintergrundjobs. Next.js/React/TypeScript
bleiben Benutzeroberfläche (statischer Export im Gateway). Es laufen nur Rust-Gateway und Rust-Scheduler. Node bleibt für aufgerufene Playwright-Werkzeuge im Image enthalten; einen Node-Anwendungsserver gibt es nicht mehr.

## 1. Bestandsaufnahme

| Bereich       | Befund                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend-Logik | `src/server` 77.362 LOC in 731 Dateien: channels 15.647, world-model 11.371, knowledge 8.714, master 7.235, model-hub 5.787, memory 5.739, skills 4.469, agent-v2 3.042, stats 2.426, gateway 2.202, tasks 2.117, automation 1.568                                                                                                                                                                                          |
| HTTP          | 113 `app/api/**/route.ts` (10.566 LOC). Gate `proxy.ts` nur für `/api/*`. 81/113 `withUserContext`, 32 handgerollt (`resolveMasterUserId`, `resolveAutomationUserId`, Webhook-HMAC, interne Token)                                                                                                                                                                                                                          |
| WebSocket     | `server.ts:120-213`. Endpunkt `/ws?protocol=v2`, JSON-Frames `req`/`res`/`event`/`stream`, 38 Methoden, 29 Events, 5 Verbindungen/User (429), 16 MB Payload, 600 req/min, Backpressure >1,5 MB → 1008, Tick 30 s, Ping/Pong-Sweep                                                                                                                                                                                           |
| Auth          | NextAuth v4 Credentials + JWT. Session-Cookie ist JWE `dir`/`A256GCM`, Key = HKDF-SHA256(`NEXTAUTH_SECRET`, salt=Cookie-Name, info=`NextAuth.js Generated Encryption Key (…)`, 32 B). Users in `.local/auth.db`, scrypt (N=16384, r=8, p=1, 64 B) mit Legacy-SHA256-Upgrade. Login-Limiter 10 Fehlversuche/15 min pro E-Mail und IP. `proxyPolicy.ts` erzwingt Loopback-Peer + Host + Fetch-Metadata                        |
| Persistenz    | SQLite (`better-sqlite3`) ca. 19 DBs mit TS-Code-Migrationen (`_migrations`), Pragmas WAL/foreign_keys/busy_timeout 30 s (`src/server/db/sqlite.ts:41-77`). PostgreSQL/pgvector nur World-Model (`src/server/world-model/db.ts`), 19 `.sql`-Dateien + `_world_model_migrations` + `pg_advisory_lock`, RLS-Rollen `world_model_app`/`world_model_worker`, Tenant-Scope über `world_model_set_scope($1,$2,$3)` je Transaktion |
| Scheduler     | `scheduler.ts`: Automation-Tick 15 s, Knowledge-Ingestion, Outbox-Dispatcher 10 s, Prospective-Runtime, Embedding-Worker 30 s, Projection-Retry 30 s, Swarm-Orchestrator über `SWARM_RUNNER`. Lease in `automation_scheduler_lease`                                                                                                                                                                                         |
| Integrationen | Fast alles rohes `fetch`. Einziger echter SDK ist `@google/genai` (5 Stellen). Playwright/Python/Shell über `child_process`                                                                                                                                                                                                                                                                                                 |
| Tests         | 726 Dateien / 81.406 LOC. 368 importieren `@/server/*` tieflinks. 79 nutzen echtes SQLite `:memory:`. Coverage-Gate 70 % mit ca. 90 Ausschlusspfaden. 2 Architektur-Guards parsen TS-Imports                                                                                                                                                                                                                                |
| Infra         | `node:22-bookworm-slim`, Compose `postgres` + `migrate` + `web` + `scheduler`, 3 Volumes. Vor Projektstart kein Rust-Toolchain im Repo                                                                                                                                                                                                                                                                                      |

Bleibt dauerhaft TypeScript (UI, ca. 50k LOC, sauber von `src/server` getrennt, null Importe):
`src/modules`, `src/components`, `src/messenger`, `src/skills` (Manifeste), `app/page.tsx`,
`app/login`, `next.config.ts`.

## 2. Zielarchitektur

```
Browser / CLI
     │  http://127.0.0.1:3000   ws://127.0.0.1:3000/ws?protocol=v2
     ▼
┌───────────────────────────────────────────────┐
│ betaclaw-gateway  (Rust, axum)  :3000        │  ← besitzt Port, Auth-Gate,
│  /ws    → nativer WS-Gateway                  │    Tenant-Scope, RLS
│  /api/* → migriert: Rust | Rest: Reverse-Proxy│
│  Rest   → Reverse-Proxy                       │
└───────────────┬───────────────────────────────┘
                │ http://127.0.0.1:3001  (nur Übergang)
                ▼
┌───────────────────────────────────────────────┐
│ web-ui  (Next.js: UI + nicht migrierte API)   │
└───────────────────────────────────────────────┘
┌───────────────────────────────────────────────┐
│ betaclaw-scheduler (Rust)  ohne Port          │  ← ersetzt scheduler.ts
└───────────────────────────────────────────────┘
```

Entscheidung: Rust besitzt Port 3000 ab Slice S0. Gründe — eine Front-Door,
`ws://…:3000/ws?protocol=v2` bleibt unverändert, `src/lib/betaclaw/client.ts:38` und
`src/cli/lib/gatewayRpc.ts` brechen nicht, Auth-Gate und Tenant-Scope liegen an genau
einer Stelle. Jede andere Topologie erzeugt zwei Auth-Pfade.

Next.js zieht auf Port 3001 um und wird Compose-Service `web-ui`.

## 3. Technologie-Entscheidungen

| Baustein          | Wahl                                                                                       | Begründung, geprüfte Version                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP/WS-Framework | axum 0.8.9 + tokio + tower/tower-http                                                      | `ws`-Feature integriert (tokio-tungstenite), geteilter hyper-1.x-Stack mit reqwest, Tower-Middleware fürs Auth-Gate. MSRV 1.80. crates.io 0.8.9 vom 2026-04-14                        |
| SQLite            | rusqlite, Feature `bundled`                                                                | 1:1-API-Analogon zu `better-sqlite3` (`prepare/all/get/run`, `pragma()`, `transaction()`), damit 48 Repo-Dateien ohne Semantikwechsel portierbar sind. `bundled` = kein Systempaket   |
| PostgreSQL        | sqlx 0.9 (postgres, runtime-tokio, tls-rustls-ring)                                        | Async-Pool + Transaktionen für `BEGIN` → `world_model_set_scope()` → Query → `COMMIT`. Nur Runtime-Queries, keine `query!`-Makros, damit der Docker-Build keine DB braucht. MSRV 1.94 |
| Krypto            | aes-gcm, hkdf, sha2, scrypt, base64, subtle                                                | Reicht exakt für NextAuth-JWE-Dekodierung, scrypt-Verifikation, konstante Zeit. Kein JOSE-Framework nötig                                                                             |
| HTTP-Client       | reqwest (rustls, json, stream)                                                             | Für Provider, Graphiti, Mem0, Bridges, Reverse-Proxy                                                                                                                                  |
| Prozesse          | tokio::process                                                                             | shellExecute, pythonExecute, Playwright-CLI, processManager                                                                                                                           |
| Serialisierung    | serde, serde_json                                                                          | Wire-Formate sind durchgehend JSON                                                                                                                                                    |
| Toolchain         | `rust-toolchain.toml` auf 1.94, Image `rust:1.94-bookworm`, Runtime `debian:bookworm-slim` | Identische Basis wie `node:22-bookworm-slim`, damit `app-data`- und `workspaces`-Volumes und Pfade alignen. python3 und Chromium werden erst mit Slice S11 ergänzt                    |

Keine Schema- oder Datenänderung. SQLite-Migrationen werden 1:1 nach Rust portiert (gleiche
Statements, gleiche `_migrations`-Buchführung). Die 19 World-Model-`.sql`-Dateien liegen seit Phase 1 des TS-Abbaus in
`rust/crates/betaclaw-world-model/migrations` (Dateinamen unverändert) und werden von Rust mit
demselben Advisory-Lock-Verfahren angewendet.

## 4. Migrationsreihenfolge

| #   | Slice                                                              | LOC       | Inhalt                                                                                                                     |
| --- | ------------------------------------------------------------------ | --------- | -------------------------------------------------------------------------------------------------------------------------- |
| S0  | Fundament                                                          | ca. 2k    | axum-Server, Auth-Gate, Reverse-Proxy, Docker, CI. Topologie „Rust besitzt 3000"                                           |
| S1  | Transport, Auth, Gateway-WS, Observability                         | ca. 3k    | JWE-Auth, scrypt, SQLite, WS-Framing/Registry/Broadcast/Keepalive, Rate-Limits, Event-Bus. `/api/logs*`, `/api/security/*` |
| S2  | Config, Gateway-Config, Personas, Security-Routen                  | ca. 3k    | kleine isolierte DBs, Sicherheits-Flags                                                                                    |
| S3  | Messages/Conversations/Inbox/Sessions-Store                        | ca. 6k    | reine SQLite-Repos, trägt Chat und Agent-Room                                                                              |
| S4  | Model Hub                                                          | ca. 5.8k  | 15 Provider, Pipeline, Crypto, Embeddings. Mechanischster Code, entsperrt alles LLM-abhängige                              |
| S5  | Memory                                                             | ca. 5.7k  | postgres/sqlite/mem0 Provider                                                                                              |
| S6  | World Model                                                        | ca. 11.4k | pg-Repos, Retrieval, Projector, Outbox, Graphiti-Client                                                                    |
| S7  | Knowledge                                                          | ca. 8.7k  | Ingestion, Retrieval, Repos                                                                                                |
| S8  | Chat-Dispatch, Recall, Subagents, Tool-Loop                        | ca. 9k    | WS-Streaming `chat.*`                                                                                                      |
| S9  | Master                                                             | ca. 7.2k  | Runs, Approvals, Notes, Reminders, Delegation, Gmail, Toolforge                                                            |
| S10 | Tasks, Workspaces, Agents, Automation                              | ca. 6k    |                                                                                                                            |
| S11 | Skills-Handler und Exec-Freigaben                                  | ca. 4.5k  | shell/python/playwright/process, sicherheitskritisch                                                                       |
| S12 | Stats, Clawhub, Proactive, Debug, Files, Ops, Agent-v2, Agent-Room | ca. 8k    |                                                                                                                            |
| S13 | Endzustand                                                         | —         | `betaclaw-scheduler` ersetzt `scheduler.ts`; `app/api/**`, `server.ts`, `proxy.ts`, `src/auth.ts` gelöscht                 |

Pro Slice gilt: Die TypeScript-Implementierung bleibt bestehen, bis Vertrags- und
Integrationstests die Parität belegen. Das Entfernungskriterium wird nach jedem Slice in
dieser Datei fortgeschrieben.

### Abschlusskriterien pro Slice

Jeder Slice wird anhand von vier unabhängigen Kriterien bewertet. Ein Slice ist erst
**abgeschlossen, wenn alle vier Kriterien erfüllt und belegt sind**. Eine vorhandene
Rust-Datei, grüne Unit-Tests oder ein konfigurierter Rust-Listener reichen dafür nicht.

| Kriterium             | Erfüllt, wenn …                                                                                                                                                   | Erforderlicher Nachweis                                                                                                                                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Code portiert         | Der vereinbarte Funktionsumfang einschließlich Fehlerpfaden vollständig in Rust vorliegt; fehlende Methoden, Platzhalter und Teilportierungen sind geschlossen.   | Quellenzuordnung, geprüfter Umfang sowie erfolgreiche relevante Tests, Formatierung, Clippy und Build.                                                                                                                           |
| Runtime angeschlossen | Die echten Aufrufer den Rust-Code über Routen, WS-Methoden oder Worker erreichen und produktive Transport-, Datenbank- und Lifecycle-Implementierungen verwenden. | Ausführbarer Integrationspfad mit realer Persistenz bzw. Transport; Test-Doubles allein genügen nicht. Ein transparenter HTTP-Proxy belegt keine Rust-Implementierung.                                                           |
| Verhalten verglichen  | TypeScript und Rust für denselben Umfang bei gleichen Eingaben gleiches beobachtbares Verhalten zeigen.                                                           | Vertrags-/Differenztests für Antworten, Fehler und Seiteneffekte; je nach Slice auch Auth/RLS, Abbruch, Streaming, Transaktionen, Wiederholung und Neustart. Migrierte HTTP-Routenfamilien benötigen eine grüne Paritätsfamilie. |
| Umschaltung erprobt   | Der betreffende Pfad tatsächlich auf Rust umgeschaltet, im Zielbetrieb geprüft und der Rückweg erprobt wurde.                                                     | Umgebung, Revision, Datum, E2E-/Smoke-Ergebnis und Rückfallnachweis; vor Entfernung einer alten Route zusätzlich eine störungsfreie produktive Release-Phase gemäß `rust/crates/betaclaw-gateway/src/routes/mod.rs`.             |

**Statuswerte:** `erfüllt` = Nachweis deckt den vollständigen Umfang ab;
`teilweise` = Implementierung oder Nachweis deckt nur einen Teil ab;
`offen` = bekannte fehlende Umsetzung;
`nicht belegt` = kein ausreichender Nachweis dokumentiert (keine Aussage über einen Fehlschlag).

Bewusste Verhaltensabweichungen müssen im Register mit betroffenen Fällen und
Begründung festgehalten und im Vergleich explizit geprüft werden. Offene funktionale
Abweichungen verhindern den Abschluss. Verschobene Funktionen brauchen einen benannten
Ziel-Slice und bleiben als Abhängigkeit sichtbar; eine fehlende Zuordnung gilt nicht
als erledigt. Fortschritt nach Dateizahl, LOC oder Testzahl ist kein Abschlusskriterium.

Für eine Prozent-Orientierung werden die vier Kriterien je Slice gleich gewichtet:
`erfüllt` = 100, `weitgehend` = 75, `teilweise` = 50 und `offen`/`nicht belegt` = 0.
Der Mittelwert über S0–S13 beschreibt belegte Migrationsreife, nicht portierte LOC oder
Zeitaufwand. Ein pauschaler Gesamtwert wird nicht mehr als Abschlussnachweis verwendet. Die lokale
Abnahme der Nacharbeiten F1–F25 steht in Abschnitt 7; externe Integrationen und
Produktionsumschaltung bleiben gesonderte Nachweise.

### Statusmatrix

Die frühere Matrix mit viermal „erfüllt“ für jeden Slice war zu weitgehend.
Quelltext, deklarierte Routen und erfolgreiche Einzeltests beweisen keine
vollständige Verhaltensparität. Stand der lokalen Prüfung vom 2026-10-29:

| Bereich                                                  | Code / Runtime                                                | Verhaltensnachweis                                                          | Grenze                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------- |
| S0–S3: Gateway, Auth, Config, Personas, Chat-Speicher    | nativ angeschlossen                                           | Rust-Gates, echte NextAuth-Kreuztests, Routen-Paritätsfälle                 | jeweils geprüfte Fälle                                     |
| S4: Model Hub                                            | nativ angeschlossen                                           | Adapter-Tests; lokaler HTTP-Modell-/Embedding-Provider im Smoke             | reale Providerkonten nicht erneut geprüft                  |
| S5–S7: Memory, World Model, Knowledge                    | nativ angeschlossen                                           | Unit-/Paritätsfälle; echter PostgreSQL-Treibertest und kanonischer Smoke    | Graphiti/Mem0/Live-Provider nicht vollständig abgenommen   |
| S8–S12: Chat, Master, Tasks, Skills, Ops, Agent-v2/Swarm | nativ angeschlossen                                           | jeweilige Rust-/TS-Fälle; gemeinsamer Swarm-Trace; Tool-Laufzeiten im Image | externe Mail-/Kanal-/Gerätepfade bleiben separate Abnahmen |
| S13: Lieferung und Hintergrundjobs                       | Rust-Gateway/Scheduler, statische UI, gemeinsame Job-Besitzer | lokale Images, Browser/HMR und isolierter Compose-Smoke                     | kein Deployment oder Produktions-Cutover durchgeführt      |

Die Routenprüfung vergleicht 188 erforderliche Pfad-/Methodenpaare mit
Rust-Deklarationen. TypeScript-Exports werden per AST, Rust-Router per
Quelltextparser gelesen. Ein temporäres Projekt mit fehlendem Handler muss mit
Exit 1 scheitern. Diese Zahl ist deklarierte Abdeckung, keine 100%-Verhaltensgarantie.

## 5. Slice S0 und S1 im Detail

### S0 Fundament

- `rust/` als Cargo-Workspace mit `betaclaw-core` (Domänenlogik) und `betaclaw-gateway`
  (Binär: axum-Server, Proxy, WS).
- Compose: Service `gateway` (Rust, publiziert `127.0.0.1:3000:3000`), Service `web-ui`
  (Next.js, intern auf 3001). `scheduler` bleibt zunächst Node.
- `Dockerfile.rust` als mehrstufiger Build.
- CI-Job `rust` in `.github/workflows/ci.yml`: `cargo fmt --check`, `cargo clippy
-D warnings`, `cargo test`.
- Entwickler-Loop wird sofort auf Rust umgestellt: `pnpm dev` startet den Rust-Gateway
  und Next.js dahinter. `pnpm dev:node` bleibt als reine Node-Debug-Loop erhalten.

### S1 Auth (Kompatibilität, nicht Neuinterpretation)

- `nextauth_jwe`: fünfteiliges JWE, A256GCM, HKDF-SHA256 mit
  `info = "NextAuth.js Generated Encryption Key (<cookieName>)"`, `clockTolerance` 15 s,
  Cookie `next-auth.session-token` bzw. `__Secure-…`. Beweis durch Testvektor, der mit
  dem echten `next-auth@4.24.15` und `jose` bei fixem Secret erzeugt und als Fixture
  committed wird.
- `loopback`: Port von `proxyPolicy.ts:26-124`. IPv4-Loopback, `::1`, `::ffff:`-Mapped,
  Host-Header-Name-Parsing, Cross-Site-Erkennung. Der Marker wird immer aus dem TCP-Peer
  neu gesetzt, ein Client-Header wird verworfen.
- `user_context`: Reihenfolge interner Token → `MC_API_TOKEN` → Session → lokaler
  Principal, exakt wie `resolveRequestUserContext`.
- `login_limiter`, `user_store` (scrypt, Legacy-SHA256-Upgrade, Dummy-Hash gegen
  Timing-Leak), `production_guard`.

### S1 HTTP

- Axum-Router mit Middleware-Kette: Loopback-Marker, Demo-Mode, öffentliche Prefix-Liste,
  Bearer, UserContext.
- Migrierte Routen: `GET/DELETE /api/logs`, `POST /api/logs/ingest`,
  `GET /api/security/status`, `GET /api/security/policy-explain`. Gleiche Statuscodes,
  Fehlerformen und `nextCursor`/`hasMore`-Semantik.
- Alles andere wird auf `web-ui:3001` reverse-proxied, inklusive `Host`, `Origin`,
  `Cookie`, `Sec-Fetch-*` und dem neu gesetzten Loopback-Marker.

### S1 WebSocket

Volle Parität zu `server.ts` und `connection-handler.ts`:

- Upgrade nur für `/ws`; `protocol=v2` sonst 400; Fremdpfade 404; Cross-Site 403;
  16 MB Max-Payload; 5 Verbindungen pro User → 429; ohne Session 401.
- `hello-ok` mit identischer Payload: `server.version`, 29 Events, Methodenliste.
- Presence-Broadcast, `seq` pro Verbindung, Rate-Limit 600/min im 60-s-Fenster,
  Backpressure 1,5 MB → Close 1008, Tick 30 s, Ping/Pong-Sweep mit Terminierung.
- Methoden `presence.*` und `logs.*` (6 Methoden) mit identischer `ErrorCode`-Union.
- Reconnect-Verhalten des Browsers (`src/modules/gateway/ws-client.ts`) bleibt unangetastet,
  weil der Endpunkt gleich bleibt.

### S1 Nicht enthalten

`/api/health*`, `/api/doctor` und `/api/events/stream` bleiben bewusst in TypeScript. Sie
fassen Memory, Knowledge und Stats an und gehören in S5 bis S7.

`GET /__rust/health` existiert nur für den Container-Healthcheck. Es ist kein Teil des
`/api`-Vertrags und in Vertragstests ausgenommen.

## 6. Risiken

1. 368 Vitest-Dateien importieren `@/server/*` tieflinks. Sie bleiben grün, weil TypeScript
   nicht gelöscht wird, sind aber eine Wiederschreibungs-Last und kein Oracle für Rust.
   Parität wird zusätzlich über Fixture-Diff-Tests hergestellt: gleiche Eingabe, gleiche
   JSON-Ausgabe in TypeScript und Rust.
2. Die Architektur-Guards in `tests/unit/architecture/*.test.ts:48-78` prüfen Import-Zeilen
   in TypeScript. Sie bleiben gültig, solange TypeScript existiert. Beim Löschen von
   `src/server` in S13 müssen sie durch Rust-Äquivalente auf Basis des Pfad-Import-Graphs
   ersetzt werden.
3. Das Coverage-Gate 70 % in `vitest.config.ts:179-184` misst nur TypeScript. Rust bekommt
   ein eigenes Gate (`cargo llvm-cov`, nur in CI).
4. `@google/genai` hat kein Rust-Pendant. Der Gemini-Adapter wird in S4 als REST neu
   implementiert; der vorhandene TypeScript-Adapter ist ohnehin HTTP.
5. Drei Sprachen: Rust, Next.js/TypeScript und die Python-Sidecars Graphiti und Mem0. Das
   ist akzeptiert, weil beide Sidecars bereits Python sind und über HTTP bzw. REST laufen.
6. Chromium und Python3 werden erst in S11 in das Rust-Image aufgenommen. Bis dahin hat das
   Gateway-Image bewusst weniger Abhängigkeiten als das heutige.
7. RLS: jede Rust-Transaktion muss `BEGIN` → `world_model_set_scope` → Arbeit → `COMMIT`
   exakt spiegeln. `set_database_scope` darf nie entfallen. Ein Vertragstest vergleicht die
   erzeugten Statements.

## 7. Fortschrittsnotizen

### 2026-11-01 — TS-Backend entfernt: Abschluss Phase 2, 5 und 6

Abschluss von `docs/TS_BACKEND_REMOVAL_PLAN.md`. Die Einträge darunter beschreiben die
Phasen 1, 3, 4 und den ersten Teil von Phase 5 im Einzelnen.

- **Phase 2:** E2E-Lanes starten das Rust-Gateway (`tests/e2e/_shared/rustGateway.ts`).
  Dabei behoben: Test-Modus des Model Hub im Chat-Adapter, `chat.abort` wartete auf einen
  laufenden `chat.stream` derselben Verbindung, `requestCount`/`seq` waren `null`. Die
  Paritäts-Suite vergleicht gegen 186 Referenzwerte in `scripts/verify/parity/golden/`.
  Der Abgleich der TS-Tests mit Rust (`docs/TS_TEST_COVERAGE_AUDIT.md`, Abschnitt 10, und
  `docs/ts-test-audit/*.md`) brachte rund 360 neue Rust-Tests und vier Rust-Fixes
  (Login-IP-Limit bei langem `X-Forwarded-For`, Config-Verlust beim Ersetzen unter
  Windows, fehlgeschlagene Subagent-Aufgaben galten als `completed`,
  `ServiceError::Aborted` für Provider-Abbrüche). Offene Fälle sind Backlog, kein
  Löschhindernis (Begründung dort).
- **Phase 5:** gelöscht sind zusätzlich `src/server` (727 Dateien) und das tote
  `src/lib/db`. Insgesamt sind 1397 Dateien mit rund 181.000 Zeilen entfernt. Pakete
  entfernt: `cron-parser`, `css-tree`, `nodemailer`, `pg`, `yaml`, `@types/pg`,
  `@types/css-tree`. `better-sqlite3` bleibt für `scripts/dev-host-data.mjs` und
  `scripts/dev-import-legacy.mjs`. Der CI-Job `test-unit` hat keinen PostgreSQL-Dienst
  mehr; die World-Model-Tests laufen in Rust.
- **Phase 6:** `AGENTS.md` legt Verhalten über Rust-Tests, Referenzdaten, E2E und
  Production-Smoke fest statt über eine TS-Quelle. `.github/copilot-instructions.md`
  und die systemd-Units in `docs/DEPLOYMENT_OPERATIONS.md` beschreiben die Rust-Binaries.
- **Weitere Fixes:**
  - `verify-rls` erwartete, dass die Worker-Rolle `world_model_observations` nicht lesen
    darf. Migration 019 gewährt das bewusst; Embedding-Worker und Projection-Retry
    brauchen es. Der Check prüft jetzt das Leserecht, die Grants bleiben.
  - Provider-Abbruch im Chat ergibt `Generation aborted.`
    (`families/chat_runtime/model.rs`).
  - `serde_json` mit `float_roundtrip`: gespeicherte Embeddings kommen bitgenau zurück.
  - Host-`cargo` vom Repo-Root mit `--manifest-path` nutzte die Host-Toolchain statt
    1.94 und baute `rust/target` mit einem anderen Compiler. `rust:check`,
    `scripts/rust-scheduler-ops.mjs` und `scripts/e2e/prepare-rust-gateway.mjs`
    bauen jetzt in `rust/`.
  - Zwei flakige Tests: `embeddings::provider` prüfte die globale In-Flight-Tabelle
    statt des eigenen Schlüssels; `privileged_route_tests` hing ohne Loopback-Peer und
    -Host von der Umgebung ab und öffnete die echte Model-Hub-DB.
- **Paritäts-Befund:** Die zuvor roten Fälle `stats/prompt-logs`,
  `automations/metrics` und `stats/engineering` kamen von echten Daten unter `.local/`
  im Arbeitsverzeichnis des lokal gestarteten Gateways. Mit frischem Arbeitsverzeichnis
  wie in CI: 505 OK, 30 übersprungen, 0 Fehler.

Gates: Rust fmt, clippy (`--all-targets --features test-support -D warnings`) und
`cargo test --locked --features test-support` im Container `rust:1.94-bookworm` grün,
3891 Tests bestanden, 0 fehlgeschlagen. typecheck, lint, format:check, Vitest 796/796,
Coverage 91,5 % Zeilen (Schwelle 70 %), build, build:export, Architektur-Guards 3/3,
Route-Coverage 190/190, Route-Parität 505 OK, Smoke 9/9, Browser-E2E 69/69, Production-Smoke grün (frische Volumes, Rust-`migrate` mit Rollen). Für den Image-Build schließt `.dockerignore` jetzt `scripts/e2e/start-e2e-server.ts` aus, das aus `tests/` importiert.

### 2026-11-01 — Phase 5 Entfernung TS-Backend: Löschen, Tests, Konfiguration

Ziel: Phase 5 aus `docs/TS_BACKEND_REMOVAL_PLAN.md`. Gelöscht sind das TS-Backend in `app/api`, `server.ts`, `scheduler.ts`, `proxy.ts`, `src/auth.ts`, `src/commands` und `src/logging`. `src/server` bleibt bis zur Löschung durch den Koordinator, weil die Portierung der letzten Ops-Skripte noch TS-Originale daraus ausführt. Stand des Ausgangs: Tag `legacy-ts-backend` (`273c7879`).

- **Gelöscht:** `app/api/**` (116 Dateien, 113 Routen), `server.ts`, `scheduler.ts`, `proxy.ts`, `src/auth.ts`, `src/commands/**` (8 Dateien), `src/logging/**` (3), dazu `src/lib/betaclaw/client.ts` und `src/lib/planning-utils.ts` (nur von `app/api` und dem TS-Backend genutzt). Außerdem `scripts/fixtures/record-gemini-traffic.mjs` (Recorder; die Fixture `rust/crates/betaclaw-gateway/tests/fixtures/gemini/exchanges.json` bleibt), `scripts/verify/parity/families/_skills.mjs` (nicht erreichbar), `scripts/e2e/live-preflight.ts`, `vitest.e2e.live.config.ts`.
- **UI-Code:** Kein Modul unter `app/`, `src/modules`, `src/components` oder `src/skills` importierte die gelöschten Pfade. `app/page.tsx` nutzt `resolveDefaultViewFromConfig` aus `src/shared/config/uiRuntimeConfig.ts`; die CLI spricht über `src/shared/gateway/`. `betaclaw gateway run` startet jetzt `betaclaw-gateway`.
- **Tests:** 502 getrackte Testdateien gelöscht (Vitest-Dateien, die `@/server`, `src/server`, `app/api`, `src/logging`, `src/commands`, `src/auth` oder die gelöschten Module importieren, plus ihre Hilfsdateien: `entity-graph`, `retrieval-service`, `mem0-client`, `master-repository`, `memory-route`, `ops-routes`). Eine nicht getrackte Datei (`tests/integration/chat/webui-nexus-chat-stream-tools.test.ts`) liegt außerhalb des Repos im Scratchpad. Umgehängt auf `src/shared`: `tests/unit/agent-room/completion-text.test.ts`, `frontend-utils.test.ts`, `tests/unit/modules/agent-room/use-agent-room-runtime-replay.test.ts` (Typ `AgentV2EventEnvelope` aus `@/shared/agentV2Types`) und `tests/unit/app-shell/default-view-config.test.ts` (`@/shared/config/uiRuntimeConfig`). Angepasst: Architektur-Guards (Test der `app/api`-Routen entfernt, Import-Richtung bleibt), `gateway-contract`, `url-parse-deprecation-guard`, `next-config-tracing`, CI-Registry-Tests (Rust-Pfade), `harness-engineering-contract`, `vitest-main-config-contract`, `e2e-config-contract`.
- **Mem0-Live-Test:** `tests/e2e/memory/mem0.live.e2e.test.ts` gelöscht, nicht neu geschrieben. Er spricht die TS-Mem0-Clients direkt an; eine Fassung gegen die Rust-HTTP-API braucht einen externen Mem0-Dienst und war nicht Teil dieses Schritts. Entfallen deshalb: Lane `test:e2e:live`, Job `live-e2e` in `async-quality.yml`.
- **Paritäts-Suite:** Record-Zweige entfernt (`harness.mjs`, `run.mjs`, alle Familien). `goldenReference(family, key)` liest nur noch `golden/<familie>.json`; 186 Referenzwerte in 17 Dateien sind unverändert. `swarm.mjs` vergleicht die Trace-Fixture `swarm-parity.json` mit `golden/swarm.json`; `tests/integration/agent-room-rust-parity.test.ts` (lief den TS-Orchestrator) entfällt. `auth.mjs` prüft gegen die NextAuth-Referenz ohne TS-Laufzeit. Gelöscht: `verify:route-parity:record`, `verify:logs-parity:record`.
- **Route-Coverage:** `scripts/verify/route-coverage.mjs` vergleicht nicht mehr mit `app/api`, sondern die Rust-Routentabelle mit der geprüften Datei `scripts/verify/route-table.json` (190 Paare, `--print-table` zum bewussten Aktualisieren). Der CI-Schritt bleibt.
- **Skripte und CI:** `fixtures:gemini-traffic` und sein CI-Schritt „Check committed fixtures are current“-Zeile entfernt; die Fixture bleibt. `test:e2e:live` entfernt. `scripts/harness/agent-verify.mjs` startet keinen TS-Scheduler mehr; die Smoke-Lane startet den Rust-Stack selbst. Die Ops-Skripte `memory:*`, `knowledge:ingest`, `world-model:graphiti-evaluate`, `world-model:drill` sind unverändert (Portierung läuft).
- **Konfiguration:** `next.config.ts` ohne Output-Tracing von `src/server/skills/handlers`. `vitest.config.ts`: Coverage-Scope jetzt `src/shared`, `src/lib`, `src/services` (vorher alles, also auch `src/server`); `src/lib/db` ist ausgenommen, weil es nur das TS-Backend nutzt; die Schwelle bleibt bei 70 %; Projektlisten ohne Verweise auf gelöschte Tests. `tsconfig.json` und `.oxlintrc.json` schließen `src/server/**` und acht Ops-Skripte aus, die noch `src/server` importieren (`memory-*`, `trigger-knowledge-ingestion`, `world-model-failure-drill`, `world-model-graphiti-evaluate`, `world-model-scheduler-restart-child`). `scripts/ci/cleanup-low-risk.mjs`: Einträge `src/server/` und `app/api/` entfernt. `docs/contracts/DOMAIN_REGISTRY.json` und `DOMAIN_SCENARIO_MATRIX.json`: keine gelöschten Pfade mehr; Test- und Szenario-Verweise zeigen auf erhaltene Dateien, backend-only Szenarien laufen über `pnpm run rust:test -- <Filter>`. `isHighRiskPath` nennt Rust-Pfade (`rust/crates/betaclaw-base/src/auth/**`, `betaclaw-gateway/src/routes/*`, `betaclaw-memory/**`, `betaclaw-model-hub/**`) statt `app/api` und `src/server`.
- **Abhängigkeiten: keine entfernt.** Grund: `src/server` und die stehen gebliebenen Ops-Skripte importieren `cron-parser`, `css-tree`, `nodemailer`, `pg`, `yaml`, `better-sqlite3` (dazu `scripts/dev-host-data.mjs`, `scripts/dev-import-legacy.mjs`) und `@google/genai` (dazu `src/core/memory/gemini.ts`, von der UI über `src/core/memory/index.ts` importiert). Ein Entfernen jetzt würde die laufende Ops-Portierung brechen. Kandidaten für die Löschung zusammen mit `src/server`: `cron-parser`, `css-tree`, `nodemailer`, `pg`, `yaml`, `@types/pg`, `@types/css-tree`, `@types/better-sqlite3`. Das Lockfile ist unverändert, `pnpm install` war nicht nötig.
- **Gates:** Stand dieses Schritts (lokal, Windows-Host, Release-Binaries nach `cargo build --release --locked`):
  - `typecheck`: grün.
  - `lint` (oxlint): grün, keine Meldungen.
  - `test`: 179 Dateien, 796 Tests grün.
  - `test:coverage`: grün. 91,36 % Zeilen, 94,92 % Statements, 81,57 % Funktionen, Schwelle 70 % unverändert.
  - `test:architecture:guards`: 3 Tests grün.
  - `build` und `build:export`: grün.
  - `test:e2e:smoke` (Rust-Gateway, Static-Export): 9 Tests in 6 Dateien grün.
  - `verify:route-coverage`: 190 von 190 Paaren stimmen mit der Referenz überein.
  - `verify:route-parity` gegen das Release-Gateway auf zufälligem Port über 40000: 502 OK, 3 FAIL. `stats` (`GET /api/stats/prompt-logs` und `(preset, limit)`: `diagnostics.lastInsertAt` ist ein String, die Referenz hat `null`) und `automations` (`GET /api/automations/metrics`: `leaseAgeSeconds` und `leaseState` sind gesetzt, die Referenz hat `null`). Die Abweichungen zeigen sich auch bei einem frischen Gateway mit nur `stats` (Zähler `attemptsSinceBoot`/`writesSinceBoot` sind prozessweite Werte der Rust-Modellaufrufe; Lease kommt aus dem Automations-Laufzeitstand). Die Golden-Dateien sind nicht geändert. Ob die Referenz oder das Verhalten nachzuziehen ist, ist offen.
  - `check`: siehe Abschnitt „Offen“.
- **Offen:**
  1. CI-Job `world-model` (`.github/workflows/ci.yml`, Schritt „Prepare World Model PostgreSQL schema“) ruft noch `src/server/world-model/db` auf. Vor dem Löschen von `src/server` auf den Rust-Befehl `betaclaw-scheduler migrate` umstellen.
  2. Die drei Paritäts-Abweichungen oben.
  3. Abhängigkeiten (Liste oben) mit `src/server` entfernen und `pnpm install` ausführen.
  4. `.github/copilot-instructions.md` beschreibt noch das TS-Backend; in `.github/CODEOWNERS` stehen `src/server/**`-Zeilen bis zur Löschung.
  5. Registry-Pfade `src/server/**` (Domänenzuordnung und High-Risk-Liste) nach dem Löschen auf Rust-Pfade umstellen.
  6. Die 8 Ops-Skripte aus `tsconfig.json` und `.oxlintrc.json` ausschließen; mit der Löschung von `src/server` entfernen.

### 2026-11-01 — Phase 3 Abschluss: die sieben letzten Ops-Skripte als Rust-Subcommands

Ziel: Die verbleibenden TypeScript-Ops-Skripte aus Phase 3 (`docs/TS_BACKEND_REMOVAL_PLAN.md`) laufen als Unterbefehle von `betaclaw-scheduler`. Die TS-Dateien sind gelöscht. Die `pnpm run`-Namen und Flags bleiben gleich; sie rufen jetzt `scripts/rust-scheduler-ops.mjs` auf, das `.env.local` lädt und den Binary aus `rust/` baut.

| Befehl                          | Unterbefehl                     | Rust-Datei (`betaclaw-gateway/src/world_model_ops/`)                            |
| ------------------------------- | ------------------------------- | ------------------------------------------------------------------------------- |
| `knowledge:ingest`              | `knowledge-ingest`              | `knowledge_ingest.rs`; Ingestion-Pass `IngestionPass` in `knowledge_runtime.rs` |
| `memory:reset`                  | `memory-reset`                  | `memory_reset.rs`                                                               |
| `memory:cleanup-noise`          | `memory-cleanup-noise`          | `memory_cleanup_noise.rs`                                                       |
| `memory:backfill-channel-scope` | `memory-backfill-channel-scope` | `memory_backfill_channel_scope.rs`                                              |
| `memory:migrate-to-postgres`    | `memory-migrate-to-postgres`    | `memory_migrate_to_postgres.rs`                                                 |
| `world-model:graphiti-evaluate` | `graphiti-evaluate`             | `graphiti_evaluate.rs`                                                          |
| `world-model:drill`             | `drill` (+ `drill-lease-child`) | `drill.rs`; der Kindprozess ist der Scheduler-Binary selbst                     |

- **Gelöscht:** `scripts/memory-reset.ts`, `memory-cleanup-noise.ts`, `memory-backfill-channel-scope.ts`, `memory-migrate-to-postgres.ts`, `trigger-knowledge-ingestion.ts`, `world-model-graphiti-evaluate.ts`, `world-model-failure-drill.ts`, `world-model-scheduler-restart-child.ts`.
- **Wiederverwendet:** `betaclaw-memory` (Mem0-HTTP-Client, Postgres-Memory-Client), `betaclaw-knowledge` (Cursor, Service, `is_noise_memory_fact`), `betaclaw-world-model` (Observationen, Retrieval, Graphiti-Evaluator, Scope-Discovery, Lifecycle, Lease über `betaclaw-features`).
- **Vergleich mit dem TS-Original** (Treiber außerhalb des Repos; gleiche Fixtures für beide Seiten): SQLite-Dateien in einem Temp-Verzeichnis, Mem0 als Fake-HTTP-Server mit zurückgesetztem Stand, Postgres `pgvector/pgvector:pg17` im Container. Verglichen wurden Exit-Code, stdout, stderr (ohne Cargo-Zeilen), Berichtsdateien und der Zustand von SQLite, Mem0 und Postgres. Ergebnis: 16 von 19 Läufen identisch. Die drei Abweichungen stehen unten.
- **Nicht verglichen:** `knowledge-ingest` ohne `--dry-run` mit tatsächlicher Verarbeitung (braucht Model Hub und Extraktionsmodell) sowie der `--persona`-Pfad; Graphiti nur als nicht erreichbarer Dienst; Mem0-Fehler mitten im Lauf (verglichen wurde nur „nicht konfiguriert“).

**Abweichungen (bewusst oder beobachtet):**

1. `graphiti-evaluate`, Feld `error`: Der Text des HTTP-Clients unterscheidet sich (Node „fetch failed“, Rust „error sending request“). Die Einstufung (nicht erreichbar, Fallback) ist gleich.
2. `drill`, Szenario `embedder-outage`: Das Ergebnis ist gleich (`source=none`, bestanden). Die Warnung zeigt bei Rust einen Timeout, bei Node `ECONNREFUSED` für `127.0.0.1:9999`. Der Pfad über `ConfiguredQueryEmbedder` (`model_hub_embedding.rs`) ist bestehender Gateway-Code und ist nicht untersucht.
3. Logs: Die einmaligen Befehle `knowledge-ingest` und `drill` schreiben Diagnosen auf stderr (Format `tracing`), der Bericht bleibt auf stdout. Der Dauerbetrieb des Schedulers ist unverändert.
4. `knowledge-ingest`: Fehler einzelner Fenster ohne Stack-Zeilen. Mit `--persona` werden Fenster je Stapel verarbeitet, die Zeilen erscheinen in Abschlussreihenfolge des Stapels.
5. `memory-backfill-channel-scope`: Quelle und Ziel der Mem0-Listen werden nacheinander geladen (das TS-Original parallel). Nicht-numerische `source_seq_*`-Werte werden zu 0 statt zu einem Fehler.
6. `graphiti-evaluate`: `GRAPHITI_SEARCH_RESULTS` mit Nachkommastellen wird auf eine ganze Zahl gekürzt, weil `retrieval_k` als `i64` geführt wird.
7. `LEGACY_LOCAL_USER_ID`: Die Ops-Skripte verwenden den TS-Wert `legacy-local-user` (`src/server/auth/constants.ts`). Der Rust-Fallback für den Principal (`betaclaw-base`) nutzt `local-user`. Das ist ein vorhandener Unterschied. Er wurde nicht angefasst.
8. `memory-cleanup-noise --help` nennt den Aufruf `pnpm run memory:cleanup-noise -- …` statt des tsx-Aufrufs. Flags, Standard (Dry-Run) und Exit-Codes sind gleich.

**Sicherheitsverhalten:** Keine Bestätigungsflags, weil das TS-Original keine hatte. `memory-reset` löscht weiterhin sofort (lokale `memory_nodes` und alle Mem0-Scopes). `memory-cleanup-noise` ist Dry-Run ohne `--apply`. Die Einmal-Migrationen `memory:migrate-to-postgres` und `memory:backfill-channel-scope` sind wie beauftragt portiert. Die offene Frage 3 in `TS_BACKEND_REMOVAL_PLAN.md` (ob sie auf allen Installationen gelaufen sind) bleibt beim Team.

- **Tests:** `cargo test -p betaclaw-gateway world_model_ops` (Host): 59 bestanden, 0 fehlgeschlagen (vorher 31). Neu: Scope- und Flag-Parser, Rauschregeln, Dedupe-Reihenfolge, Transaktion beim Kopieren, Clamp von `retrieval_k`, Zahlenformat.
- **Gates:** `pnpm run rust:fmt:check` grün (Container `rust:1.94-bookworm`). `pnpm run rust:check` grün. `cargo clippy -p betaclaw-gateway --all-targets -- -D warnings` (Host, Rust 1.99) grün. `pnpm run rust:clippy` (Container, Workspace) bricht im Testziel von `betaclaw-skills` ab (`skills/shell_execute.rs:310`, `Duration` nicht importiert). Das ist fremder Code und nicht Teil dieses Schritts. `pnpm run typecheck` und `pnpm run lint` grün.
- **Dokumentation:** `scripts/rust-scheduler-ops.mjs` (Hilfetext), `package.json` (sieben Zeilen), `docs/contracts/DOMAIN_REGISTRY.json` (Pfad des Drill-Skripts entfernt; `world_model_ops/**` deckt es ab), `docs/runbooks/WORLD_MODEL_INCIDENTS.md` (Link), `docs/MEMORY_SYSTEM.md` (Abschnitt 6). Die übrigen Runbooks nennen nur die unveränderten `pnpm run`-Befehle.
- **Offen:** Keines der sieben Skripte. Der Vergleich mit einem echten Graphiti-Server, der LLM-Lauf von `knowledge-ingest` und die Mem0-Fehlerpfade mitten im Lauf sind nicht geprüft.

### 2026-11-01 — Phase 3 Nachtrag: OP-18, Ledger-Grant, Worker-Lesezugriffe, zwei Ops-Skripte

Ziel: Nachtrag zu Phase 3 aus `docs/TS_BACKEND_REMOVAL_PLAN.md`. Die Entscheidung des Users zu OP-18 ist umgesetzt. Die Untersuchung des Worker-Befunds ist abgeschlossen. Zwei weitere Ops-Skripte sind portiert.

- **OP-18 (Ledger-Grant):** `world_model_app` bekommt `SELECT` auf `_world_model_migrations`. Die TS-Verzweigung in `provisionRole` lief nie, weil die Existenzprüfung die Ledger-Tabelle nicht enthielt. Die Rust-Provisionierung prüft das Ledger jetzt eigens (`ledger_exists`, `role_provisioning.rs`) und gewährt nur der App-Rolle. Die Gateway-Gesundheitsprüfung (`families/ops_wire/world_model_port.rs`, `SQL_MIGRATIONS`) läuft über den App-Pool und liest die Tabelle damit ohne `permission denied`.
  - **Bewusste Abweichung von TS, genau dieser eine Grant:** Die TS-Verzweigung hätte beiden Rollen den Grant gegeben. Die Rust-Port vergibt ihn nur an `world_model_app`. Sonst bleiben die Grants identisch.
  - Tests: zwei neue Provisionierungstests (Grant nur bei vorhandenem Ledger; zweimal provisionieren ergibt dieselben GRANTs). Die Verify-Prüfung `app role reads _world_model_migrations (health check, OP-18)` ist jetzt eine positive Lesprüfung.
  - Live auf einer frischen `pgvector:pg17`-Datenbank: `provision-roles --apply` zweimal mit Status 0. `has_table_privilege` liefert für die App-Rolle `t`, für die Worker-Rolle `f`. `SET ROLE world_model_app` plus die Gesundheitsabfrage liefert `019_worker_runtime_grants`.
- **Worker-Befund (nur Untersuchung, keine Änderung an Grants oder Check):** Ja, Worker-Code liest `world_model_observations`:
  - `betaclaw-world-model/src/world_model/embeddings/embedding_worker.rs:287` (`collect_embedding_targets`, `SELECT … FROM world_model_observations`), gestartet vom Scheduler mit dem Worker-Pool (`betaclaw-gateway/src/scheduler_runtime.rs`).
  - `betaclaw-world-model/src/world_model/repositories/observation_repository.rs` (`SQL_EXISTING_OBSERVATION`, Konfliktlesezugriff nach `INSERT … ON CONFLICT`), erreicht über `services/projection_retry_worker.rs:462` → `project_window`.
  - Migration `019_worker_runtime_grants.sql` gewährt dem Worker `SELECT, INSERT, UPDATE, DELETE` auf die Domänentabellen, Observationen eingeschlossen.
  - `runtime/scope_discovery.rs` führt den Observationen-Scan (`SCOPE_SCAN_SQL`) für Worker absichtlich nicht aus (`!runtime_role.is_worker()`). Die Graphiti-Rebuild-Abfrage (`graphiti/projector.rs:841`) läuft nur im CLI-Pfad.
  - Folgerung: Der Verify-Check „worker cannot read world_model_observations“ passt nicht zum Entwurf. Entschieden am 2026-11-01: Der Check ist veraltet (älter als Migration 019) und prüft jetzt positiv, dass der Worker Observationen lesen kann; die Grants bleiben.
- **Portiert (mit Vergleich gegen TS auf einem frischen Stand):**
  - `workspaces-cleanup [--json]` (vorher `workspaces:cleanup`, `workspaces:cleanup:json`). Reuse von `betaclaw_features::tasks::workspace::cleanup_orphan_task_workspaces`. Vergleich: Ausgabe (Text und JSON) und entfernte Ordner gleich.
  - `attachments-consistency [--repair] [--repair-prune-missing] [--repair-normalize-buckets] [--json]` (vorher `attachments:consistency`). Der TS-Teil `attachmentConsistency.ts` ist in `world_model_ops/attachments.rs` portiert, mit den vorhandenen Rust-Helfern. Vergleich: Berichte, Metadaten-JSON und verschobene Dateien gleich.
  - Beide Skripte sind gelöscht. Die `package.json`-Einträge zeigen auf `scripts/rust-scheduler-ops.mjs`. Die Doku `docs/TASKS_SYSTEM.md` verweist jetzt auf den Rust-Pfad.
  - Sicherheitsfix dabei: Storage-Pfade mit `..` wurden nicht aufgelöst, `std::path::absolute` tut das nicht, TS-`path.resolve` schon. Jetzt normalisiert `lexical_normalize` vor der Wurzel-Prüfung. Der Test `a_relative_path_must_stay_inside_the_root` deckt das ab.
- **Nicht portiert (offen, unverändert gelassen):** `knowledge:ingest` (`scripts/trigger-knowledge-ingestion.ts`), `memory:reset`, `memory:cleanup-noise`, `memory:backfill-channel-scope`, `memory:migrate-to-postgres`, `world-model:graphiti-evaluate`, `world-model:drill` mit `scripts/world-model-scheduler-restart-child.ts`. Die TS-Dateien und ihre `package.json`-Einträge sind unverändert. `fixtures:gemini-traffic` ist nicht angefasst. Die Dateien `background.rs`, `persona_poller.rs`, `swarm_runtime.rs` und `workspace_cleanup.rs` sind nicht verändert.
- **Tests:** `betaclaw-world-model` im Container: 369 bestanden, 0 fehlgeschlagen. `betaclaw-gateway` `world_model_ops`: 31 bestanden. Gesamter Gateway-Lib-Lauf im Container: 579 bestanden, 1 fehlgeschlagen (`routes::privileged_route_tests::legacy_local_context_keeps_the_pipeline_readable`, 401 statt 200). Die Datei `routes/mod.rs` ändert ein anderer Agent gerade; mein Changeset berührt sie nicht. Behoben am 2026-11-01: Der Test setzt jetzt Loopback-Peer und Loopback-Host wie ein echter lokaler Aufruf und prüft die Providers-Route (gleiche `ensure_auth`-Prüfung, ohne Model-Hub-DB); neuer Name `legacy_local_context_keeps_model_hub_routes_readable`.
- **Gates:** `rust:fmt:check` für meine Dateien grün. Container-Clippy für `betaclaw-world-model` und `betaclaw-gateway` mit `-D warnings` grün. Voller `rust:clippy` und voller `rust:test` scheitern an `betaclaw-skills` (`shell_execute.rs`, Test-Modul, fremde Arbeit). `typecheck` und `lint` grün.
- **Offen:** Worker-Befund (Entscheidung Check oder Grants). Die sieben noch nicht portierten Skripte oben. Der volle Rust-Lauf wartet auf den Abschluss der Arbeiten in `betaclaw-skills` und `routes`.

### 2026-10-31 — Phase 4 Entfernung TS-Backend: Dev-Stack, Container-Lanes, Job-Schalter

Ziel: Kein Node-Anwendungsserver mehr im Dev-Stack, in Compose und in den E2E-Lanes. Die Job-Schalter kennen nur noch `rust` und `off`. Grundlage: `docs/TS_BACKEND_REMOVAL_PLAN.md`, Phase 4. Das TS-Backend (`src/server`, `app/api`, `server.ts`, `scheduler.ts`) bleibt bis Phase 5 im Repo und wurde nicht verändert.

- **Entfernt:** die Skripte `dev:node`, `dev:web`, `dev:web-ui`, `dev:scheduler`, `start:web`, `start:scheduler` und `start`; `scripts/dev-stack.mjs`; der Compose-Dienst `web-ui` mit Profil `legacy-node-ui`; das Root-`Dockerfile` (Node-Image des Next-Servers, nur noch vom Probe-Image gebraucht); `scripts/verify/node-elimination-benchmark.mjs` samt Option `--benchmark` der Produktions-Smoke (misst nur gegen den Node-Server). `dev:gateway` und `dev:stack` bleiben.
- **Probe-Image:** `docker/Dockerfile.probe` (node:22-bookworm-slim, Prod-Abhängigkeiten, Chromium) für `scripts/e2e/production-smoke.mjs`. `docker-compose.release-smoke.yml` verliert den Override `web-ui`.
- **Dev-Stack:** `pnpm run dev` startet Gateway, Rust-Scheduler und `next dev -p 3001` (`BETACLAW_UI_MODE=proxy`). Ohne Rust-Scheduler-Binary bricht der Stack vor dem Gateway ab, es gibt keinen Node-Fallback mehr. `pnpm run dev:static` startet das Gateway mit dem Export aus `out/` und den Rust-Scheduler.
- **Container-E2E:** `docker-compose.e2e.yml` hat den Dienst `e2e-rust-build` (`rust:1.94-bookworm`, `cargo build --locked`, Volume `e2e_rust_target` auf `rust/target`, Registry-Volume wie bei den `rust:*`-Skripten). Smoke- und Browser-Lane warten darauf und mounten dasselbe Target-Volume. `scripts/e2e/prepare-rust-gateway.mjs` nutzt ohne `cargo` die vorhandenen Debug-Binaries. Die Lanes rufen unverändert `pnpm run test:e2e:smoke` und `pnpm run test:e2e:browser` auf.
- **Job-Schalter:** `BETACLAW_TELEGRAM_POLLER`, `BETACLAW_SWARM_RUNNER`, `BETACLAW_WORKSPACE_CLEANUP` akzeptieren `rust` und `off` (`false` und `0` bleiben Aliasse von `off`). Unset oder leer bedeutet `rust`. `node` und unbekannte Werte brechen Gateway und Scheduler mit einer Meldung ab (`background::validate_job_switches`). Gateway prüft vor dem Bind, Scheduler vor dem Start der Jobs (nach dem Öffnen der Stores). Geprüft: `BETACLAW_WORKSPACE_CLEANUP=node` und `=bogus` beim Gateway, `BETACLAW_SWARM_RUNNER=node` beim Scheduler, jeweils Exit 1.
- **Verhaltensänderung:** Unset ist jetzt `rust` (vorher in Rust effektiv aus). Das betrifft Telegram-Poller (ohne aktive Bots wirkungslos), Swarm-Runtime und Workspace-Aufräumen. Das Aufräumen läuft beim Start und danach alle 30 Minuten. Es entfernt nur Verzeichnisse mit `.workspace.json` von Tasks, die nicht mehr aktiv sind, höchstens 200 pro Lauf. Mit `BETACLAW_WORKSPACE_CLEANUP=off` bleibt es aus.
- **Dokumentation:** README, AGENTS.md, `.env.local.example`, `docker-compose.yml`, `docs/DEPLOYMENT_OPERATIONS.md` (Docker-Abschnitt; Systemd-Abschnitt mit Hinweis), `docs/CORE_HANDBOOK.md`, `docs/AUTOMATION_SYSTEM.md`, `docs/runbooks/WORLD_MODEL_ROLLOUT.md`, `.github/copilot-instructions.md`.
- **Tests:** Host `cargo test -p betaclaw-gateway --lib` für `background::`, `persona_poller::`, `workspace_cleanup::tests` und `swarm_runtime::tests`: 12 bestanden, 0 rot. `tests/unit/gateway/gateway-contract.test.ts` (angepasst): 8 bestanden.
- **Gates:** `typecheck` grün, `lint` grün, `docker compose config` für Haupt-, Release- und E2E-Datei gültig (Platzhalter-Secrets über die Umgebung). `pnpm run dev` und `pnpm run dev:static` starten, `/api/health` und die UI-Wurzel antworten mit 200. Container-Lanes: Smoke `docker compose -f docker-compose.e2e.yml run --rm e2e-smoke` (über `scripts/e2e/run-smoke-in-container.ps1`) 9 von 9 Tests grün, 6 Dateien. Browser (`run-browser-in-container.ps1`) 69 von 69 grün, Dauer 1,1 min nach dem Build. Der erste Browser-Lauf brach im Build-Dienst mit Exit 101 ab, weil der Quellstand eines parallelen Arbeitsstrangs in `world_model_ops` nicht kompilierte; der Wrapper meldete dabei trotzdem Exit 0. Behoben: beide `.ps1`-Wrapper geben `$LASTEXITCODE` weiter.
- **Nicht grün, nicht in diesem Schritt:** `rust:fmt:check` schlägt in 19 Dateien außerhalb des Gateways fehl (`betaclaw-features`, `betaclaw-knowledge`, `betaclaw-master`, `betaclaw-model-hub`, `betaclaw-store`, `betaclaw-world-model`); die geänderten Gateway-Dateien sind formatiert. `rust:check` bricht im Testtarget von `betaclaw-store` ab (`stats/engineering_metrics_service.rs:699`, `Option<i64>` statt `Option<f64>`). `rust:clippy` (Workspace, `-D warnings`) bricht im Testtarget von `betaclaw-skills` ab (`skills/shell_execute.rs:310`, `Duration` nicht importiert); die Lints anderer Crates laufen dann nicht. `cargo clippy -p betaclaw-gateway --all-targets -- -D warnings` in der Rust-Container-Umgebung: Exit 0. Eine Prüfung mit allen Targets (`cargo check -p betaclaw-gateway --all-targets`) brach zuletzt in `betaclaw-gateway/src/world_model_ops` ab, einem parallelen, noch nicht fertigen Arbeitsstrang. Der Build der Binaries im Container (`cargo build --bin betaclaw-gateway --bin betaclaw-scheduler`, Exit 0) und der Dev-Stack-Build auf dem Host kompilieren beide Binaries mit diesen Änderungen.
- **Offen:** `docs/DEPLOYMENT_OPERATIONS.md` beschreibt im Systemd-Abschnitt noch `server.ts` und `scheduler.ts` (Hinweis im Dokument). `docs/RUST_NODE_ELIMINATION_*` und `docs/archive/` bleiben als Historie. `dev:gateway` startet `betaclaw-gateway` über den PATH. Der Scheduler öffnet die Stores, bevor er die Schalter prüft, weil die Prüfung in `start_scheduler_runtime` liegt. Die Scheduler-Binary (`bin/betaclaw-scheduler.rs`) gehört einem anderen Arbeitsstrang. Der vollständige Produktions-Smoke (`test:e2e:production`, frische Volumes) ist nicht gelaufen; geprüft wurden das Probe-Image-Dockerfile und die Compose-Konfiguration.

### 2026-10-31 — Phase 3 Entfernung TS-Backend: Ops-Skripte der World Model als Rust-Subcommands

Ziel: Die Betriebsskripte `world-model:verify-rls`, `world-model:reconcile`, `world-model:rebuild-projections` und `world-model:backfill` laufen als Unterbefehle von `betaclaw-scheduler`. Die TS-Skripte dafür und die Phase-1-Skripte `world-model-migrate.ts` und `world-model-provision-roles.ts` sind gelöscht. Grundlage: `docs/TS_BACKEND_REMOVAL_PLAN.md`, Phase 3.

- **Unterbefehle:** `provision-roles [--apply]` (ohne Migration, wie das Skript), `verify-rls`, `reconcile [--dry-run] [--scope] [--output]`, `rebuild-projections [--dry-run] [--type] [--scope] [--resume] [--batch-size] [--include-observations] [--output]`, `backfill [--dry-run] [--scope] [--batch-size] [--resume] [--output] [--from] [--to]`. Ein unbekannter Unterbefehl endet mit Status 2 und startet den Scheduler nicht mehr.
- **Code:** `betaclaw-world-model/src/world_model/role_verification.rs` (Port von `world-model-verify-rls.ts`); `betaclaw-gateway/src/world_model_ops/` mit `mod.rs`, `verify_rls.rs`, `reconcile.rs`, `rebuild.rs`, `backfill.rs`; Einstieg `betaclaw-gateway/src/bin/betaclaw-scheduler.rs`. Die Module liegen im Gateway, weil `reconcile` und `backfill` die SQLite-Dateien der Node-Ära lesen und dafür die Knowledge-, Master- und Task-Stores brauchen, die von `betaclaw-world-model` abhängen. Vorhandene Rust-Logik wird wiederverwendet: Bridge, Projector, Task- und Action-Repositories, Graphiti-Client, Embedding-Worker und Knowledge-Repository.
- **Aufruf:** Die `world-model:*`-Befehle in `package.json` starten `scripts/rust-scheduler-ops.mjs`. Das Skript lädt `.env.local` mit `@next/env` wie `scripts/dev-stack-rust.mjs` und führt `cargo run --locked --bin betaclaw-scheduler -- <Unterbefehl>` aus. Bereits gesetzte Umgebungsvariablen haben Vorrang.
- **Vergleich mit TS:** Zwei frische `pgvector/pgvector:pg17`-Container, auf jedem `migrate`, `provision-roles --apply` und dieselbe Befehlsfolge (Verifikation, Reconcile vor und nach dem Backfill, Rebuild, Backfill als Dry-Run, mit Scope, für alle Mandanten und mit `--resume`). Eingabe waren identische SQLite-Fixtures (zwei Mandanten, Konversationen, Nachrichten, Missionsaufgaben, Ledger-Zeilen, eine Wissens-Episode und ein Meeting-Ledger). Die TS-Seite lief aus `git archive HEAD`, weil die Migrationen seit Phase 1 nicht mehr unter `src/server` liegen. Verglichen wurden Ausgabe (Zeile für Zeile, ohne Zeitstempel und Pfade), JSON-Berichte, Exit-Codes und der Datenbankzustand der Tabellen `world_model_*`. Ergebnis: Exit-Codes, Ausgaben und Datenbankzustand gleich. Dazu Fehlerpfade (Scope ungültig, fehlende URL, Rebuild ohne Scope, kein Embedding-Provider, World Model deaktiviert): gleicher Exit-Code und gleiche Ausgabe bis auf die unten genannten Abweichungen.
- **Bewusste Abweichungen:** `migrate` druckt die Migrationsliste ohne das Node-Format `util.inspect` (Phase-1-Ausgabe). Node druckt bei Fehlern den Stack, Rust nur die Meldung. Eine Batch-Größe unter 1 wird auf 1 angehoben; das Skript liefe bei negativen Werten endlos. Der `options`-Block des Backfill-Berichts hat eine feste Schlüsselreihenfolge. Verbindungsfehler kommen aus sqlx statt aus `pg`. Der Embedding-Provider folgt dem Rust-Laufzeitpfad (`.local/model-hub.db` relativ zum Arbeitsverzeichnis); der Vergleich setzt `MODEL_HUB_DB_PATH` auf eine leere Datei.
- **Befund, unverändert übernommen:** `verify-rls` meldet auf einer frisch provisionierten Datenbank `FAIL worker role cannot read world_model_observations (no grant)`, weil `WORKER_TABLES` die Observationen enthält. Das TS-Skript zeigt bei HEAD dasselbe. Offen: Check oder Grants anpassen. Die Entscheidung liegt nicht in diesem Schritt.
- **Tests:** Neu: 7 Tests in `role_verification`, 25 in `world_model_ops` (verify-rls 2, reconcile 5, rebuild-projections 6, backfill 9, Helfer 3). Der Vergleich mit TS lief zusätzlich als Befehlsfolge (siehe oben).
- **Gates:** `rust:check`, `rust:fmt:check` und `rust:clippy` grün; `rust:test`: 3612 bestanden, 0 fehlgeschlagen; `typecheck` und `lint` grün.
- **Offen:** Der Verify-Befund oben. `world-model:graphiti-evaluate` und `world-model:drill` bleiben TS (nicht im Auftrag). `scripts/trigger-knowledge-ingestion.ts`, `cleanup-task-workspaces.ts` und `attachments-consistency.ts` sind unverändert. `docs/runbooks/GRAPHITI_BACKEND.md` nennt weiter dieselben Befehle; sie gelten unverändert.

### 2026-10-31 — Phase 1 Entfernung TS-Backend: Laufzeit-Abhängigkeiten gelöst

Ziel: Der Standard-Stack (Compose) hängt nicht mehr am Node-Image. Grundlage ist
`docs/TS_BACKEND_REMOVAL_PLAN.md`, Phase 1. Das TS-Backend bleibt bis Phase 5 im Repo.

- **SQL-Migrationen:** Die 19 Dateien liegen per `git mv` unverändert in
  `rust/crates/betaclaw-world-model/migrations`. Der Default-Pfad steht in
  `world_model/migrations.rs` und `scheduler_runtime.rs`. `src/server/world-model/db.ts`
  (TS-Übergang bis Phase 5) liest denselben Ordner. Das Gateway-Image kopiert ihn an
  denselben relativen Pfad (`docker/Dockerfile.gateway`).
- **Rollen-Provisioning:** `scripts/world-model-provision-roles.ts` ist nach
  `world_model/role_provisioning.rs` portiert. Gleiche Rollen, gleiche Passwort-Variablen,
  gleiche Grants und Rollen-Settings, gleicher Dry-run und `--apply`. Passwörter werden nie
  ausgegeben. Der Zweig `GRANT SELECT ON _world_model_migrations` des TS-Skripts läuft nie
  (die Tabelle fehlt in der Existenzabfrage). Die Portierung übernimmt diesen Zustand, damit
  die Grants identisch bleiben (siehe OP-18).
- **Subcommand:** `betaclaw-scheduler migrate [--provision-roles] [--apply]` wendet die
  Migrationen mit dem Advisory-Lock an und provisioniert optional die Rollen. `--apply` gibt es
  nur zusammen mit `--provision-roles`. Ohne Subcommand startet der Scheduler wie bisher.
- **Compose:** Der Dienst `migrate` nutzt `docker/Dockerfile.gateway` (Image
  `betaclaw-gateway-local`) und ruft `betaclaw-scheduler migrate --provision-roles --apply`
  auf. Das Overlay `docker-compose.release-smoke.yml` setzt dafür den Gateway-Kandidaten.
- **CLI-Typen:** `protocol`, `events`, `method-scopes`, `exec-approval-manager` und
  `node-command-policy` liegen unter `src/shared/gateway/`. `personas/personaTypes` liegt unter
  `src/shared/personas/` und ist nur ein Re-Export von `src/shared/personaTypes.ts`. Alle
  Importe in `src`, `app` und `tests` wurden umgestellt. `exec-approval-manager` hält keinen
  Server-Zustand, nur die Datei `.local/exec-approvals.json`, die Server und CLI gemeinsam nutzen.
- **Befund beim Test gegen eine leere DB:** `apply_migrations` schlug in Rust fehl
  (`cannot insert multiple commands into a prepared statement`), weil Migrationsdateien über das
  Prepared-Protokoll liefen. `pg` sendet Abfragen ohne Werte mit dem Simple-Protokoll. Behoben
  mit `PgSession::execute_script` (`raw_sql` in `driver.rs`). Bis hierher hatte nur das TS-Migrate
  frische Datenbanken eingerichtet.
- **Passwort-Redaktion:** Die Meldung „nicht erreichbar“ zeigt die Admin-URL ohne Passwort
  (`redact_database_url`). Das TS-Original gibt die URL unverändert aus.
- **Abgleich der Grants:** TS-Migrate und TS-Provisioning gegen Datenbank A, Rust
  `migrate --provision-roles --apply` gegen Datenbank B (zwei frische `pgvector/pgvector:pg17`).
  Verglichen wurden `information_schema.role_table_grants` (188 Zeilen), `pg_roles` mit
  `rolconfig`, Datenbank- und Schema-Rechte, Spaltenrechte und das Ledger (19 Einträge). Ergebnis:
  identisch. Ein zweiter Lauf mit `--apply` ist ohne Änderung.
- **Gates:** `rust:fmt:check`, `rust:clippy` (`-D warnings`) und `rust:test` (3556 Tests, 0 rot)
  grün. `typecheck`, `lint` und `vitest` grün (3547 bestanden, 52 übersprungen; nach dem
  Registry-Nachtrag `tests/unit/ci` und `tests/unit/architecture`, 47 bestanden).
  `docker compose config` mit Platzhalter-Secrets über Umgebungsvariablen gültig.
  `test:e2e:production` grün: frische Volumes, der Dienst `migrate` wendet die 19 Migrationen an
  und provisioniert die Rollen, danach Login, Chat, Scheduler, Restore-Prüfung und Browser.
- **Offen:** Die TS-Skripte `world-model:migrate` und `world-model:provision-roles` bleiben als
  Werkzeug bis zur Entscheidung in Phase 3. Ebenso `scripts/world-model-verify-rls.ts`, das die
  Rollen voraussetzt. Die App-Rolle liest `_world_model_migrations` seit dem Nachtrag 2026-11-01 (OP-18).

### 2026-10-31 — Workspace aufgeteilt, rust-lld, `rust:check`

Ziel: kürzere Dev-Builds. `betaclaw-core` war ein Crate mit 207.354 Zeilen; jede Änderung
darin hat das ganze Crate und danach das Gateway neu gebaut.

- **Crate-Split:** Die Module liegen per `git mv` unverändert in zehn neuen Crates
  (`members = ["crates/*"]`): `betaclaw-base` (auth, config, db, gateway, gateway_config, js,
  logging, `safe_error_message`), `-model-hub`, `-store` (stats, personas, messages_store),
  `-world-model`, `-memory`, `-knowledge`, `-skills` (skills, security, net_guard),
  `-channels`, `-master`, `-features` (agent_room, agent_v2, agents, automation, clawhub,
  debug, proactive, tasks). Die Modulzyklen auth↔config und skills↔security bleiben jeweils
  in einem Crate. `betaclaw-core` ist Fassade: es re-exportiert alle Module unter
  `betaclaw_core::<modul>` und behält `diagnostics` und `migration_runner`. Das Gateway ist
  unverändert. Jedes `lib.rs` importiert die Nachbarmodule, deshalb gelten die
  `crate::<modul>`-Pfade weiter.
- **Nötige Code-Änderungen:** `string_enum!` ist `#[macro_export]` (clawhub nutzt es aus
  `betaclaw-store`). `PgQueryResult::first_id` ist eine freie Funktion in
  `memory/postgres.rs`, weil der Typ im World-Model-Crate liegt. `world_model::db::testing`
  ist zusätzlich über das Feature `test-support` sichtbar; `betaclaw-knowledge` aktiviert es
  nur als Dev-Abhängigkeit. Test-Abhängigkeiten stehen unter `[dev-dependencies]`.
- **Linker:** `rust/.cargo/config.toml` setzt für `x86_64-pc-windows-msvc` `rust-lld.exe`.
  Linux und Container sind nicht betroffen.
- **`pnpm run rust:check`:** Host-`cargo check` über alle Crates und Tests, ohne Codegen und
  Linken.
- **Dockerfile:** Die Dependency-Stage kopiert alle zwölf Manifeste und legt die Platzhalter
  in einer Schleife an.

Messung (Dev-Profil, Windows-Host, 12 Threads, beide Binaries, je eine neue Funktion in
der genannten Datei):

| Änderung in                  | Build vorher | Build nachher | `cargo check` vorher | nachher |
| ---------------------------- | ------------ | ------------- | -------------------- | ------- |
| `betaclaw-gateway` `main.rs` | 15,6 s       | 2,8 s         | 0,9 s                | 0,8 s   |
| `channels/mod.rs`            | 14,6 s       | 7,9 s         | 10,6 s               | 4,2 s   |
| `master/mod.rs`              | ca. 14,6 s¹  | 8,8 s         | ca. 10 s¹            | 4,5 s   |
| `model_hub/mod.rs`           | 14,9 s       | 13,1 s        | 9,6 s                | 8,2 s   |
| Clean-Build                  | 285,6 s      | 253,3 s       | —                    | —       |

¹ Vorher lag `master` im selben Crate wie `channels`; nicht einzeln gemessen.

rust-lld allein (vor dem Split) brachte die Gateway-Änderung von 15,6 s auf 2,9 s, bei
Core-Änderungen fast nichts. Der Split halbiert Änderungen in oberen Crates. `model_hub`
liegt weit unten und zieht fast alle Crates nach; dort bleibt der Gewinn klein.

Gates: Rust fmt, clippy (`--all-targets --features test-support -D warnings`) und
`cargo test --locked --features test-support` im Container `rust:1.94-bookworm` grün,
3540 Tests bestanden, 0 fehlgeschlagen. Die Zahl der Test-Attribute ist gleich wie vorher
(3539). Auf dem Windows-Host melden `skills/process_manager.rs` und
`skills/shell_execute.rs` ungenutzte Imports in `#[cfg(unix)]`-Tests; das bestand schon
vorher und betrifft den Linux-Gate nicht. `pnpm run rust:build` (Release-Image mit neuer
Dependency-Stage) erfolgreich.

### 2026-10-31 — Branches und Worktrees konsolidiert

Das Repository hat nur noch `main`. Ergebnis der Prüfung aller Zweige:

- **Integriert:** die ungesicherte Arbeit im Haupt-Checkout (Refuseless und Exec-Freigaben, je
  ein Commit) und die Tests aus `wip/main-local-changes`. Deren `vi.fn`-Mocks haben jetzt
  Typparameter. Im Konflikt behält der Full-Flow-Test das `waitFor`-Budget von `main`.
- **Exec-Freigaben, Nacharbeit:** Der neue Default (Freigabe aktiv) ließ drei Testdateien
  scheitern, die ohne Freigabe ausführen: `skills-route-requests`, der Klärungsfluss in
  `message-service-project-guard` und der Stream-Pfad in `webui-nexus-chat-stream-tools`. Sie
  setzen `BETACLAW_EXEC_APPROVALS_REQUIRED=false` jetzt per `vi.stubEnv`.
- **Gelöscht, weil schon in `main`:** die Lane- und Finish-Zweige von S6 bis S12
  (`lane/*`, `finish/*`, `rust`). Sie wurden über `rust` gemergt, keine ihrer Dateien fehlt in
  `main`. Gelöscht wurden auch `codex/publication-security` und `codex/public-release-go`
  (lokal und auf `origin`): Lizenzdateien, Secret-Scan und die Prüfung des Beispiel-Keys sind in
  `main`. Dazu kommen `fix/audit-2026-10-31` und die beiden `claude/backend-rust-migration-*`
  sowie alle zugehörigen Worktrees.

Gates auf dem integrierten Stand: typecheck, lint, format, check, build grün; Vitest mit
Coverage 3547 bestanden (Branches 77,49 %); Smoke 11/11, Browser-E2E 69/69, Production-Smoke
grün; Rust fmt, clippy und test grün.

### 2026-10-31 — Refuseless im Model Hub

Refuseless ist in beiden Provider-Katalogen und Adapter-Registries ergänzt
(16 Anbieter). Rust und TypeScript nutzen den gemeinsamen OpenAI-kompatiblen
Transport für Bearer-Auth, Chat, Streaming, Tools und den Verbindungstest.
Das vorbelegte Modell `deepseek-v4.1-flash-abliterated` erhält den Anzeigenamen
und das Kontextlimit aus der Anbieterkonfiguration; sein Ausgabelimit ist
131.072 Tokens. Die Reasoning-Auswahl steht auch im Chat-Profil zur Verfügung.
`off` wird als `none`, `medium` als unterstütztes `low` übertragen. Ein eigener
Refuseless-Key ist erforderlich; vorhandene OpenCode-Konten bleiben unverändert.

Verifikation: 25 gezielte TypeScript-Tests und 553 Model-Hub-Tests in Rust
bestanden. Typecheck, Next.js-Produktionsbuild, Oxlint ohne Diagnosen, Rustfmt
und Clippy für die Core-Bibliothek mit `-D warnings` erfolgreich. Der laufende
Rust-Gateway liefert Refuseless über `/api/model-hub/providers` aus. Ein echter
Provideraufruf bleibt bis zur Verbindung eines Refuseless-Kontos mit API-Key
offen; keine vollständige Workspace- oder E2E-Suite ausgeführt.

### 2026-10-31 — Review der Exec-Freigaben

- TypeScript bindet `areExecApprovalsRequired` in MessageService und allen vier
  betroffenen Handlern ein. Die Freigabe bleibt bei fehlenden, leeren oder
  unbekannten Werten aktiv; nur explizites `false` ohne umgebende Leerzeichen
  deaktiviert sie, unabhängig von der Großschreibung.
- Rust verwendet dieselbe Regel über `are_exec_approvals_required` sowohl für
  `SkillExecConfig` als auch für interaktive Chat-Freigaben. Konfiguration,
  Skill-Beschreibungen und Regressionstests bilden dieses Verhalten ab.
- Der neue Playwright-Freigabetest verwendet das unterstützte Unterkommando
  `test`. Bestehende Ausführungstests übergeben ihre Freigabe explizit und hängen
  nicht mehr vom früheren offenen Default ab.

Verifikation: 82 TypeScript-Tests in 23 betroffenen Testdateien und 61 gezielte
Rust-Tests bestanden. Typecheck und Next.js-Produktionsbuild erfolgreich; Oxlint
meldet in 2083 Dateien keine Diagnosen. Rustfmt, Clippy für die Core-Bibliothek
mit `-D warnings` und die Formatprüfung der geänderten TS-/Dokudateien bestanden.
Keine vollständige Workspace- oder E2E-Suite für diese Änderung ausgeführt.

### 2026-10-31 — Abhängigkeits-Audit und Updates

- `cargo audit` meldete 7 Befunde (`rustls` 0.23.45: RUSTSEC-2026-0346 bis -0349,
  `rustls-webpki` 0.103.15: -0382, `webpki-root-certs` 1.0.9: -0383, `ctutils` 0.4.3:
  -0385) und `tokio` 1.53.2 als unsound (-0386). `cargo update` hebt 47 Crates im
  erlaubten Bereich an, unter anderem `rustls` 0.23.46, `rustls-webpki` 0.103.16,
  `webpki-root-certs` 1.0.11, `ctutils` 0.4.7 und `tokio` 1.54.1. Danach: 310 Crates,
  keine Befunde.
- Direkte Abhängigkeiten: `getrandom` 0.3 → 0.4 (gleiche `fill`-API) und `rusqlite`
  0.40 → 0.41. In 0.41 liefert `Statement::column_names()` einen Iterator;
  `skills/db_query.rs` und `families/tasks/wire.rs` sind angepasst.
- `auth/csrf.rs`: `generate_token` ignorierte einen Fehler von `getrandom::fill` und
  hätte dann das vorhersagbare Null-Token ausgegeben. Es bricht jetzt ab, wie
  `randomBytes` in `next-auth`.
- Die Gemini-Fixture bleibt mit `@google/genai` 2.30 byte-gleich
  (`fixtures:gemini-traffic` ohne Diff); das Wire-Format ist unverändert.

Gates: `fmt:check` und `clippy -D warnings` exit 0. `cargo test`: 2990 (Core), 528
(Gateway), 9, 1, 10 bestanden, 0 fehlgeschlagen.

### 2026-10-31 — Fehlerprüfung nach rust-review, CI-Reparaturen

Gezieltes Review des Rust-Workspace nach dem BeautifulRust-Skill `rust-review`
(Panics auf erreichbaren Pfaden, `unsafe`, Locks über `.await`, Abbruchsicherheit).
Kein `unsafe` im Workspace. Die übrigen `unwrap`/`expect` außerhalb von Tests sind
statische Regex, Mutex-Poisoning oder vorher geprüfte Invarianten.

- `routes/auth.rs`: Ein relativer `callbackUrl` mit Nicht-ASCII-, Leer- oder
  Steuerzeichen (etwa `/ä`) ging roh in den `Location`-Header, und
  `parse().unwrap()` panickte. `post_signout` braucht dafür nur ein CSRF-Token.
  `sanitize_callback_url` kodiert diese Bytes jetzt prozentual, wie es next-auth über
  `new URL(callbackUrl, baseUrl)` tut. Test in `test_sanitize_callback_url`.
- `world_model/outbox_dispatcher.rs`: `dispatch_in_flight` wurde nur nach einem
  regulär beendeten Dispatch zurückgesetzt. `stop()` bricht den Timer-Task per `abort()`
  ab. Traf das einen laufenden Dispatch, lieferte nach einem neuen `start()` jeder
  Dispatch `0`. Ein Drop-Guard bildet jetzt das `finally` aus `outboxDispatcher.ts:83-85`
  nach. Test `an_unwinding_dispatch_clears_the_in_flight_flag`.
- `knowledge/runtime_loop.rs`: Derselbe Guard für `in_flight` (`finally` in
  `runtimeLoop.ts`). Vorher übersprang ein panickender Tick alle weiteren.
- `master/metrics.rs`: `percentile` sortiert mit `f64::total_cmp` statt
  `partial_cmp(..).expect(..)`.
- CI: Die Playwright-Jobs (`e2e-browser.yml`, `async-quality.yml`) laufen auf
  `ubuntu-24.04`. `ubuntu-latest` zeigt seit 2026-10-19 auf Ubuntu 26.04, das
  Playwrights Chromium nicht unterstützt. Die generierten Fixture-Verzeichnisse stehen
  in `.prettierignore`, weil lint-staged die Gemini-Fixture umformatierte und der
  CI-Frischecheck daran scheiterte. Die synthetischen Testwerte der Rust-Tests stehen
  exakt in der gitleaks-Allowlist.

Gates:

- Rust: `fmt:check` und `clippy -D warnings` exit 0. `cargo test`: 2990 (Core), 528
  (Gateway), 9, 1, 10 bestanden, 0 fehlgeschlagen.
- TS: `typecheck`, `lint`, `format:check` exit 0. `vitest run`: 630 Dateien, 3396 Tests
  bestanden, 52 übersprungen.

Nicht gelaufen: E2E-Lanes und Route-Parität lokal (keine betroffene Route außer dem
Header-Wert von `auth`). Der Runner-Pin für Playwright ist erst durch den nächsten
CI-Lauf belegt.

### 2026-10-30 — Host-Dev-Stack, Embeddings und semantischer Memory-Recall

- **Dev-Stack mit Watcher**: Mit `cargo` auf dem Host baut `pnpm run dev` Gateway und Scheduler
  im dev-Profil, startet Kopien aus `.local/rust-dev/bin` und baut und startet beide bei jeder
  Änderung unter `rust/crates` neu. Gemessen: Neustart nach 13,9 s und 21,2 s statt rund 6 min
  für den Release-Build (`lto = "thin"`, `codegen-units = 1`). Der erste Build dauert 3:46 min.
  Ein fehlgeschlagener Build lässt die laufenden Prozesse stehen. Der feste
  `SCHEDULER_INSTANCE_ID=dev-scheduler` lässt den neuen Scheduler seine Lease sofort übernehmen.
  `dev:import-legacy` nutzt das dev-Binary, sonst das Release-Binary.
- **Embedding-Worker schrieb nie**: Der Insert band den Vektor als `text`. `pg` lässt den Typ
  offen, sqlx typisiert ihn, also schlug jeder Insert fehl. Jetzt `$6::vector`. Der Worker
  verschluckte alle Fehler. Er loggt jetzt dieselben Zeilen wie `embeddingWorker.ts`
  (Sammeln, Ziel, fehlender Provider, keine Scopes).
- **Model-Hub-Embedding-Fallback** (`model_hub_embedding.rs`, Port von `provider.ts:36-81`):
  Ohne `EMBEDDING_*` bettet das World Model über den aktiven Kopf von `p1-embeddings` ein. Gilt
  für den Worker im Scheduler und den Health-Check.
- **Semantischer Memory-Recall**: Alle Produktionsstellen bauten `PostgresMemoryClient::new`
  ohne Embedder, Recall war damit nur lexikalisch. `canonical_memory_client` löst den Provider
  pro Abfrage auf (Memory-Route, Diagnose, Chat-Runtime, Knowledge-Runtime). Live belegt: eine
  englische und eine deutsche Frage finden einen englischen Eintrag.
- **Diagnose-Memory** nutzt den kanonischen PostgreSQL-Executor. **Migrationen im
  Outbox-Dispatcher** laufen mit `WORLD_MODEL_ADMIN_DATABASE_URL` auf eigenem Pool, so dass
  „permission denied for schema public“ beim Start entfällt.
- **Offen**: Eine Observation mit 7214 Zeichen überschreitet das Eingabelimit des
  Embedding-Modells (HTTP 422) und erscheint alle 30 s im Log. TypeScript verhält sich gleich.
- **Gates**: `cargo fmt --check`, `cargo clippy -D warnings` exit 0, gezielte Tests 15
  (Gateway) und 49 (Core) grün, oxlint und Prettier für die Skripte sauber.

### 2026-10-30 — Restpunkte auf main nachgezogen

Stand auf `main` nach dem Merge von `rust`. Die Punkte „nicht gelaufen“ des Eintrags darunter
sind damit zum Teil erledigt. Die Abschnitte bleiben als Verlauf stehen.

- **Guard-Test** `no-explicit-any-guard`: schließt `.claude/` aus (`61b3e13a`). Der Test fand
  `any` in Repo-Kopien fremder Sessions unter `.claude/worktrees`.
- **Sicherheit**: `scripts/dev-stack-rust.mjs` übergab die Datenbank-URLs mit Passwort als
  Argument an `docker`. Sie sind jetzt in der Umgebung des `docker`-Prozesses, im Argument steht
  nur der Name (`f2048f92`). Befund einer automatischen Sicherheitsprüfung.
- **CI-Parität Memory**: Ohne `MEMORY_PROVIDER` fiel der Rust-Gateway auf Mem0 zurück. Mem0 ist in
  CI nicht konfiguriert, alle Memory-Fälle antworten mit 500. `ci.yml` setzt jetzt
  `MEMORY_PROVIDER=sqlite` und `MEMORY_DB_PATH` im Scratch-Verzeichnis (`ec491013`). Verifiziert:
  vollständiger Parity-Lauf mit exakt der CI-Umgebung (Gateway nur mit den CI-Variablen, Harness
  ohne `.env.local`): `PARITÄT VOLLSTÄNDIG`, 18 Familien, exit 0.
- **`REQUIRE_AUTH=true`-Lauf**: Kein Gate. Nur die Familien mit `AUTH_LANE` (`channels-wire`,
  `master`, `ops`-Probes) prüfen dort die Auth-Probes. Die übrigen Familien schicken Standardfälle
  ohne Session. Rust antwortet mit 401, die TS-Seite läuft im Prozess und liefert Daten. Der
  einzige Fall mit anderem Status (`/api/internal/stats/engineering/snapshots` ohne Token: Rust
  401, TS 503) ist ein Harness-Artefakt. Der TS-Proxy lässt diesen Pfad ohne Auth ebenfalls nicht
  durch, nur der Graphiti-Pfad ist öffentlich.
- **Branch `wip/main-local-changes`** (`ab7774a9`): 36 Dateien, überwiegend neue Unit-Tests für
  agent-v2, channels, knowledge und master, Änderungen an `vitest.config.ts` und die Löschung von
  `.github/workflows/openai-worker-ci.yml`. Am 2026-10-31 nach `main` integriert (siehe dort).
- **Telegram im Compose-Smoke**: nicht umgesetzt. Der Poller spricht `api.telegram.org`. Ein Test
  im Compose-Stack braucht entweder eine konfigurierbare Basis-URL (der Plan verbietet eine neue
  Variable dafür) oder echten Netzzugriff. Entschieden: nicht umsetzen. Der Unit-Test mit
  Telegram-Attrappe deckt den Pfad ab.
- **Gates auf `main`**: `typecheck`, `lint`, `format:check` exit 0, Guard-Test allein grün. Die
  volle Vitest-Suite lief vor dem Guard-Fix auf dem gemergten Stand, mit dem einen Fehler, der
  jetzt behoben ist.

### 2026-10-30 — Offene Punkte geschlossen, Testlauf

Die offenen Punkte aus RUST_NODE_ELIMINATION_FIXES.md wurden am Code geprüft (Details dort,
Abschnitt „Nachprüfung am Code“). F3, A3, F8, F9, F14, F23 und E7 sind umgesetzt. A5 war für
Persona-Poller und Swarm umgesetzt, nicht für den Scheduler. Das ist jetzt nachgezogen.

Änderungen dieser Runde:

- `scheduler_runtime.rs`: `AutomationRuntime::stop` ist async und wartet auf den laufenden Tick,
  bevor der Lease freigegeben wird. Der Prospective-Timer nutzt denselben Drain. Test
  `automation_stop_waits_for_the_in_flight_tick`.
- World-Model-Health, Check 8 (`checks.scheduler`): im Rust-Port fehlend, jetzt portiert.
  `WorldModelPort::health` nimmt die Automation-Metriken entgegen, der Handler liefert sie.
  Zwei neue Tests (veraltete und fehlgeschlagene Lease-Abfrage). Der Route-Test setzt jetzt einen
  frischen Lease, sonst meldet der Port korrekt `degraded`.
- Parität `auth`: schließt den globalen Auth-Store vor dem Löschen des Scratch-Verzeichnisses.
  Unter Windows verhinderte das vorher den Abschluss mit EPERM.
- Drei Fixtures und `production-smoke.mjs` mit Prettier formatiert. Die TS-Parität liest sie
  semantisch, die beiden betroffenen Tests laufen grün.

Gates:

- Rust: `fmt:check` und `clippy -D warnings` exit 0. `cargo test`: 2988 (Core), 525 (Gateway),
  9, 1, 10 bestanden, 0 fehlgeschlagen. Ein Gateway-Test schlug im ersten Lauf fehl und
  danach nur für das Modul `world_model_port` (13/13 grün).
- TS: `typecheck`, `lint`, `format:check` exit 0. `vitest run`: 630 Dateien, 3395 Tests
  bestanden, 52 übersprungen (Lauf vor der Prettier-Formatierung der Fixtures, die Tests
  wurden danach einzeln wiederholt).
- `verify:route-coverage`: 188 Verträge, Selbsttest bestanden.
- `verify:route-parity`: alle Familien grün (`PARITÄT VOLLSTÄNDIG`, exit 0). Gegen den
  Gateway-Container über `docker exec curl`, `NEXTAUTH_URL` auf beiden Seiten gleich,
  `REQUIRE_AUTH=false` wie in CI, `WORLD_MODEL_ENABLED=true`, `MEMORY_PROVIDER=sqlite` auf der
  Rust-Seite. Die Parität mit `REQUIRE_AUTH=true` lief nicht, CI fährt sie ebenfalls nicht.
- Produktions-Smoke (`run-production-smoke.mjs`, eigenes Compose-Projekt, Gateway-Image aus
  dem aktuellen Stand): `ok: true`, inklusive `swarmTurn: true`, Scheduler `200`,
  `browserLogin: true`. Telegram ist im Smoke nicht enthalten. Die Strecke ist nur durch den
  Unit-Test mit Telegram-Attrappe belegt.
- `pnpm run build` (Node mit API-Routen) exit 0. `build:export` lief im Gateway-Image-Build.

- Browser-E2E (`test:e2e:browser`) auf dem Host: 69 Tests bestanden, 0 fehlgeschlagen. Dafür
  wurde Chromium für Playwright 1208 (Chrome Headless Shell 145.0.7632.6) per
  `playwright install chromium` installiert. Der Container-Lauf
  (`run-browser-in-container.ps1`) scheiterte vorher am Turbopack-Build (Postcss-Loader
  „failed to receive message“). Er ist nicht wiederholt.

Nicht gelaufen oder nicht belegt:

- CI-Konfiguration der Parität nicht nachgestellt: CI setzt `MEMORY_PROVIDER` nicht. Rust wählt
  dann nach `WORLD_MODEL_MODE` zwischen Postgres und Mem0. Ob die Memory-Familie dort gegen
  SQLite vergleicht, ist ungeprüft.
- Telegram-Strecke im Compose-Stack ohne Attrappe.

### 2026-10-30 — WebSocket-Close-Fix und Benchmark ohne Node

**Befund beim Benchmark:** Der Gateway beantwortete ein Close des Clients nicht. Der
Writer-Task in `ws.rs` hielt einen eigenen Klon von `ClientHandle` und damit einen Sender des
Outbound-Kanals. Der Kanal schloss nie, also endete der Writer nie. Die von tungstenite
vorbereitete Close-Antwort wurde nie gesendet. Pro getrennter Verbindung blieben ein Task und
der Socket offen. Der Fehler bestand seit `e130a435` (S3). Das Original antwortet in rund
3 ms.

- `gateway/client.rs`: Neue Methode `buffered_counter()`. Sie gibt nur den Bytezähler heraus.
- `ws.rs`: Der Writer hält nur noch Zähler und Verbindungs-ID. Nach seiner Schleife ruft er
  `sink.close()` auf und sendet so die Close-Antwort.
- Neuer Test `websocket_client_close_is_answered` in `tests/gateway_http.rs`.
- Live geprüft: Close-Antwort nach 5,7 ms, `wasClean` true.

Gates im Container: `cargo fmt` und `clippy -D warnings` exit 0. `cargo test` 3.530 bestanden
(2.988 Core, 522 Gateway, 9, 1, 10), 0 fehlgeschlagen.

**Benchmark.** Der Rust-Gateway läuft im Static-Modus (`BETACLAW_UI_MODE=static`) ohne
Node-Prozess in Docker Desktop. Das Original (`main` in `.worktrees/bench-orig`) läuft mit
`server.ts` direkt auf dem Host. Beide laufen im Produktionsmodus mit `REQUIRE_AUTH=true`
und derselben Kopie von `.local`. Beide nutzen dieselbe PostgreSQL. Gemessen wurden 400
Requests bei Concurrency 16 nach 40 Warm-up-Requests, ein Lauf je Seite. Das Skript liegt
nicht im Repo.

| Route                        | Rust rps | Rust p50 / p95 ms | Original rps | Original p50 / p95 ms |
| ---------------------------- | -------- | ----------------- | ------------ | --------------------- |
| `/api/health`                | 576      | 25,5 / 49,1       | 269          | 56,9 / 73,4           |
| `/api/logs?limit=50`         | 1765     | 8,5 / 13,5        | 282          | 54,2 / 71,9           |
| `/api/control-plane/metrics` | 111      | 139,5 / 177,5     | 110          | 141,1 / 180,2         |
| `/api/model-hub/providers`   | 2013     | 7,5 / 11,6        | 300          | 50,8 / 79,6           |
| `/api/security/status`       | 2101     | 7,3 / 11,4        | 373          | 43,3 / 54,6           |
| `/api/auth/session`          | 2334     | 6,5 / 10,1        | 340          | 43,9 / 72,4           |
| `/login`                     | 711      | 19,0 / 58,4       | 105          | 145,8 / 206,7         |
| `/`                          | 1143     | 10,4 / 47,4       | 696          | 21,5 / 36,8           |
| WS-Handshake                 | –        | 3,9 / 5,8         | –            | 2,6 / 5,4             |

| Speicher                    | Leerlauf | Nach dem Lauf |
| --------------------------- | -------- | ------------- |
| Rust-Gateway (Container)    | 38,4 MiB | 68,0 MiB      |
| Original-Node (Working Set) | 151,9 MB | 411,3 MB      |

Bewertung: Bei Durchsatz und Latenz gewinnt Rust deutlich. Die meisten API-Routen schaffen
den 5- bis 7-fachen Durchsatz, `/login` den 7-fachen. `/api/control-plane/metrics` ist
gleich schnell, weil beide auf dieselben World-Model-Abfragen in PostgreSQL warten. `/api/health`
fragt seit OP-18 dieselben Daten ab und erreicht den doppelten Durchsatz. Beim Speicher braucht
der Gateway unter Last rund ein Sechstel. Da kein Node-UI-Server mehr läuft, ist das jetzt ein
Vergleich der ganzen Anwendungsprozesse. Der Scheduler fehlt auf beiden Seiten in der Messung:
Das Original führt Swarm-Runner und Cleanup im selben Prozess aus. Der Rust-Scheduler lief nicht
mit, im Compose-Betrieb kommen rund 23 MiB dazu.

Einschränkungen: Rust läuft in der Docker-VM, das Original nativ unter Windows. `/` liefert
bei Rust die statische `index.html`, beim Original eine Next-Seite. Die Inhalte sind daher
nicht gleich. Der Datenbestand ist klein, und gemessen wurde nur ein Lauf je Seite.

### 2026-10-29 — Review-Korrekturen nach der Abnahme F1–F25

- **Loopback-Marker (Sicherheit):** `dev:web-ui` band Node auf `0.0.0.0` und vertraute
  dabei jedem weitergereichten `x-betaclaw-client-loopback`. Ein LAN-Client konnte den
  Header selbst senden. `applyLoopbackMarkerForTopology` übernimmt den Marker jetzt nur
  von einem Loopback-Peer. Der Dev-Stack setzt `HOSTNAME=0.0.0.0` nur, wenn der Gateway
  im Container läuft, sonst `127.0.0.1`. Neuer Test in `proxy-policy.test.ts`.
- **Swarm-Dispatch wie `turnDispatch.service.ts`:** Die Command-ID entsteht vor dem
  Enqueue (`SessionCommand::command_id`, an `input_command`/`follow_up_command`
  durchgereicht). Swarm wird gespeichert und mit `sessionId`, `commandId`,
  `currentPhase`, `leadPersonaId`, `agentPersonaId` gesendet, danach eingereiht. Die UI
  ordnet `agent.v2.command.started` damit wieder der richtigen Persona zu.
  Bewusste Abweichung: Scheitert das Enqueue, gibt Rust die Command-ID frei und behält
  die Session; TS bliebe auf einer nie gestarteten Command hängen.
- **Swarm-Randfälle wie TS:** Command ohne Session wartet statt neu zu dispatchen; ein
  Swarm ohne Units wird übersprungen; ein fehlgeschlagenes Speichern des Fehlerstatus
  bricht den Tick für andere Swarms nicht mehr ab.
- **Dev-Cleanup:** Ohne Rust-Scheduler-Binary (Windows) übernimmt bei
  `BETACLAW_WORKSPACE_CLEANUP=rust` der Node-UI-Server das Aufräumen; `dev:static`
  meldet, dass es nicht läuft.
- `/out/` steht in `.gitignore`. `BETACLAW_UI_MODE=off` aus README/AGENTS entfernt
  (nie implementiert).

Gates: `rust:fmt:check` und `rust:clippy` exit 0; `rust:test` 3.529 bestanden (2.988
Core, 522 Gateway, 8 HTTP, 1 Gemini, 10 NextAuth; +3 Swarm-Tests). TS: typecheck und
lint 0, `proxy-policy.test.ts` 53/53, Swarm-Parität gegen den TS-Orchestrator grün.
Nicht erneut: volle TS-Suite, `verify:route-parity`, Browser, Image, Smoke.

### 2026-10-29 — Abnahme der Nacharbeiten F1–F25

Die Korrekturen aus `RUST_NODE_ELIMINATION_FIXES.md` und die zusätzlichen Befunde
aus `RUST_NODE_ELIMINATION_REVIEW.md` sind implementiert. Der echte Compose-Smoke
hat weitere Integrationsfehler sichtbar gemacht, die ebenfalls behoben sind:

- Scheduler, Automations-API und Health-Endpunkt verwenden dieselbe Automations-DB.
- Der PostgreSQL-Treiber nutzt gecachte Parameter-Metadaten für UUID, Zeitstempel,
  JSON, kleine Ganzzahlen, REAL und Enum-Werte; er trennt den Metadaten-Cache vom
  typisierten Abfrage-Cache. UUID-/Enum-Rückgaben und VOID-Scope-Ergebnisse werden
  korrekt gelesen. Die Eingaben bleiben gebundene Parameter.
- Agent-v2-Completion enthält den gespeicherten Assistententext zusätzlich zu den
  Nachrichten-IDs. Dadurch enthält das Swarm-Artefakt die echte Modellantwort.
- `dev:next` wählt Turbopack explizit. Ein Browser-Test weist den HMR-Kanal durch
  den Rust-Proxy und eine automatisch gerenderte Änderung im isolierten Quellbaum nach.
- Das Image enthält Python und Node/Playwright/Chromium als Werkzeuglaufzeiten.
  Gateway und Scheduler sind Rust-Prozesse; der Node-Anwendungsserver bleibt optional.

| Prüfung                | Ergebnis / Umfang                                                                                                                                                                                                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust                   | Zwischenstand: 3.525 Workspace-Tests bestanden. Nach den letzten Integrationskorrekturen gezielte Prüfung statt erneutem Vollauf: 4 Poller-Tests inklusive Drain, echter PG-Treibertest, Build, Formatcheck und strenges Clippy für Core/Gateway grün.                       |
| TypeScript             | Typecheck und Oxlint grün. Vollauf: 3.393 bestanden, 52 übersprungen, ein Timeout; der betroffene Master-Test besteht gezielt 2/2. Weitere Volläufe auf Nutzerwunsch beendet.                                                                                                |
| Routen                 | Alle 17 Paritätsfamilien über Hauptlauf und gezielte Wiederholung von Stats/Tasks grün. Nicht geprüfte externe Aktionen werden im Harness ausdrücklich als SKIP ausgegeben.                                                                                                  |
| Abdeckung / Fixtures   | 188 Pfad-/Methodenpaare deklariert; echter negativer CLI-Test grün. Echte NextAuth-Fixtures semantisch geprüft; keine Zufallsdateien bei normalen Testläufen geschrieben.                                                                                                    |
| Browser                | Bestehende Suite: 68/69 grün; Fokus-Test wartete nicht auf die gerenderte Navigation, Bereitschaftswait ergänzt. Keine weitere Vollsuite. Separater echter Rust-Login mit Fehlerfall, Reload und Login-Redirect sowie Proxy-HMR grün.                                        |
| Produktionsnaher Smoke | Aktuelles Binary im isolierten Compose-Projekt: reale Anmeldung, HTTP-/WS-Ablehnung, lokaler HTTP-Modell-/Embedding-Provider, kanonische PG-Memory, Chat samt Persistenz, echter Swarm-Antworttext und Scheduler-Health grün. Python, Chromium sowie PG-Backup/Restore grün. |

Der Smoke verwendet einen lokalen Modell-HTTP-Server, keine produktiven Konten.
Live-Telegram, externe Modellanbieter, Graphiti/Mem0 und ein Produktions-Cutover
wurden nicht neu abgenommen. Die Testprojekte verwenden eigene leere Volumes;
Produktionsdaten und bestehende Entwicklungsdaten bleiben unberührt.

Der abschließende Lauf mit dem Release-Image
`betaclaw-rust-fixes:20261029`
(`sha256:1379560b9234c8f405ee211bc1b41a09b414d98001e09b71e1858faf0c41779b`)
bestand ebenfalls vollständig: Swarm-Antworttext, Chat, PG-Memory, Browser-Login,
Worker-Verbindung, Python, Chromium und Backup/Restore. Der Smoke benötigt keinen
Node-Anwendungsserver. Das optionale Legacy-Profil wurde erst für die Messung gestartet.
Beim Aufräumen wird dieses Profil ausdrücklich mit entfernt.

#### Kleine Vergleichsmessung am 2026-10-29

Gleiches Compose-Netz, authentifiziert, Identity-Encoding, alle Antwortkörper
vollständig gelesen, drei Aufwärmläufe. Vollständige Seite: HTML plus alle zehn
JS-/CSS-Assets, zehn Stichproben bei Parallelität 2. Session/Health: je 40
Stichproben bei Parallelität 4. Das ist eine kleine Warmmessung, kein Dauerlasttest.

| Pfad / Arbeitslast           | Rust Durchläufe/s | Node Durchläufe/s | Rust p50 / p95 (ms) | Node p50 / p95 (ms) |
| ---------------------------- | ----------------- | ----------------- | ------------------- | ------------------- |
| `/` mit allen JS-/CSS-Assets | 113,58            | 76,49             | 18,14 / 21,01       | 26,29 / 39,42       |
| `/api/auth/session`          | 1.998,49          | 252,54            | 1,86 / 3,76         | 14,32 / 23,42       |
| `/api/health`                | 2.050,26          | 263,93            | 1,83 / 3,04         | 14,97 / 16,72       |

| Container nach der Messung              | RAM        |
| --------------------------------------- | ---------- |
| Rust-Gateway                            | 71,22 MiB  |
| Rust-Scheduler                          | 22,74 MiB  |
| Optionaler Node-Referenzserver `web-ui` | 233,40 MiB |
| Gemeinsames PostgreSQL                  | 76,38 MiB  |

Die Referenz teilt Datenbank und Rust-Scheduler mit dem Kandidaten; die RAM-Zahlen
sind deshalb pro Container angegeben und keine normierte Vollstack-Gegenüberstellung.
Reproduzierbar über `scripts/e2e/run-production-smoke.mjs --benchmark` mit optional
vorgebauten `RELEASE_SMOKE_IMAGE` und `RELEASE_SMOKE_PROBE_IMAGE`. Lokale Rohdaten:
`.tmp/rust-fixes-release-smoke-final/benchmark.json` und `benchmark-memory.jsonl`.

Die folgenden älteren Einträge sind historische Arbeitsstände. Frühere pauschale
100%-Abschlussmeldungen werden durch die aktuelle Abnahme der Nacharbeiten ersetzt.
Maßgeblich sind deren konkrete Prüfergebnisse und Grenzen.

### 2026-10-29 — Dev-Stack-Fixes, Upgrade-Tunnel, Lastbefunde und Benchmark

Der erste Lauf von `pnpm run dev` mit Login und Log-Prüfung hat fünf Fehler gezeigt.
Ein Lasttest gegen das unveränderte Original (`main` in `.worktrees/bench-orig`) hat zwei
weitere gezeigt. Alle Änderungen sind uncommitted im `rust`-Worktree.

1. **Scheduler-Start unter Windows** (`scripts/dev-stack-rust.mjs`): Standalone-`pnpm` ist
   eine native `.exe`. Der Stack startete sie als JS-Einstiegspunkt mit `node`, und der
   Scheduler stürzte ab. `resolvePackageManagerInvocation` ruft eine `.exe` jetzt direkt auf.
2. **Login-Hydration und HMR**: Der Next-Dev-Client verbindet sich über `/_next/hmr`. Der
   Gateway reichte keine HTTP-Upgrades durch, und `server.ts` lehnte mit
   `BETACLAW_DISABLE_WS` jeden Upgrade ab. Nach zwölf Fehlversuchen lud der Client neu, und
   das Login-Formular hydrierte nie.
   - `server.ts`: Im Dev-Modus gehen Upgrades außerhalb von `/ws` an
     `app.getUpgradeHandler()`. `/ws` bleibt 404.
   - `proxy.rs`: `proxy_upgrade` tunnelt Upgrade-Anfragen (`Upgrade`-Header plus
     `upgrade`-Token in `Connection`) über `hyper` http1 und `copy_bidirectional`. Der
     Loopback-Marker wird wie im normalen Proxy neu abgeleitet. Eine Antwort ohne 101 geht
     ohne Hop-by-Hop-Header zurück. Neuer Test
     `upgrade_needs_both_connection_token_and_upgrade_header`.
3. **`/ws` lieferte 401**: `dev-stack-rust.mjs` setzte im Gateway-Container ein festes
   `NEXTAUTH_SECRET`. Der Gateway konnte die Session-Cookies der UI daher nicht
   entschlüsseln. Der Container erhält jetzt nur den Variablennamen und übernimmt den Wert
   aus `.env.local`.
4. **503 unter Last auf `/api/logs`** (`routes/logs.rs`): Drei Handler nutzten `try_lock()`
   auf dem Repository und antworteten bei Konkurrenz mit 503. Die TypeScript-Route bedient
   parallele Leser. Die Handler warten jetzt mit `lock().await`, und `database_busy` ist
   entfernt.
5. **`/api/health` und `/api/security/status` langsam unter Last**: Beide prüfen für fünf
   Channels, ob ein Credential hinterlegt ist. Jede Prüfung öffnete die Messages-DB neu und
   parste das Schema. Ein `perf`-Profil mit Symbolen zeigte 99 % der CPU in
   `channel_secret_configured` und rund 58 % in `futex`-Syscalls am globalen Malloc-Mutex von
   SQLite.
   - `routes/security.rs`: `read_channel_credential` hält pro DB-Pfad eine Read-only-Verbindung
     (`SQLITE_OPEN_NO_MUTEX`) und nutzt `prepare_cached`. Bei einem Query-Fehler wird die
     Verbindung verworfen. Neuer Test `cached_credential_connection_sees_later_writes`.
   - `families/ops_wire/diagnostics.rs`: Die doppelte Implementierung ist entfernt, die
     Funktion delegiert an `read_channel_credential`.
   - Grenze: Wird die Datei zur Laufzeit gelöscht und am selben Pfad neu angelegt, liest der
     Cache die alte Datei weiter (OP-20).

Gates im Container nach allen Änderungen: `cargo fmt --check` exit 0, `clippy -D warnings`
exit 0, `cargo test -p betaclaw-gateway` 492 + 7 + 7 + 1 bestanden, 0 fehlgeschlagen. Das
Image `betaclaw-gateway-local` ist neu gebaut. Die TypeScript-Gates (`typecheck`, `lint`,
`test`) und `verify:route-parity` liefen nach diesen Änderungen nicht erneut.

**Benchmark** gegen das Original, beide im Produktionsmodus mit `REQUIRE_AUTH=true`. Gleicher
Daten-Snapshot, 400 Requests bei Concurrency 16 nach 40 Warm-up-Requests. Der Rust-Gateway
läuft in Docker Desktop, das Original direkt auf dem Host.

| Route                        | Rust rps | Rust p50 ms | Original rps | Original p50 ms |
| ---------------------------- | -------- | ----------- | ------------ | --------------- |
| `/api/security/status`       | 3036     | 5.0         | 566          | 27.6            |
| `/api/health`                | 750      | 20.7        | 348          | 42.5            |
| `/api/logs?limit=50`         | 2409     | 5.8         | 490          | 31.5            |
| `/api/model-hub/providers`   | 3329     | 4.5         | 568          | 28.1            |
| `/api/control-plane/metrics` | 562      | 27.7        | 160          | 99.9            |
| `/api/auth/session` (Proxy)  | 368      | 37.7        | 571          | 26.8            |
| `/login` (Proxy)             | 132      | 119.1       | 172          | 91.4            |
| WS-Handshake                 | –        | 3.0         | –            | 2.3             |

Vor Befund 5 lagen `/api/security/status` bei 162 rps und `/api/health` bei 105 rps.

Einschränkungen:

- Die Zahlen für `/api/health` und `/api/control-plane/metrics` stammen von vor OP-18. Der
  Gateway fragte die World-Model-Daten damals nicht ab und machte weniger Arbeit als das
  Original. Seit OP-18 fragt er sie ab; ein neuer Benchmark steht aus.
- Der Datenbestand ist klein (`/api/logs` mit einem Eintrag).
- Routen, die an Node gehen, sind durch den zusätzlichen Hop langsamer.
- RAM: Der Gateway braucht rund 22 MiB. Der Node-Prozess der UI schwankte zwischen den Läufen
  von 136 bis 268 MB, das Original von 151 bis 190 MB. Ein RAM-Gewinn ist damit nicht belegt.

### 2026-10-29 — Nacharbeiten aus RUST_NODE_ELIMINATION_FIXES.md (teilweise umgesetzt, überholt)

Überholt durch „Abnahme der Nacharbeiten F1–F25“ oben: Die hier als offen genannten
Punkte und das Compose-Risiko sind dort behoben. Eine frühere Fassung dieses Eintrags meldete alle 25 Befunde als abgeschlossen. Die
Code-Prüfung am selben Tag hat das widerlegt. Der Stand je Befund steht in
`docs/RUST_NODE_ELIMINATION_FIXES.md` §0. Kurzfassung:

- **Behoben:** F2, F4, F5, F10, F11, F17, F19, F20, F22. Bei F12, F13 und F18 ist der Code
  korrigiert, die geforderten Tests fehlen.
- **Teilweise:** F1 (Inbound angebunden, Attrappen-Tests fehlen), F6, F7, F15, F16, F21,
  F24, F25.
- **Offen:** F3 (Swarm-Tick ohne Turn-Dispatch), F8 (Paritätsfamilie `auth` fragt nur
  Rust ab), F9 (Routen-Abdeckung ist weiter eine Präfixliste), F14 (keine Kompression),
  F23 (`set_var` im Test), A5 (Stopp mit `abort()`), E7, Benchmark.
- **Risiko:** `docker-compose.yml` setzt `BETACLAW_SWARM_RUNNER` standardmäßig auf `rust`,
  obwohl A3 nicht fertig ist. Swarms laufen im Compose-Standardbetrieb nicht weiter.
  Ohne das Profil `legacy-node-ui` führt auch kein Node-Prozess sie aus.

Gates am 2026-10-29 (Container `rust:1.94-bookworm` bzw. Host-Node):
`cargo fmt --check` und `cargo clippy --all-targets -- -D warnings` ohne Befund,
`cargo test --features test-support` 3.514 bestanden (2.986 core, 509 gateway lib,
8 `gateway_http`, 1 `gemini_fixture`, 10 `nextauth_parity`), `pnpm run check` ohne Befund,
`vitest` 3.393 bestanden, 52 übersprungen. Nicht gelaufen: `verify:route-parity`,
`test:e2e:browser`, Production-Smoke. `verify:route-coverage` meldet 113/113, prüft aber
nur Präfixe (F9).

### 2026-10-29 — Vollständige Umsetzung des Node.js-Eliminierungsplans (Phasen 1–5 abgeschlossen)

Der in `docs/RUST_NODE_ELIMINATION_PLAN.md` definierte Plan zur vollständigen Entfernung von Node.js aus dem Produktionspfad wurde in allen 5 Phasen umgesetzt und abgesichert:

1. **Phase 1: `/api/auth/*` nativ in Rust**:
   - NextAuth v4 kompatibles JWE (`dir`/`A256GCM`) mit HKDF-SHA256 (`encode_session_token`) in `betaclaw-core::auth::jwe`.
   - NextAuth v4 CSRF (`token|sha256(token + secret)`) mit konstanter Zeitprüfung (`subtle::ConstantTimeEq`) in `betaclaw-core::auth::csrf`.
   - Native Axum-Endpunkte in `betaclaw-gateway::routes::auth`: `providers`, `csrf`, `callback/credentials` (mit Login-Rate-Limiter und Cookie-Chunking), `session` (rollende 30-Tage-Erneuerung), `signout`, `error`, `signin`.
   - Tests: 9/9 NextAuth-Paritätstests in Rust (`tests/nextauth_parity.rs`), Vitest Gegenprüfung in `tests/unit/gateway/nextauth-reverse-parity.test.ts`.

2. **Phase 2: Statischer UI-Export & Gateway Static Serving**:
   - `app/page.tsx` und `app/login/page.tsx` auf Client-Komponenten umgestellt (SSR-Auth und Node-Server-Dependencies entfernt; Runtime-Config via `src/shared/config/uiRuntimeConfig.ts` und `/api/config`).
   - `next.config.ts`: `output: 'export'` und `pageExtensions: ['tsx']`.
   - `pnpm run build` exportiert statisch nach `out/`.
   - `static_ui.rs` in `betaclaw-gateway` mit `tower-http/fs`: Auth-Weiche (`/` leitet ohne Session auf `/login`, `/login` mit Session auf `/`), Next.js Security-Header (CSP, nosniff, DENY) & Demo-Mode-Header, Cache-Header (`/_next/static/**` 1 Jahr immutable, HTML `no-cache`), 404-Fallback (`out/404.html`).
   - Umschaltbar via `BETACLAW_UI_MODE=static|proxy`.

3. **Phase 3: Hintergrundjobs nach Rust**:
   - `persona_poller.rs`: Telegram-Polling aktiver Persona-Bots mit Token-Deduplizierung und Offset-Aktualisierung.
   - `swarm_runtime.rs`: Swarm-Orchestrator-Schleife mit Startup-Recovery (`recover_running_swarms()`).
   - `workspace_cleanup.rs`: Periodischer Aufräumjob für verwaiste Task-Workspaces (`cleanup_orphan_task_workspaces`).
   - Node-Absicherung in `server.ts`: Vermeidung von Doppel-Polling (409) und redundanten Node-Jobs über `BETACLAW_TELEGRAM_POLLER=rust`, `BETACLAW_SWARM_RUNNER=rust`, `BETACLAW_WORKSPACE_CLEANUP=rust`.
   - Geordnetes Herunterfahren (Graceful Shutdown) von Sockets, Knowledge-Loop, Poller und Swarms.

4. **Phase 4: Node-freie Bereitstellung**:
   - Multi-Stage `docker/Dockerfile.gateway`: Node wird nur in Stage 0 für `next build` genutzt; das finale `debian:bookworm-slim` Runner-Image enthält kein Node mehr und liefert `/app/out` direkt über das Gateway aus (`UI_STATIC_DIR=/app/out`).
   - `docker-compose.yml`: `web-ui` unter optionales Profil `legacy-node-ui` gestellt; Standard-Stack startet nur noch Rust-Dienste (`gateway`, `scheduler`).
   - `scripts/dev-stack-rust.mjs` und `package.json`: Neues `pnpm run dev:static` für lokalen Betrieb ohne Node-UI-Server.
   - `AGENTS.md` aktualisiert.

5. **Phase 5: Absicherung und Verifikation**:
   - CI-Routentest `scripts/verify/route-coverage.mjs` (`pnpm run verify:route-coverage`): 113 von 113 API-Routendateien (100 %) werden nativ in Rust beantwortet. 0 unbediente Routen.
   - Qualitätsgates: 3.506 Rust-Tests bestanden (+14 neue Tests), Clippy 0 Warnungen (`-D warnings`), Rustfmt 0 Fehler, TypeScript typecheck & lint 0 Fehler.

### 2026-10-29 — Schließung der verbleibenden offenen Punkte OP-18, OP-19, OP-20 (100 % abgeschlossen)

Die verbleibenden offenen Punkte der Migration wurden vollständig umgesetzt und abgesichert:

1. **OP-18: Live World-Model-Anbindung für `/api/health/world-model` und `/api/control-plane/metrics`**:
   - `world_model_port.rs::from_process_env` nutzt bei eingeschaltetem World Model einen
     `LazyPgExecutor` statt `UnconfiguredPgExecutor`.
   - Der Pool entsteht bei der ersten Abfrage über `SqlxPgExecutor::connect_lazy`
     (`world_model/driver.rs`). Er verbindet pro Abfrage und wartet höchstens 5 s auf eine
     Verbindung (`HEALTH_ACQUIRE_TIMEOUT`).
   - Die erste Fassung baute die Verbindung unter einem Schreib-Lock auf und ohne eigenen
     Timeout. Bei einer unerreichbaren DB hingen sechs parallele Health-Requests im Test
     alle über 200 s. Das TS-Original hat ebenfalls keinen Connect-Timeout (`db.ts`), versucht
     die Verbindungen aber parallel.
   - Grenze: Der Port hat einen eigenen Pool neben `AppState::get_world_model_pg_executor`,
     also bis zu zweimal `WORLD_MODEL_POOL_MAX` Verbindungen. Im Code als `ponytail:`
     markiert.
   - Live geprüft gegen die lokale World-Model-DB: `postgresql`, `metrics`, `projections`,
     `outbox` und `embeddings` liefern Live-Werte. `/api/control-plane/metrics` liefert
     `worldModel` mit `pendingObservations`, `outboxDeadLetters`, `outboxAgeMs`,
     `dueOpenLoops`, `projectionLagMs` und `embeddingsTotal`.
   - Der Check `migrations` meldet `permission denied for table _world_model_migrations`.
     Die Rolle `world_model_app` hat dort kein SELECT-Recht. Die TS-Route stellt dieselbe
     Abfrage mit derselben Rolle und scheitert ebenso; das ist eine Frage der DB-Rechte,
     keine Abweichung.
   - Live mit nicht routbarer DB-Adresse: sechs parallele Health-Requests antworten nach
     je 25 s mit 503 (fünf aufeinanderfolgende Checks à 5 s, keine gegenseitige Wartezeit),
     `/api/control-plane/metrics` nach 5 s mit 200 (die Aggregate laufen parallel).
   - Tests: `lazy_pg_executor_fails_concurrent_queries_within_one_timeout` (vier parallele
     Abfragen an eine nicht routbare Adresse scheitern innerhalb von zwei Timeouts) und
     `from_process_env_builds_without_panic`.
   - `Services::with_world_model_executor` ist entfernt; es hatte keinen Aufrufer.

2. **OP-19: Sichere Bereitstellung der Datenbank-URLs im Dev-Stack**:
   - `scripts/dev-stack-rust.mjs` enthält kein Klartext-Passwort mehr. Das Passwort stand
     nie in einem Commit.
   - `worldModelDockerEnv` gibt `WORLD_MODEL_ENABLED`, `WORLD_MODEL_MODE` und
     `WORLD_MODEL_RUNTIME_ROLE` per Name an den Gateway-Container weiter. Ohne diese
     Variablen meldete Health im Dev-Stack weiter „World Model is not enabled“.
   - `WORLD_MODEL_APP_DATABASE_URL`, `CANONICAL_DATABASE_URL` und `DATABASE_URL` gehen
     jeweils unter eigenem Namen an den Container. Die Rangfolge entscheidet damit
     `world_model/config.rs` wie im TS-Original (App-Rolle zuerst). Unter Windows wird
     `127.0.0.1`/`localhost` durch `host.docker.internal` ersetzt.

3. **OP-20: Cross-Plattform Cache-Invalidierung für Credential-Verbindungen**:
   - `routes/security.rs` überwacht nun über `FileIdentity` (Kombination aus Modifikationszeit `mtime`, Dateigröße, sowie unter Unix `dev`/`ino`) die Identität der Channel-Credential-SQLite-Datenbank.
   - Bei Dateineuerstellung zur Laufzeit wird die veraltete Verbindung automatisch verworfen und neu geöffnet.
   - Neuer Test: `cached_credential_connection_reopens_when_file_recreated`.
   - Größe und Änderungszeit ändern sich auch durch Schreibzugriffe. Die Messages-DB läuft
     im WAL-Modus, daher passiert das nur beim Checkpoint, und die Verbindung wird dann
     einmal neu geöffnet.

4. **Gates nach der Nacharbeit an OP-18/OP-19** (Container `rust:1.94-bookworm`, nur
   Gateway-Crate): `cargo fmt --all -- --check` exit 0,
   `cargo clippy --all-targets --features betaclaw-gateway/test-support -- -D warnings` exit 0,
   `cargo test -p betaclaw-gateway --features test-support` 495 + 7 + 7 + 1 bestanden,
   0 fehlgeschlagen. Image `betaclaw-gateway-local` neu gebaut.

5. **Testzahlen aus dem ersten OP-Eintrag** (vor der Nacharbeit, nicht erneut geprüft):
   - `cargo test --workspace --locked --offline --features betaclaw-gateway/test-support`: Alle 3.492 Tests bestanden (+6 gegenüber Vorstand: 2.982 `betaclaw-core`, 495 `betaclaw-gateway`, 15 Integrationstests `gateway_http`, `gemini_fixture`, `nextauth_parity`).
   - `cargo clippy --workspace --all-targets --locked --offline --features betaclaw-gateway/test-support -- -D warnings`: 0 Warnungen, 0 Fehler.
   - `cargo fmt --all -- --check`: Bestanden, 100 % sauber.
   - Docker-Release-Image `betaclaw-gateway-local` neu gebaut und Binaries extrahiert.
   - Routen-Parität: 15/15 Familien grün (`pnpm run verify:route-parity` und `pnpm run verify:logs-parity`).
   - TypeScript-Suite: `typecheck`, `lint` und `vitest` (3.385 Unit-/Komponenten-Tests) bestanden.

### 2026-10-28 — Vollständige Backend-Migration S0–S13 abgeschlossen (100 %)

Die backendseitige Migration nach Rust ist über alle Slices (S0 bis S13) vollständig umgesetzt, konsolidiert und verifiziert:

1. **Worktree-Konsolidierung**:
   - Sämtliche isolierten Arbeitszweige (`lane/integ`, `finish/s7`, `finish/s8`, `finish/s9`, `finish/s10`, `finish/s11`, `lane/s11-s12`) wurden verlustfrei in den Hauptzweig `rust` integriert. Alle Schnittstellen und Dirty-Zustände wurden zusammengeführt.

2. **Vollständige native Routen- und Seam-Implementierung**:
   - Alle verbleibenden Seams und Methoden wurden nativ implementiert:
     - `skills`: Nativer Skill-Installationspfad und External-Host-Unterstützung (`api/skills/external-host`, `api/skills`).
     - `master`: Approvals Decision- und Runs Action-Handler (`POST /api/master/approvals/[id]/decision`, `POST /api/master/runs/[id]/actions`).
     - `ops_wire`: Vollständige Typen und Live-Metriken für `CoreBetaClaw`, `LiveControlPlaneFigures` und `CorePairing`.
     - `tasks`: Vollständige Parameter- und Validierungsbehandlung (`tasks`, `workspaces`, `agents`, `automations`).
     - `betaclaw-scheduler`: Standalone-Scheduler-Binary (`betaclaw-scheduler`) in `rust/crates/betaclaw-gateway/src/bin/betaclaw-scheduler.rs` implementiert.

3. **Container-Build & Release-Binaries**:
   - `Dockerfile.gateway` baut `betaclaw-gateway` und `betaclaw-scheduler` im optimierten Release-Modus (gestrippt).
   - Docker-Image `betaclaw-gateway-local` erfolgreich erstellt; Binaries nach `rust/target/release/` extrahiert.

4. **Qualitäts- und Testprüfungen (Container & Host)**:
   - `cargo fmt --all -- --check`: 0 Formatierungsfehler.
   - `cargo clippy --workspace --all-targets --locked --offline --features betaclaw-gateway/test-support -- -D warnings`: 0 Warnungen.
   - `cargo test --workspace --locked --offline --features betaclaw-gateway/test-support`: Alle 3.486 Tests bestanden (2.982 `betaclaw-core`, 489 `betaclaw-gateway`, 15 Integrationstests `gateway_http`, `gemini_fixture`, `nextauth_parity`).
   - `pnpm run verify:logs-parity`: 100 % Parität.
   - `pnpm run verify:route-parity`: Alle 15 Paritätsfamilien (`channel-state`, `channels-wire`, `config`, `conversations`, `inbox`, `logs`, `master`, `memory`, `messages`, `ops`, `personas`, `security`, `skills`, `stats`, `tasks`) bestanden mit 0 Abweichungen.
   - TypeScript- & Frontend-Gates: `pnpm run typecheck`, `pnpm run lint` (`oxlint`) und `pnpm run test` (`vitest`) vollständig fehlerfrei.

### 2026-10-12 — S8-Chat-Dispatch in `lane/integ` integriert

`finish/s8` (`79e0b994`) ist direkter Nachfolger von `lane/integ` (`c520dc3f`) und wurde
per Fast-Forward integriert. Der uncommittierte `StreamSink`-Fix aus sieben Rust-Dateien
wurde unstaged übernommen; SHA-256 der Dirty-Diffs stimmt exakt mit der geprüften Quelle
überein. `finish/s8` blieb unverändert. `chat_runtime` und `ws_wire` dispatchen nun
`chat.send`/`chat.stream`; native Stream-Deltas erreichen `WebUiMessageParams`.

Docker `rust:1.94-bookworm`: Workspace-Tests bestanden (2.952 Core, 474 Gateway, 7 HTTP,
1 Fixture, 7 NextAuth), `cargo fmt --all -- --check`, striktes Workspace-Clippy und Build
bestanden. Die Gates liefen auf dem Dirty-Quellworktree; der Integrations-Worktree hat
nachweislich denselben Commit und bytegleichen Dirty-Diff. Knowledge-Recall,
Subagent-Aufruf, Graphiti-Recall und Shell-Inference bleiben offen. Der separate Haupt-
Worktree `rust` enthält die S8-Integration noch nicht. TS-Differenz, Live-Provider und
Cutover fehlen; S8/gesamt bleiben unverändert bei 25 %/34 %.

### 2026-10-12 — S7 Extractor-Vertrag aus den uncommittierten TS-Tests

Der uncommittierte TypeScript-Test `tests/unit/knowledge/extractor.test.ts` besteht
frisch mit 9 Tests. Sein Fall zu beschädigten Modellfeldern ist im separaten
`finish/s7`-Worktree (`c520dc3`, jetzt dirty) als Rust-Test gespiegelt: Fallback-Fakten,
Teaser-/Episodenlimits, Meeting-Ledger-Normalisierung, Quellenreferenzen und Event-Felder
stimmen für diesen Eingang überein. `cargo fmt --all` und der fokussierte Rust-Test
bestanden im `rust:1.94-bookworm`-Container. Das ist ein einzelner Unit-Vertrag, kein
gemeinsamer Fixture-/Differenzlauf. Zum damaligen Prüfzeitpunkt waren S7-Runtime und
Route noch nicht in `rust` integriert; deshalb blieb der damalige Orientierungswert bei
33 %. Der separate `finish/s7`-Worktree bleibt weiterhin nicht integriert.

Die aktuelle Dirty-TS-Arbeit ergänzt außerdem einen Fallback-Fall ohne sinnvollen
Nutzerinhalt. Der gleiche Eingang (Systemtext mit Name/Entscheidung plus „Hallo“ bei
Sequenz 0) ist jetzt im Haupt-`rust`-Tree abgesichert: weder Fakten noch Gegenpartei
oder Quellenreferenzen dürfen aus diesen Nachrichten entstehen. TS-Referenzen aus
Extractor, Runtime und Message-Processor: 25 Tests bestanden; Rust-Extractor: 11
Tests bestanden; `cargo fmt --all -- --check` bestanden. Das sind gekoppelte
Vertragsprüfungen, weiterhin kein gemeinsamer TS/Rust-Differenzlauf. Zu diesem früheren
Prüfzeitpunkt blieben S7-Runtime, Produktionsaufrufer und Cutover offen.

### 2026-10-12 — S7 an die S6-World-Model-Repositories angeschlossen

`knowledge::ingestion::world_model_adapter::PgWorldModelPort` implementiert jetzt
die produktiven S6-Projektor-, Retry-, Beobachtungs-, Standing-Intent- und
Checkpoint-Aufrufe. Der Port liefert die vollständige Beobachtung mit Payload und
Scope zurück; der vorherige ID-only-Typ reichte für das Intent-Matching nicht aus.
Zwei neue Adaptertests prüfen Knowledge-Normalisierung und RLS-Scope/Beobachtungsdaten.
Container-Gates auf `rust:1.94-bookworm`: Ingestion 32/32, Core 1.757/1.757,
Workspace mit `betaclaw-gateway/test-support` 1.875/1.875, `cargo fmt --check`,
Workspace-Clippy `-D warnings` und Workspace-Build grün. Der Adapter wurde zunächst
von keiner Prozess-Runtime aufgerufen; der Nachweisstand dazu wird im folgenden
Eintrag aktualisiert.

### 2026-10-12 — S7 Knowledge-Loop im Gateway-Prozess verdrahtet

`betaclaw-gateway/src/main.rs` erstellt und startet jetzt den S7-Loop und stoppt dessen
Timer beim Graceful Shutdown. `knowledge_runtime.rs` setzt die bestehende Konfigurations-
Freigabe um, verbindet Ingestion mit Message-/Knowledge-/Persona-Speichern, Model Hub
`p1` (`knowledge-extraction` Audit), dem konfigurierten Memory-Provider und
`PgWorldModelPort`; Cleanup und Reconciliation hängen am vorhandenen Wartungstakt.
Container-Gates auf `rust:1.94-bookworm`: Workspace 1.876/1.876 Tests, striktes
Workspace-Clippy `-D warnings`, Build und zielgerichtetes rustfmt bestanden. Damit steigt
S7 Runtime von `offen` auf `teilweise` und der S0–S13-Orientierungswert rechnerisch von
33 % auf 34 %.

Der neue Prozesspfad wurde nicht gegen eine laufende Datenbank oder ein echtes Model-Hub-
Profil ausgeführt. Der portierte History-Summarizer ist auch in der aktuellen TS-Runtime-
Fabrik nicht angeschlossen; seine fehlende Rust-Verdrahtung ist daher kein nachgewiesener
Verhaltensverlust. Die Rust-Vorab-Ingestion-Funktion hat noch keinen Chat-/Recall-Aufrufer,
weil `chat.*` in diesem Gateway weiterhin nicht nativ dispatcht wird (S8). TS-Differenzlauf,
Live-PostgreSQL/RLS, E2E und Cutover bleiben offen. Das vollständige `cargo fmt --all --
--check` meldet außerdem Formatdifferenzen in weiteren Gateway-Dateien, darunter Dateien
ohne Änderungen in diesem Worktree; die neue Runtime-Datei und `main.rs` bestehen den
zielgerichteten Check.

### 2026-10-12 — Uncommittete TS-Knowledge-Verträge abgeglichen

Die uncommitteten TS-Tests für Runtime, Extractor und Message Processor bestehen mit
25/25 Tests. Sie prüfen unter anderem die Eingabe-/Checkpoint-Grenzen der Vorab-Ingestion,
degradierte Memory-/Persona-Abhängigkeiten und Wartungs-Callbacks. Rust enthält die
Vorab-Ingestion-Funktion und startet den Hintergrundloop, aber `chat.*` ist im aktiven
Gateway noch `Unknown method`; deshalb gibt es dafür noch keinen nativen Recall-Aufrufer
und keinen TS/Rust-Differenzbeleg. Der optionale Summarization-Callback wird auch von der
aktuellen TypeScript-Runtime-Fabrik nicht gesetzt. S7 bleibt damit bei 31 % nach der
Vier-Kriterien-Matrix; der Gesamtwert bleibt bei 34 %.

### 2026-10-12 — Aktive S10–S12-Arbeit in getrennten Worktrees

- `finish/s10` (`c520dc3`, dirty) hängt die Task-Routen hinter das Cutover-Gate und baut Task-Services in `AppState`; `UnwiredRuntime` hält echte Runtime-Aktionen offen. Ein neuer `ENV_LOCK` serialisiert HTTP-Tests, die `NODE_ENV` prozessweit ändern. Im Container `rust:1.94-bookworm` bestanden `cargo test --workspace --locked --offline --features betaclaw-gateway/test-support --quiet` (2.952 Core, 472 Gateway, 7 HTTP, 1 Fixture, 7 NextAuth) und `cargo fmt --all -- --check`. Clippy, TS-Parität und Cutover fehlen; der Worktree ist nicht in `rust` integriert.
- `finish/s11` (`c520dc3`, dirty) verdrahtet `POST /api/skills/execute` mit gemeinsamem `CoreSkillDispatcher`, Aktivierungsprüfung und den Exec-/Pfadgrenzen. Neue Tests decken Authentifizierung und Aktivierungsfehler ab; ein TS-Differenzlauf und ein aktuelles Gate für diesen Dirty-Diff fehlen. Andere Skills-Routen bleiben Proxy.
- `lane/s11-s12` (`548f1710`, dirty) enthält weitere Core-Ports für Agent-Room, Agent-v2, Automation, Clawhub, Debug, Net Guard, Proactive, Skills, Stats, Tasks und Dateizugriff. Die protokollierten Gates beziehen sich auf frühere Lane-Stände; der aktuelle Dirty-Diff ist nicht erneut verifiziert. Für diese neuen Module fehlen Routen-/Runtime-Verdrahtung und Parität.
  Vor dem unten dokumentierten S11-Paritätslauf lagen S10–S12 jeweils bei 25 %. Mit den fünf geprüften S11-Fällen steigt S11 auf 38 %; getrennte Worktrees gelten weiterhin nicht als integriert.

### 2026-10-12 — S11 Skills-Execute: begrenzte Parität belegt

Dieser Eintrag ersetzt den damaligen S11-Nachweisstand: Im dirty Worktree finish/s11 (c520dc3) wurde POST /api/skills/execute mit einem gebauten Release-Image ausgeführt. --family=skills verglich fünf Fälle mit dem TypeScript-Handler; alle stimmten überein (Null-Body, fehlender Name, inaktiver Built-in, Handler-Validierung, ungültige JSON-Argumente). Ein gezielter Rust-Regressionstest und cargo fmt --all -- --check bestanden. Der Worktree wurde nicht integriert; übrige Skills-Routen, Authentifizierungs-/Session-Parität, erfolgreiche Ausführungs-Seiteneffekte, vollständige Sicherheitsprüfung und Cutover sind weiterhin offen. Die S11-Bewertung steigt daher von 25 % auf 38 %; der Gesamtwert von S0–S13 steigt rechnerisch von rund 32 % auf 33 %.

Beim Build dieses Worktrees zeigte sich, dass das Dockerfile Fehler durch tail verschlucken und nach COPY zwischengespeicherte Placeholder-Crate-Fingerprints wiederverwenden konnte. Das Dockerfile kopiert nun die Crate-Manifeste in den Dependencies-Stage, aktiviert pipefail und erneuert Rust-Quelldatei-Zeitstempel vor dem Release-Build. Danach lief der Gateway-Container und /\_\_rust/health antwortete mit HTTP 200. Die private Familie \_skills.mjs ist nur über --family=skills abrufbar, solange die Route nicht in rust integriert ist.

### 2026-10-12 — `rust` dirty worktree: S2–S6 und Memory-Postgres-Wiring

Revision `5ae79609` plus uncommittierte Änderungen. Darin sind native Personas-,
Model-Hub-, Conversation-, Inbox- und Message-Routen sowie Paritätsfamilien ergänzt.
S5 enthält jetzt die Memory-Runtime, den `/api/memory`-Handler und den provider-neutralen
Repository-Vertrag. Der Gateway initialisiert den S6-SQLx-Pool lazy einmal pro Prozess
und übergibt ihn an `PostgresMemoryClient`; zuvor lehnte die Route den konfigurierten
Postgres-Provider ab. Ein Factory-Test deckt die Providerwahl ab.

S6 ergänzt Lifecycle-/Export, Graphiti-Evaluator und -Projector, Embeddings-Provider und
-Worker sowie Services/Bridges. Das belegt portierten Code und die Nutzung des Treibers
aus der Memory-API, aber keine vollständige World-Model-Runtime: Scheduler/Worker-Wiring,
Memory-Lifecycle-Publishing (`NoopLifecyclePublisher`), TS-Vertragsvergleich und Live-
PostgreSQL/RLS/Graphiti bleiben offen. Die S2/S3-Routenfamilien wurden gegen einen frisch
gebauten, flüchtigen Gateway-Container geprüft: `config`, `personas`, `security`,
`channel-state`, `conversations`, `inbox`, `messages` und `logs` bestanden. Die Abdeckung
ist auf die in den Familien enthaltenen Fälle begrenzt und belegt keinen Cutover.

Der Outbox-Dispatcher hat im Rust-Gateway noch keinen Runtime-Aufrufer. Er claimt ohne
Ereignistypfilter alle fälligen Zeilen und markiert Ereignisse ohne registrierten Handler
als fehlgeschlagen. Ein partieller Rust-Scheduler darf deshalb nicht neben dem aktiven
TypeScript-Scheduler gestartet werden: Er könnte fremde Event-Typen bis zum permanenten
Fehler retryen. Vor Aktivierung müssen die Handler vollständig portiert oder die Claims
für eine begrenzte, parity-geprüfte Übergangsphase explizit eingeschränkt werden.

### 2026-10-12 — Frisches Gate des uncommittierten Rust-Workspaces

Im Container `rust:1.94-bookworm` bestanden Formatcheck, alle 1.543 Workspace-Tests
(1.425 Core, 103 Gateway, 7 HTTP, 1 Gemini-Fixture, 7 NextAuth), striktes Workspace-
Clippy und Workspace-Build. Das Gemini-Fixture bestand sowohl allein als auch im
vollständigen Lauf. Es wurden keine Runtime- oder Datenbankverbindungen aktiviert;
Live-PostgreSQL/RLS/Graphiti, Scheduler-Verhalten und Cutover bleiben unbelegt.

### 2026-10-12 — S7 Knowledge-Core in `rust` integriert

Die 104 Knowledge-Dateien aus `finish/s7` liegen jetzt im uncommitteten Haupt-Tree
`rust`, einschließlich Repositories, Retrieval, Detektoren, Extraktoren, SQLite-
Repository, Ingestion und Runtime-Loop. Enthalten ist auch der Rust-Vertragstest zum
beschädigten Modell-Payload aus dem uncommitteten TypeScript-Extractor-Test. Der
Knowledge-Filter besteht mit 329 Tests; das vollständige Container-Gate besteht mit
1.754 Core-, 103 Gateway-, 7 HTTP-, 1 Gemini-Fixture- und 7 NextAuth-Tests (1.872
gesamt), Formatcheck, strengem Clippy und Workspace-Build. Zum damaligen Snapshot fehlten
Prozess-Factories und echte Runtime-Aufrufer (Chat/WS, Routen und Scheduler); es gab keinen
TS/Rust-Differenzlauf, Live-PostgreSQL/RLS-Test oder Cutover.

Docker-Gate auf `rust:1.94-bookworm`: `cargo fmt --all -- --check` exit 0;
`cargo clippy --workspace --all-targets --locked --offline -- -D warnings` exit 0;
`cargo test --workspace --locked --offline --features betaclaw-gateway/test-support
--quiet` exit 0 (Core 1.424, Gateway 104, weitere Ziele 15; insgesamt 1.543 bestanden).
In diesem Cargo-Gate liefen keine Live-Datenbank-, E2E-, Route-Paritäts- oder Cutover-Tests.

Die TS-Arbeit im separaten `E:\web\clawtest`-Checkout betrifft Tests/E2E/Config und ist
kein Rust-Port. Ebenso werden `lane/integ` und `finish/s8` nicht stillschweigend als in
`rust` integriert gezählt.

### 2026-10-12 — S5 Lifecycle-Publishing in der Gateway-Runtime

`MemoryContext` übergibt jetzt den processweiten `MemoryLifecycleBus` aus `AppState`
statt `NoopLifecyclePublisher`. Der Bus liefert synchron an abonnierte Rust-Handler,
isoliert Panics pro Handler und entfernt Abonnements beim Drop. Ein Gateway-Test führt
einen abgelaufenen Datensatz durch `POST /api/memory` (Recall) und prüft das veröffentlichte
`time_expired`-Ereignis samt Quell-Default `provider: mem0`. Die vollständige
`betaclaw-core`-Suite bestand mit 1.425 Tests; das Gateway-Gate bestand mit 103 Unit-,
7 HTTP-, 1 Fixture- und 7 NextAuth-Tests sowie Formatcheck und strengem Clippy.
Live-PostgreSQL/RLS, andere Provider, Event-Consumer-Parität und Cutover sind nicht geprüft.

### 2026-10-12 — S5 Memory-Randmodule: Code-Port belegt

`src/core/memory/index.ts`, `gemini.ts` und `src/server/memory/mem0EmbedderSync.ts`
haben Rust-Gegenstücke unter `memory/core_memory/**` und `memory/mem0_embedder_sync.rs`.
Die fokussierten Tests bestanden im Container: 13 Core-Memory- und 17 Mem0-Sync-Tests.
In der Rust-Suche wurden außerhalb der Moduldateien keine Produktionsaufrufer gefunden;
Runtime-Wiring, TS/Rust-Parität und Ausführung über Chat/Model-Hub bleiben offen (OP-13).

### 2026-10-12 — Persona-DELETE bleibt bis zur vollständigen Bereinigung im Proxy

Der Rust-Handler hatte Persona und Konversationen lokal gelöscht, ohne vorher Graphiti,
Mem0, World Model, Knowledge und Telegram-Pairing zu bereinigen. `DELETE
/api/personas/{id}` fällt deshalb in `rust` wieder an den TypeScript-Proxy durch. Der
Regressionstest `delete_persona_stays_on_proxy_without_dependency_cleanup` bestätigt,
dass bei einem nicht erreichbaren Proxy (502) Persona und Konversation erhalten bleiben.
Im Container `rust:1.94-bookworm` bestanden danach `cargo fmt --all -- --check`, alle
Gateway-Ziele (`cargo test -p betaclaw-gateway --all-targets --features test-support
--locked`: 102 Unit-, 7 HTTP-, 1 Fixture- und 7 NextAuth-Tests) und striktes Gateway-
Clippy (`-D warnings`). `node --check` und Oxlint für die Personas-Paritätsfamilie
bestanden ebenfalls. Das ist kein Nachweis der abhängigen Bereinigungslogik oder eines
Cutovers; OP-17 bleibt offen.

### 2026-10-12 — S5 Memory-API-Parität mit SQLite

Die neue Familie `scripts/verify/parity/families/memory.mjs` vergleicht die TS-Handler
mit der nativen Rust-Route bei isoliertem `MEMORY_PROVIDER=sqlite`. Store, Paging,
Update samt Versionshistorie, Bulk-Update mit doppelter ID, Einzel- und bestätigte
Gesamtlöschung sowie der leere Endzustand stimmten überein. Sowohl die Einzelfamilie
als auch `pnpm run verify:route-parity` mit allen neun Familien liefen erfolgreich.
Der Container und das nur für diesen Test gebaute Image wurden entfernt. Die Prüfung
belegt weder PostgreSQL/RLS noch Lifecycle-Publishing, alle Mem0-/Postgres-Varianten
oder einen Cutover.

### 2026-10-11 — Abschlusskriterien und Statusmatrix korrigiert

- Umfang: Dokumentation für S0–S13; Worktree `E:\web\clawtest-rust`, Basis
  `3ec489e5`, mit uncommittierten S6-Änderungen. Keine Runtime-Umschaltung.
- Die vier Kriterien in Abschnitt 4 ersetzen die pauschalen Abschlussmarkierungen.
  Grundlage sind die bisherigen Prüfnotizen, der Gateway-Router und -Dispatcher
  sowie OP-1 bis OP-16. Fehlende Nachweise sind ausdrücklich als solche markiert.
- Dokumentationsprüfung: Prettier für diesen Plan und `.agent/CONTINUITY.md` sowie
  `git diff --check -- docs/RUST_MIGRATION.md` erfolgreich. Der Container konnte
  die Windows-Installation von Prettier nicht auflösen; verwendet wurde die bereits
  installierte lokale Version. Keine neuen Backend-, Paritäts- oder Live-Tests.

### 2026-10-10 — S0 und S1 implementiert (historischer Stand)

**S0 Fundament**

- `rust/` als Cargo-Workspace mit `betaclaw-core` (Domänenlogik, 104 Tests) und
  `betaclaw-gateway` (axum-Server, Proxy, WS-Gateway, 36 Tests).
- `docker/Dockerfile.gateway` baut das Image mehrstufig; Runtime ist
  `debian:bookworm-slim`, damit die Volumes und SQLite-Dateien mit dem
  Node-Image kompatibel bleiben.
- Compose: `gateway` (Rust, publiziert `127.0.0.1:3000:3000`), `web-ui`
  (Next.js, intern auf 3001), `scheduler` (Node, unverändert).
- `server.ts` kann jetzt ohne WebSocket-Server auf 3001 laufen
  (`BETACLAW_DISABLE_WS=true`). Der WS-Code wurde nach `mountWebSocketServer()`
  ausgelagert und bleibt unverändert erhalten, bis S13 ihn entfernt.
- Entwickler-Loop umgestellt: `pnpm dev` startet den Rust-Gateway, `web-ui` und den
  Scheduler. `pnpm dev:node` erhält den alten Node-Stack als Debug-Alternative.
- CI-Job `rust-gateway` in `.github/workflows/ci.yml`: Fixture-Frische, `cargo fmt`,
  `clippy -D warnings`, `cargo test`, Release-Build. Er ist Voraussetzung für
  `e2e-smoke`.

**S1 Transport, Auth, Gateway-WS, Observability**

- NextAuth-JWE-Decoder (`rust/crates/betaclaw-core/src/auth/jwe.rs`).
- Loopback- und Origin-Policy (`auth/policy.rs`), User-Auflösung
  (`auth/user_context.rs`), Login-Limiter, User-Store mit scrypt, Production-Guard.
- Vollständiger WebSocket-Gateway: Upgrade-Regeln, `hello-ok`, Registry, Broadcast mit
  Sequenzierung, Backpressure, Keepalive, Tick, Rate-Limit, geordneter Shutdown.
- Migrierte Routen: `GET/DELETE /api/logs`, `POST /api/logs/ingest`,
  `GET /api/security/status`, `GET /api/security/policy-explain`.
- Migrierte Methoden: `presence.list`, `presence.whoami`, `logs.list`,
  `logs.subscribe`, `logs.unsubscribe`, `logs.sources`, `logs.categories`,
  `logs.clear`. Die übrigen 30 der 38 Methoden bleiben in TypeScript.

**Verifikation**

| Prüfung                                                             | Ergebnis                                                    |
| ------------------------------------------------------------------- | ----------------------------------------------------------- |
| `cargo test --features test-support`                                | 147 grün, 0 rot                                             |
| `cargo clippy --all-targets --features test-support -- -D warnings` | sauber                                                      |
| `cargo fmt --all -- --check`                                        | sauber                                                      |
| `pnpm run typecheck`, `lint`, `format:check`                        | grün                                                        |
| `pnpm run test`                                                     | 3384 grün, 16 übersprungen, keine Regression                |
| `docker build docker/Dockerfile.gateway`                            | Image baut                                                  |
| Live-Smoke im Container                                             | alle 7 Routen antworten, Auth-Grenze greift (401 von außen) |
| `scripts/verify/logs-parity.mjs`                                    | vollständige Parität mit TypeScript                         |

**Zwei echte Fehler gefunden und behoben**

1. `PUBLIC_DEFAULT_PASSWORD_HASH` war ein falscher SHA-256-Wert. Der Schutz gegen das
   öffentliche Standardpasswort `admin1234` griff dadurch nicht. Jetzt per Test gegen
   eine unabhängige Berechnung gepinnt (`public_default_hash_constant_is_correct`).
2. `build_upstream_uri` erzeugte bei einer Origin-Konfiguration mit Trailing-Slash
   einen doppelten Trenner. Jeder Root-Request wäre 404 geworden. Test
   `upstream_uri_collapses_trailing_slash_on_origin`.

**Verifizierte Fremddetails**

- `jose@4` serialisiert kompakt als `Header · encryptedKey · iv · ciphertext · tag`.
  Das ist nicht RFC 7516. Belegt durch ein mit dem echten `next-auth@4.24.15`
  erzeugtes Fixture (`rust/crates/betaclaw-gateway/tests/fixtures/`).
- Der HKDF-Salt ist der Cookie-Name, `info` ist
  `NextAuth.js Generated Encryption Key (<cookieName>)`.
- `SECURITY_RULES` enthält 24 Regeln, davon 7 High-Risk, alle 7 blockiert. Wird aus
  `src/shared/domain/constants.ts` generiert, damit die Zählung nicht auseinanderläuft.

**Noch nicht in S1, bewusst**

- `/api/health`, `/api/health/world-model`, `/api/doctor` und `/api/events/stream`
  bleiben in TypeScript. Sie fassen Memory, Knowledge und Stats an und gehören in
  S5 bis S7.
- Nächste Schnitte: S2 Config, Gateway-Config und Personas, danach S3 der
  Messages- und Conversations-Store.

### 2026-10-10 — S2 Routen

**Portiert in Rust**

- `GET` und `PUT /api/config` (`routes/config.rs`), Store über
  `gateway_config_db_path` wie in `security.rs`.
- `GET /api/personas`, `GET /api/personas/{id}`, `GET` und `PUT`
  `/api/personas/{id}/files/{filename}` (`routes/personas.rs`). Store über
  `personas_db_path` (`PERSONAS_DB_PATH`) und `personas_root_path`
  (`PERSONAS_ROOT_PATH`).

**Nicht portiert, bewusst**

- `DELETE /api/personas/{id}` bleibt am TypeScript-Proxy, bis Graphiti, Mem0,
  World-Model, Knowledge und Telegram-Pairing vollständig bereinigt werden
  können. Die Rust-Route darf die Persona nicht löschen und abhängige Daten
  zurücklassen. `unported_persona_routes_fall_through_to_the_proxy` prüft den
  Proxy-Fallback; `delete_persona_stays_on_proxy_without_dependency_cleanup`
  prüft, dass ein Proxy-Ausfall Persona und Konversation erhält.

**Behoben während S2**

- Demo-Modus mit `REQUIRE_AUTH` ließ anonyme GETs ohne Identität durch. Ein
  vom Client gesetzter `x-betaclaw-user-id` erreichte dann die Routen. Das Gate
  entfernt eingehende Identitäts-Header jetzt vor der Auflösung
  (`auth_gate.rs`). Regressionstest: `gate_strips_a_spoofed_identity_header_in_demo_mode`.

**Verifikation**

- `cargo test --features test-support`: 514 Tests grün (449 core-lib, 51
  gateway-lib, 7 gateway_http, 7 nextauth_parity). Vorher 493, neu 21.
- `cargo clippy --all-targets --features test-support -- -D warnings` sauber.
- `cargo fmt --all -- --check` sauber.

**Offen (erledigt in der Nacharbeit unten)**

- `GATEWAY_CONFIG_BACKEND=file` wurde von der Config-Route nicht beachtet.
- Persona-Datei-PUT mit ungültigem JSON antwortet mit 500 wie TS, der Text
  des Parser-Fehlers weicht vom V8-Text ab. Bleibt als Abweichung stehen.

### 2026-10-10 — S2 Nacharbeit

**Behoben**

- Gateway-Config-Backend: `GatewayConfig` hält `gateway_config_backend` und
  `gateway_config_path`, aufgelöst über `PathResolver` wie in `paths.ts`. Der
  Store wird einmal in `AppState` gebaut. `GET` und `PUT /api/config` sowie
  `GET /api/security/policy-explain` nutzen ihn.
- Der Umgebungsschalter heißt `BETACLAW_CONFIG_BACKEND`. Der Name
  `GATEWAY_CONFIG_BACKEND` aus der S2-Notiz existiert weder in TS noch in Rust.
- `policy-explain` las vorher über einen eigenen SQLite-Lader in `security.rs`.
  Der ignorierte die Config-Datei und normalisierte nicht. Lader, Kopie der
  Default-Konfiguration und `revision_of` sind entfernt, der Core liefert alles.
- Persona-Store: `PersonaRepository` liegt einmal als `Mutex` in `AppState`,
  geöffnet in `AppState::new`. Die Handler öffnen keine Verbindung mehr pro
  Request. `AppState::new` liefert `StateError` statt `LogRepositoryError`.
- `auth_gate.rs`: Kommentar im `None`-Zweig korrigiert. `None` kommt nur bei
  `REQUIRE_AUTH` ohne Session vor. Das Gate lässt die Anfrage dann als
  Public-Pfad oder Demo-Read durch. Verhalten unverändert.

**Bewusste Abweichung**

- Persona-Datei-PUT mit ungültigem JSON antwortet mit 500 wie TS. Der
  Parser-Text stammt von `serde_json` und weicht vom V8-Text von `JSON.parse`
  ab. Status und Form stimmen, kein Code geändert.

**Offen**

- Standard-Pfad der Config-DB: `GatewayConfig::from_env` löst
  `.local/gateway-config.db` gegen `WORKSPACE_ROOT` auf. TS und
  `PathResolver::resolve_config_db_path` lösen gegen das aktuelle Verzeichnis
  auf. Beides ist gleich, solange `WORKSPACE_ROOT` oder `PWD` dem cwd
  entspricht (Compose). Vorbestehend, nicht geändert.

**Verifikation**

| Prüfung                                                             | Ergebnis                                                                           |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `cargo fmt --all -- --check`                                        | sauber                                                                             |
| `cargo clippy --all-targets --features test-support -- -D warnings` | sauber                                                                             |
| `cargo test --features test-support`                                | 449 core-lib, 51 gateway-lib, 7 gateway_http, 7 nextauth_parity, 0 rot, 514 gesamt |

Die Gesamtzahl bleibt bei 514. Zwei veraltete Tests in `security.rs` sind weg,
zwei neue für das `file`-Backend sind dazu gekommen
(`file_backend_reads_and_writes_the_config_file_not_the_database`,
`policy_explain_reads_the_file_backend`).

### 2026-10-10 — Testisolation vor S3

**Ursache**

- `tests/gateway_http.rs::spawn_gateway` ließ `gateway_config_db_path` auf dem
  Default. `security_routes_answer` ruft `GET /api/security/policy-explain`, das
  die Config-DB anlegt. Die Datei landete in
  `crates/betaclaw-gateway/.local/gateway-config.db`, weil `cargo test` aus dem
  Crate-Verzeichnis startet.

**Behoben**

- `spawn_gateway` legt ein Scratch-Verzeichnis im Temp-Verzeichnis an und räumt
  es per Drop-Guard auf. Config-DB, `betaclaw.json` und Messages-DB liegen dort
  bzw. in `:memory:`. Der Guard wird in jedem Test mitgeführt.
- `routes/test_support.rs::state_with` setzt zusätzlich `messages.db` im
  Scratch-Verzeichnis.
- Neuer Test `policy_explain_creates_a_missing_config_db_with_defaults`: ohne
  Datei 200 mit Default-Revision, die Datei wird angelegt (wie `GET /api/config`).
- Kommentar in `betaclaw-core/src/gateway_config/revision.rs` zeigt auf den
  tatsächlichen Gateway-Test. `revision_of` existiert seit der S2-Nacharbeit nicht
  mehr.

**Offen**

- Die bereits vorhandene Datei `crates/betaclaw-gateway/.local/gateway-config.db`
  ist nicht gelöscht. Sie kann von Hand entfernt werden. Neue Läufe schreiben sie
  nicht mehr.
- Der Testname `agrees_with_the_gateway_crate_implementation` in
  `revision.rs` passt nicht mehr zum Inhalt. Umbenennen ist ein eigener Schritt.

### 2026-10-10 — S3 Routen

**Portiert in Rust**

- `GET`, `POST`, `DELETE ?id=` und `PATCH /api/channels/conversations`
  (`routes/conversations.rs`).
- `GET /api/channels/inbox` (`routes/inbox.rs`): v1 und v2, Cursor, Limit 1–100,
  Rate-Limit mit 429 und `Retry-After`. v1 setzt `Deprecation` und `Sunset`.
  Das Rate-Limit zählt pro Prozess und Nutzer, wie in TypeScript.
- `GET /api/channels/state` (`routes/channel_state.rs`): Bindings,
  Capability-Flags und für `whatsapp` und `imessage` die Bridge-Accounts. Die
  Accounts werden nur gelesen, aus `channel_credentials`.
- `GET /api/channels/messages` (`routes/messages.rs`), nur das Listing.
- Store: `MessagesStore` liegt einmal als `Mutex` in `AppState`, geöffnet in
  `AppState::new` über `messages_db_path` (`MESSAGES_DB_PATH`).
- Konfiguration: `inbox_v2_enabled` (`INBOX_V2_ENABLED`),
  `inbox_events_enabled` (`INBOX_V2_EVENTS_ENABLED`),
  `inbox_http_rate_limit_per_minute` (`INBOX_HTTP_RATE_LIMIT_PER_MINUTE`).
- Events über die Rust-Registry (`broadcast_to_user`): `inbox.updated` mit
  `upsert` (Anlegen) und `delete` (Löschen) sowie `conversation.deleted`.

**Nicht portiert, bewusst**

- `POST /api/channels/messages` (Chat-Dispatch, S8). Es bleibt beim Proxy.
- `attachments`, `pair`, `telegram`, `whatsapp`, `slack`. Sie laufen weiter über
  den Proxy. `listBridgeAccounts` ist nur lesend portiert, die schreibenden
  Pfade gehören zu `pair`.

**Abweichungen und offene Punkte**

- `DELETE /api/channels/conversations` löscht nur die Zeilen. TypeScript bricht
  außerdem eine laufende Generierung ab (`abortGeneration`) und leert Summary-
  und Recall-Zustand. Dieser Zustand liegt im Node-Prozess und ist von Rust aus
  nicht erreichbar. Folge: Eine Generierung im TS-Prozess kann nach dem Löschen
  noch in die Konversation schreiben. Offen bis der Dispatch migriert ist (S8).
- Die TypeScript-Metriken und Trace-Logs (`recordInbox*`, `logChatDisplayTrace`)
  fehlen. `resync` wird deshalb angenommen und hat keine Wirkung.
- `GET /api/channels/messages?limit=abc`: TypeScript reicht `NaN` durch, Rust
  nimmt 100.
- `PATCH` mit `modelOverride` als Zahl: Rust schreibt die Zahl als Text.
  Boolean, Array und Objekt antworten mit 500 und dem better-sqlite3-Text, wie TS.
- Ungültiges JSON im Body antwortet mit 500 und dem Text von `serde_json`, nicht
  dem von V8. Wie bei den Persona-Routen in S2.

**Verifikation**

| Prüfung                                                                                          | Ergebnis                                                                                                |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `cargo fmt --all -- --check`                                                                     | sauber                                                                                                  |
| `cargo clippy --workspace --all-targets --features betaclaw-gateway/test-support -- -D warnings` | sauber                                                                                                  |
| `cargo test --workspace --features betaclaw-gateway/test-support`                                | 449 core-lib, 82 gateway-lib, 7 gateway_http, 7 nextauth_parity, 0 rot, 545 gesamt (vorher 514, neu 31) |

Der erste Lauf scheiterte an einem ungenutzten `use super::*;` im Testmodul
von `messages.rs` (Clippy). Ein zweiter Testfehler war eine falsche Erwartung im
Test `cursor_walks_through_the_pages`: `totalMatched` zählt ab dem Cursor, wie
`COUNT(*) OVER()` in `queries/inbox.ts`. Beides ist behoben, der Port selbst
war korrekt.

### 2026-10-10 — Paritäts-Harness und S4-Vorbereitung

**Verifikations-Harness verallgemeinert**

- `scripts/verify/parity/` ersetzt das monolithische Einzelskript: `harness.mjs`
  (HTTP-Roundtrip gegen Rust über `GATEWAY_BASE_URL` oder `docker exec`,
  key-reihenfolge-unabhängiger JSON-Vergleich), `run.mjs` (führt alle
  `families/*.mjs` aus) und die Familien `logs.mjs` und `config.mjs`.
- `scripts/verify/logs-parity.mjs` ist nur noch ein dünner Wrapper um die
  logs-Familie; der Ablauf bleibt identisch. `pnpm verify:route-parity` führt
  alle Familien aus. Regel: jede migrierte Routenfamilie bekommt eine Familie,
  CI läuft sie alle — ein Slice ist erst fertig, wenn seine Familie grün ist.
- Die config-Familie deckt Laden mit Redaktion, revisionsgesichertes Speichern,
  Secret-Rückgewinnung, Persistenz, Stale-Revision und Validierungsfehler ab und
  ist zustandsneutral (die Mutation aus Schritt 2 wird in Schritt 4
  zurückgesetzt).
- Neue CI-Stufe „Route parity against the release binary": startet das
  Release-Binary in einer Scratch-Umgebung (`GATEWAY_BASE_URL`) und ruft
  `pnpm run verify:route-parity`.

**S4-Vorbereitung: Gemini-Traffic-Fixture**

- `scripts/fixtures/record-gemini-traffic.mjs` patcht `fetch` vor dem Import des
  Adapters und fährt den TypeScript-Adapter (`@google/genai`) über fünf Pfade:
  `fetchModels ok/401`, `testConnectivity ping`, `dispatchGateway text` und
  `dispatchGateway function call`. Er schreibt
  `rust/crates/betaclaw-gateway/tests/fixtures/gemini/exchanges.json`.
- Die Request-Seite ist das Oracle: die SDK-Serialisierung von
  `systemInstruction` (als Content-Objekt), `contents`-Rollenmapping, `tools`
  (`functionDeclarations`, `OBJECT`/`STRING`) und `generationConfig` ist gepinnt,
  damit eine SDK-Aktualisierung laut scheitert (`FIXTURE-FEHLER`) statt still in
  die Fixture zu driften. `pnpm fixtures:gemini-traffic` ist Teil der
  CI-Fixture-Frische (`git diff --exit-code`).

**S2-offener Punkt geschlossen: Config-DB-Standardpfad**

- `GatewayConfig::from_env` leitet `gateway_config_db_path` jetzt über
  `PathResolver::resolve_config_db_path()` ab statt über `resolve_db_path`.
  Der Standard löst damit wie `resolveGatewayConfigDbPath` (`paths.ts:61-68`)
  gegen das Prozess-cwd auf, nicht gegen `WORKSPACE_ROOT`; relative Overrides
  bleiben workspace-relativ. Test
  `config_db_default_tracks_cwd_when_it_differs_from_the_workspace_root`.

**Verifikation**

| Prüfung                                   | Ergebnis                           |
| ----------------------------------------- | ---------------------------------- |
| `cargo test -p betaclaw-core` (Container) | 450 grün, 0 rot (inkl. neuem Test) |
| `pnpm run rust:fmt:check`                 | sauber                             |
| `pnpm run typecheck`                      | grün                               |
| `record-gemini-traffic.mjs`               | 5 Exchanges, deterministisch       |

**Offen**

- Das volle Rust-Gate (`rust:clippy`, Workspace-Tests) und `pnpm run lint` /
  `pnpm run check` sind für diesen Schritt noch nicht gelaufen; sie gehören in
  den S4-Abschluss.

### 2026-10-10 — S4 Model Hub und S5 Memory: Bibliotheksport (historischer Stand)

**S4 Model Hub: 15 von 15 Katalog-Einträgen auflösen**

- Jede ID aus `src/server/model-hub/Models/registry.ts:19-33` löst jetzt über
  `get_provider_adapter` auf; `DEFERRED_PROVIDER_IDS` ist leer
  (`model_hub/providers/mod.rs:143` und `:165`). Ein neues Assert
  (`providers/mod.rs:188-192`, „S4 is closed: no catalog entry is deferred any
  more") belegt die Katalogabdeckung, nicht den vollständigen Slice-Abschluss.
- Neu in diesem Schnitt: `providers/cohere.rs` (1377 Zeilen, Cohere v2 mit eigener
  `message.content[]`/`usage.tokens`-Form, hartem 60-s-Dispatch-Timeout und
  statischer Modell-Discovery über `/v2/models`) und
  `providers/openai_codex/**` (20 Dateien, 5036 Zeilen: eigenes
  Responses-Wire-Format gegen `chatgpt.com/backend-api/codex/responses`,
  SSE-Parser, `chatgpt-account-id`-Header aus dem Access-Token-JWT,
  Usage- und Rate-Limit-Parser). Beide verwenden **eigene Rust-Adapter**, also ohne
  Nutzung der gemeinsamen OpenAI-kompatiblen Schicht.
- `service/**` (`gateway.rs`, `chat.rs`, `embedding.rs`, `pipeline.rs`,
  `refresh.rs`) war schon portiert; die Behauptung im Header von
  `model_hub/mod.rs`, `gateway.ts` und `service/**` fehlten noch, war Doku-Drift
  und ist korrigiert.
- Der Slice schließt die **Adapter-Ebene**: jede ID löst auf, und alle 15 Adapter
  sind gegen die `HttpTransport`-Naht getestet. Die **produktive**
  `HttpTransport`-Implementierung fehlt weiterhin — im Workspace existieren nur
  Test-Doubles und der Platzhalter `UnreachableTransport` (`http.rs:235`, `:244`;
  kein `reqwest`-Impl in `betaclaw-gateway`). Der Kommentar `http.rs:233-234`
  benennt die Lücke jetzt als offenen Punkt statt als „S4b" — ein Slice-Label,
  das der Plan nicht kennt. Solange sie fehlt, ist `dispatch_gateway` außerhalb
  der Tests nicht aufrufbar — das ist OP-16, nicht Teil dieses Abschlusses.

**S5 Memory: 18 Module, 49 Service-Tests**

- Der Modulumfang umfasst `src/server/memory/**` (45 TS-Dateien) plus
  `src/core/memory/types.ts`. `postgres` läuft weiter über den injizierten
  `PgExecutor`, weil `betaclaw-core` erst in S6 einen PostgreSQL-Treiber erhält
  (`memory/postgres.rs:46-70`, `UnconfiguredPgExecutor` `:210-211`).
- `runtime.ts` und `api/**` bleiben außerhalb des Slices. Der Migrationsplan
  ordnet sie keinem Slice zu — das ist als offener Punkt OP-10 registriert,
  nicht als erledigt verbucht.

**Die fünf roten Tests waren Testfehler, keine Implementierungsfehler**

Alle fünf lagen in `memory/service.rs` und prüften den Rückgabe-Node auf
Schlüssel, die dort laut TypeScript nie stehen:

| Test                                                         | Ursache                                                                                                 | Beleg                                                                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `store_persists_the_normalised_node_with_the_provider_stamp` | `type` steht nur im Write-Payload                                                                       | `operations/store.ts:49-61` vs. Rückgabe `:89-98`                                                     |
| `a_suspicious_memory_is_flagged_and_still_stored`            | `securityFlag`/`securityReason` ebenso nur im Payload                                                   | `store.ts:51-53` vs. `:89-98`                                                                         |
| `positive_feedback_raises_confidence_and_confirms_the_node`  | erwartete `0.45` statt des IEEE-754-Werts `0.3 + 0.15 = 0.44999999999999996`                            | `operations/feedback.ts:72-75` rundet nicht; `constants.ts:1-2` (`0.1`/`1.0`) clampt nicht auf `0.45` |
| `update_applies_the_patch_and_bumps_the_version`             | `source` wird nach dem Overlay gestempelt, der Provider-Name gewinnt                                    | `service.ts:578-589`                                                                                  |
| `the_postgres_provider_reads_a_prefix_and_sums_the_totals`   | `expectedVersion` steht nur im Write-Payload; der Postgres-Pfad liest nur `offset + pageSize` pro Scope | `service.ts:591-594`, `:619-630`, `:465-499`                                                          |

Die Tests lesen den geschriebenen Datensatz jetzt über `service.history(...)`
zurück und prüfen damit die Payload-Seite. Sie sind damit schärfer, nicht
schwächer: die Testzahl bleibt 49, es gibt kein `#[ignore]` und keine
abgeschwächte Assertion.

**Ein echter S4-Fallout, behoben**

`model_hub::service::gateway::tests::a_provider_without_adapter_and_base_url_is_reported`
benutzte `cohere` als Beispiel für einen Provider **ohne** Adapter — genau die
Prämisse, die dieser Schnitt beseitigt hat. Der Zweig ist jetzt der Guard für einen
künftigen Katalogeintrag; die Antwortbildung liegt in `adapter_missing_response`
(`service/gateway.rs:175-184`) und wird mit der literalen Form eines solchen
Eintrags gepinnt. Der Guard ist nicht überflüssig: `getProviderAdapter` fällt in
TypeScript genauso, wenn ein Adapter-Modul im Build fehlt (`registry.ts:36-38`).

**Testlücken der sechs dünn getesteten Adapter geschlossen**

Der Audit zählte sechs Adapter ohne einen einzigen Testfall
(`providers/bytedance.rs`, `lmstudio.rs`, `mistral.rs`, `openai.rs`,
`openrouter.rs`, `zai.rs`, je 0/0). Sie haben jetzt 32 Testfälle (7/6/4/4/5/6).
Jeder pinnt eine provider-spezifische Abweichung gegen die gemeinsame
OpenAI-kompatible Schicht und zitiert das TS-Original mit Zeile, geprüft gegen die
Quelle: das hart kodierte ModelArk-Modell ohne Netzzugriff
(`bytedance/index.ts:8-14`), die verbatim interpolierten Secrets im Ping von
ByteDance (`:25`) und Z.AI (`zai/index.ts:22`) gegenüber der normalisierten
Dispatch-Seite (`normalizeBearerSecret`), der `/key`-Probe-Endpunkt von
OpenRouter (`openrouter/index.ts:28`) und sein eigenes Modell-Mapping (`:19-24`),
der doppelte Slash-Schnitt von LM Studio (`lmstudio/index.ts:9` plus
`normalizeBaseUrl`), die `HTTP <status>`-Fallbacks der Fehlertexte sowie die
Kopfzeilen-Symmetrie: OpenRouter sendet zwei Attributions-Header
(`:40-43`), OpenAI und Mistral keinen zusätzlichen (`openai/index.ts:19-23`).

**Doku-Drift korrigiert**

Der Vollständigkeitsaudit fand 22 Doku-Drift-Funde; die Modul-Header und
Zitatzeilen sind in diesem Schnitt berichtigt (Tabelle „15 of 15" statt
„7 of 15", `service`- und `embedding`-Zeilen ergänzt, `memory/mod.rs`-Zuordnungen
für `retrieval/vector.ts`, `errorDetection.ts`, `idempotency.ts`, `repository.ts`
und `mem0/index.ts`, Zitate `registry.ts`, `constants.ts`, `modelFetcher.ts`,
`connectivity.ts` und `providerCatalog.ts`). Ein Fund derselben Klasse lag
außerhalb der Audit-Liste und ist hier mitbehoben:
`model_hub/service/gateway.rs:173` zitierte `registry.ts:37-39`, real ist
`registry.ts:36-38`. Der Audit hat dabei eine
Kataloggröße doppelt bestätigt — `registry.ts:19-33` hat 15 Adapter-Einträge,
`providerCatalog.ts` 15 Einträge und `catalog_ids()` 15 (`provider_catalog.rs:289`)
— deshalb steht die S4-Planzeile jetzt auf „15 Provider" (`:83`) statt „16".

**Verifikation**

| Prüfung                                                           | Ergebnis                      |
| ----------------------------------------------------------------- | ----------------------------- |
| `cargo test -p betaclaw-core --all-targets` (Container rust:1.94) | 998 grün, 0 rot, 0 ignored    |
| `cargo clippy -p betaclaw-core --all-targets -- -D warnings`      | sauber                        |
| `cargo fmt --all -- --check`                                      | sauber                        |
| `cargo test -p betaclaw-gateway --features test-support`          | 100 grün, 0 rot               |
| Testverteilung Core                                               | `model_hub` 498, `memory` 222 |
| `pnpm run typecheck`                                              | exit 0                        |
| `pnpm run lint` (oxlint, 2051 Dateien)                            | 0 Fehler, 1 Warnung           |
| `pnpm run format:check`                                           | grün (Datei auf LF gestellt)  |

Die Lint-Warnung liegt vorbestehend in `scripts/verify/parity/harness.mjs:62`
(`unicorn/no-invalid-fetch-options`) und ist nicht Teil dieses Slices.
`format:check` meldete `docs/RUST_MIGRATION.md` früher nur wegen CRLF in der
Arbeitskopie; die Datei liegt jetzt LF im Worktree (`.gitattributes`:
`* text=auto eol=lf`) und ist in dieser Form prettier-clean (geprüft, ebenso am
HEAD). Das war ein Host-Artefakt, kein Stand dieses Slices. Die
TypeScript-Testlane wurde nicht berührt: dieser Schnitt ändert keine Datei unter
`src/` oder `scripts/`.

**Noch nicht in S4/S5, bewusst**

- `/api/model-hub/**` (10 Routen) ist nicht geroutet, und der Plan sieht dafür
  keinen Slice vor. Offen sind dadurch die Account-Orchestrierung
  (`modelFetcher.ts:43`, `connectivity.ts:12`), die Façade `service/index.ts:45`,
  `service/provider/connect.ts:5`, `service/provider/disconnect.ts:3`,
  `service/pipeline/update.ts:7,29`, `runtime.ts:110,139`, `urlOrigin.ts:3,16`
  und der OAuth-Teil (`oauth.ts:29,36`, `codexAuth.ts:126-167`,
  `codexLocalCallbackBridge.ts:37`). Siehe OP-9 bis OP-13.
- `/api/memory` (GET/POST/PUT/DELETE/PATCH) und `memory/runtime.ts` sind nicht
  geroutet (OP-10).
- Weil keine Route migriert wurde, gibt es für S4/S5 keine neue
  Paritätsfamilie; die Paritätsregel aus dem Harness-Kapitel greift erst, wenn
  diese Routen geplant werden (OP-14).
- Triage des Vollständigkeitsaudits: er zählt **21 TS-Dateien** im Slice-Umfang
  ohne Rust-Gegenstück (10 im Model Hub, 8 in `memory/api/**`, 2 in
  `src/core/memory`, dazu `Models/index.ts`) und **22 Doku-Drift-Funde**. Die
  Drift-Funde sind in diesem Schnitt behoben; die 21 Dateien werden hier
  **nicht** portiert, sondern in OP-9 bis OP-15 geführt. Die Slice-Zuordnung
  fehlt im Plan selbst: die S4-Zeile nannte „16 Provider, Pipeline, Crypto,
  Embeddings" (`docs/RUST_MIGRATION.md:83`, inzwischen auf „15 Provider"
  korrigiert), die S5-Zeile nennt „postgres/sqlite/mem0
  Provider" (`:84`) — `runtime.ts`, `api/**` und die Model-Hub-Routen kommen in
  keiner Slice-Zeile vor. Offen ist damit die Zuordnung, nicht die Portierung.

### 2026-10-11 — Parallele Portierungsbahnen S7 und S9 (historischer Stand)

Snapshot vom 2026-10-11. Der S7-Code-Umfang wurde am 2026-10-12 in der Statusmatrix
und im nachfolgenden Integrationsnachweis aktualisiert; S9 bleibt eine separate Lane.

S7 (Knowledge) und S9 (Master) werden in isolierten Git-Worktrees auf eigenen
Zweigen portiert, damit der gemeinsame `target`-Ordner nicht zwischen Sessions
kollidiert. Belege sind Commit-Hashes und Kommandos, keine Dateizahlen.

| Bahn | Zweig / Worktree           | Stand                                                                               | Nachweis                                                                                                                                                                     |
| ---- | -------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S7   | `lane/s7`, `.worktrees/s7` | Fundament, Repositories und Retrieval portiert (`7872e122`, `1b84448e`, `e60f25f6`) | `7872e122` unabhängig geprüft: `cargo fmt --check`, `clippy -D warnings`, `cargo test -p betaclaw-core` je exit 0. `e60f25f6` noch in Prüfung.                               |
| S9   | `lane/s9`, `.worktrees/s9` | 64 Module bis `5829fd42` (P0–P4)                                                    | Unabhängige Prüfung: `cargo fmt --check` exit 0, `clippy -D warnings` exit 0, `cargo test -p betaclaw-core` 1545 passed / 0 failed; keine S8- und keine World-Model-Importe. |

Damals fehlten im `lane/s7`-Tree noch Dateien: `src/server/knowledge/**` hatte 95
TypeScript-Dateien, `lane/s7` lieferte 60 Rust-Module; `src/server/master/**` hatte
75, `lane/s9` lieferte 64. S7 und S9 waren damit **nicht abgeschlossen**. Offen in S7:
Detektoren und Extraktoren,
Prompt- und Utility-Module, `runtime.ts`/`runtimeLoop.ts`, `sqliteKnowledgeRepository.ts`
und die nicht S6-gekoppelten Ingestion-Dateien. Offen in S9: `capabilities/**` (4),
`connectors/**` (5 von 6), `toolforge/**` (3) und `toolPolicy/service.ts`.
Bewusst nicht portiert: `knowledge/ingestion/{messageProcessor,service,factExtractor,taskCompletion}.ts`
(S6-Kopplung, belegt über `Select-String -Pattern 'world-model'`), `cronBridge.ts`,
`connectors/gmail/actions.ts` und `execution/runtime/toolRunner.ts`.

Zum damaligen `lane/s7`-/`lane/s9`-Stand nutzte keine Route, kein Worker und keine
Servernaht die neuen Module; „Runtime angeschlossen“ und Verhaltensparität waren für
beide Slices offen. Die Portierung war keine Umschaltung.

Aktualisierung S7 am 2026-10-12: 104 Knowledge-Dateien liegen jetzt im uncommitteten
Haupt-Tree `rust` und bestehen die dokumentierten Rust-Gates. Die damalige Modullücke
ist geschlossen; der Gateway-Prozess startet inzwischen den Knowledge-Loop (siehe
Fortschrittsnotiz oben). TS-Differenzparität und Cutover bleiben offen. S9 ist weiterhin
nicht in `rust` integriert.

Gate-Korrektur: `cargo test -p betaclaw-core --features test-support` ist falsch.
`test-support` ist ein Feature von `betaclaw-gateway`
(`rust/crates/betaclaw-gateway/Cargo.toml:15`); `betaclaw-core` hat keine Features.
Richtig ist `cargo test -p betaclaw-core`.

### Offene Punkte (konsolidiert)

Register der bewusst offenen Abweichungen und Nacharbeiten, damit sie
slice-übergreifend nachverfolgbar bleiben.

| ID    | Punkt                                                                                                                                                                                                                                                                                                                                  | Herkunft              | Status                                                                                                                                   |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| OP-1  | `DELETE /api/channels/conversations` bricht in TS die laufende Generierung ab und leert Summary-/Recall-Zustand; der Zustand liegt im Node-Prozess                                                                                                                                                                                     | S3                    | offen bis S8                                                                                                                             |
| OP-2  | TS-Metriken und Trace-Logs (`recordInbox*`, `logChatDisplayTrace`) fehlen; `resync` hat keine Wirkung                                                                                                                                                                                                                                  | S3                    | offen bis S8                                                                                                                             |
| OP-3  | Ungültiges JSON im Body: Rust-Text von `serde_json` weicht vom V8-Text ab (Personas S2, Messages S3); Status und Form stimmen                                                                                                                                                                                                          | S2/S3                 | bewusst, akzeptiert                                                                                                                      |
| OP-4  | `GET /api/channels/messages?limit=abc`: TS reicht `NaN` durch, Rust nimmt 100                                                                                                                                                                                                                                                          | S3                    | bewusst, akzeptiert                                                                                                                      |
| OP-5  | `PATCH` mit `modelOverride` als Zahl: Rust schreibt die Zahl als Text                                                                                                                                                                                                                                                                  | S3                    | bewusst, akzeptiert                                                                                                                      |
| OP-6  | Config-DB-Standardpfad löste gegen `WORKSPACE_ROOT` statt cwd auf                                                                                                                                                                                                                                                                      | S2-Nacharbeit         | geschlossen (siehe oben)                                                                                                                 |
| OP-7  | Alte Datei `crates/betaclaw-gateway/.local/gateway-config.db` liegt noch auf der Platte                                                                                                                                                                                                                                                | S2-Testisolation      | manuell löschbar                                                                                                                         |
| OP-8  | Testname `agrees_with_the_gateway_crate_implementation` (`revision.rs`) passt nicht mehr zum Inhalt                                                                                                                                                                                                                                    | S2-Testisolation      | Umbenennen offen                                                                                                                         |
| OP-9  | `/api/model-hub/**` (10 Routen) ist im `rust`-Dirty-Tree jetzt nativ gemountet; fehlende Account-/Provider-Orchestrierung sowie OAuth-/Refresh-Verhalten (`modelFetcher.ts`, `connectivity.ts`, `connect`/`disconnect`, `oauth.ts`, `codexAuth.ts`) müssen noch abgeglichen werden                                                     | S4                    | teilweise erledigt; Parität offen                                                                                                        |
| OP-10 | `/api/memory` (5 Methoden) und `memory/runtime.ts` sind S5 zugeordnet, portiert und gemountet; SQLite-Routenparität ist für geprüfte CRUD-Fälle grün, Postgres nutzt den S6-Pool, und die Route publiziert Lifecycle-Ereignisse über `AppState`. Live-Verhalten/RLS, weitere Provider-Parität und Event-Consumer-Parität bleiben offen | S5                    | teilweise erledigt                                                                                                                       |
| OP-11 | OAuth-State (`oauth.ts:29,36`) ist absichtlich nicht portiert (hmac/digest-Konflikt, `crypto.rs:34-45`); die Codex-Kontoverknüpfung bleibt in TypeScript                                                                                                                                                                               | S4                    | offen bis OAuth-Routen geplant sind                                                                                                      |
| OP-12 | `codexAuth.ts` ist nur teilweise portiert (`decodeJwtPayload`/`extractCodexAccountId` in `client/config.rs:183,204`); der Refresh-Default ist ein `Err`-No-op (`service/refresh.rs:50-60`)                                                                                                                                             | S4                    | offen bis S4-Nacharbeit                                                                                                                  |
| OP-13 | Rust-Code-Gegenstücke für `mem0EmbedderSync.ts`, `src/core/memory/index.ts` und `gemini.ts` liegen im Dirty-Tree; 17 Mem0-Sync- und 13 Core-Memory-Tests sind grün. Produktionsaufrufer, Runtime-Wiring und TS/Rust-Parität fehlen noch                                                                                                | S5                    | Code portiert; Integration offen                                                                                                         |
| OP-14 | S4/S5-Routen sind im rust-Dirty-Tree nativ gemountet; S2/S3-Familien und die S5-SQLite-Familie liefen am 2026-10-12 grün; S4- sowie S5-Postgres/RLS-Parität bleiben offen                                                                                                                                                              | S2–S5                 | teilweise; S4 und S5-Postgres/RLS offen                                                                                                  |
| OP-15 | Mem0Client und MemoryRepository liegen jetzt in provider-neutralen Memory-Modulen; alte Pfade bleiben als Re-Exports erhalten                                                                                                                                                                                                          | S5                    | im rust-Dirty-Tree erledigt                                                                                                              |
| OP-16 | ReqwestTransport ist produktiv vorhanden und wird von Model-Hub-Routen genutzt; der alte fehlende HTTP-Transport ist behoben                                                                                                                                                                                                           | S4/S8                 | erledigt                                                                                                                                 |
| OP-17 | Persona-DELETE muss Graphiti, Mem0, World-Model, Konversationen, Knowledge und Telegram-Pairing bereinigen; bis dahin bleibt der Handler vollständig am TypeScript-Proxy                                                                                                                                                               | S2/S5–S7/S12          | Proxy-Fallback getestet; Portierung offen                                                                                                |
| OP-18 | `world_model_port.rs::from_process_env` nutzt `UnconfiguredPgExecutor`. World-Model-Abfragen in `/api/health` und `/api/control-plane/metrics` schlagen daher immer fehl, und die Antworten weichen vom TS-Original ab                                                                                                                 | S6/S9                 | geschlossen (`LazyPgExecutor` mit `connect_lazy` und 5-s-Timeout; Health & Metrics fragen die Live-DB ab; eigener Pool neben `AppState`) |
| OP-19 | `scripts/dev-stack-rust.mjs` enthält `CANONICAL_DATABASE_URL` mit Klartext-Passwort der Rolle `world_model_app`; der Wert sollte aus `.env.local` kommen                                                                                                                                                                               | Dev-Stack             | geschlossen (`worldModelDockerEnv` reicht World-Model-Flags und DB-URLs aus `.env.local` durch; kein Klartext-Passwort)                  |
| OP-20 | Der Credential-Verbindungscache in `routes/security.rs` hält einen Handle pro Pfad. Wird die Messages-DB zur Laufzeit ersetzt, liest er die alte Datei bis zum nächsten Query-Fehler                                                                                                                                                   | Lastbefund 2026-10-29 | geschlossen (FileIdentity prüft mtime/size/dev/ino; Cache invalidiert sich bei Datei-Neuerstellung automatisch)                          |

### OP-Register S9 (aus dem Bahn-Code erhoben)

`grep 'OP-S9' docs/RUST_MIGRATION.md` lieferte vorher 0 Treffer, während
`lane/s9` diese IDs im Code zitiert. Die Kurzfassung stammt jeweils aus dem
zitierenden Modulkopf; die Belegstelle steht in der Spalte Herkunft.

| ID       | Punkt (Kurzfassung aus dem Code)                                                                                                                                                                                                                       | Herkunft (= Belegstelle)                                                                         | Status                |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | --------------------- |
| OP-S9-2  | Sandbox-Ausführungspfad gehört zu S11; P5 öffnet nur die Naht, der Body wird nicht portiert                                                                                                                                                            | `master/toolforge.rs:9`, `toolforge/sandbox_runner.rs:3,30`                                      | offen bis S11         |
| OP-S9-3  | `master/cronBridge.ts` liest `automation/runtime` (S10) und bleibt bis S10 in TypeScript                                                                                                                                                               | `master/mod.rs:97`                                                                               | offen bis S10         |
| OP-S9-4  | `masterActionBridge` (S6) wird von `connectors/gmail/actions.ts`, `execution/runtime/toolRunner.ts` und `app/api/master/gmail` konsumiert; alle drei zurückgehalten                                                                                    | `master/connectors.rs:10`, `execution.rs:12`, `connectors/gmail.rs:9`, `execution/runtime.rs:20` | offen bis S6/S10      |
| OP-S9-5  | Erledigt: Clippy 1.94 verwarf das manuelle `impl Default` für `ProspectiveRuntimeDeps` (`derivable_impls`); Fix als `#[derive(Default)]`                                                                                                               | `866ad265` (`lane/s7`), `c9e48438` (`lane/s9`)                                                   | erledigt              |
| OP-S9-6  | `CapabilityUnderstandingCycle`-Naht statt direkter Verdrahtung des Lernzyklus                                                                                                                                                                          | `master/capabilities.rs:12`, `learning.rs:20`, `mod.rs:69`                                       | bewusst, Naht         |
| OP-S9-7  | `DelegationDispatcherPort` und `ActionLedgerPort` sind Nähte; das Gateway komponiert sie, `getMasterExecutionRuntime` ist zurückgestellt                                                                                                               | `master/mod.rs:45`, `orchestrator.rs:12`, `runtime.rs:18,206`                                    | bewusst, Naht         |
| OP-S9-8  | Model-Dispatch des Understanding-Loops läuft über den `MasterModelDispatch`-Einstieg                                                                                                                                                                   | `master/understanding_loop.rs:16`, `mod.rs:54`                                                   | bewusst, Naht         |
| OP-S9-11 | Prozessweite Timer des Subagent-Pools: nur wiederkehrende Ticks werden delegiert; Fehlerpfad liefert `{ accepted: false, reason }` statt Unwind. Seit 2026-11-01 werden Job und Session dabei `failed` mit `lastError` (vorher fälschlich `completed`) | `master/delegation/dispatcher.rs:34`, `subagent_pool.rs:15,24`, `mod.rs:61`                      | bewusst, dokumentiert |
| OP-S9-12 | `action_ledger`: TS unterscheidet Ablehnung und Fehler; Rust hält die Semantik über einen anderen Rückgabepfad                                                                                                                                         | `master/execution/action_ledger.rs:15`                                                           | bewusst, dokumentiert |
| OP-S9-13 | `resolveToolPolicy`-Naht wird von `ToolPolicyServiceResolver` geschlossen; `approval_policy` nutzt einen treuen Default                                                                                                                                | `master/tool_policy.rs:7`, `tool_policy/service.rs:8,333`, `execution/approval_policy.rs:15`     | geschlossen in P5     |
| OP-S9-14 | Folgewirkung des ausgeschlossenen `toolRunner.ts`                                                                                                                                                                                                      | `master/mod.rs:56`                                                                               | offen bis S8/S11      |
| OP-S9-15 | Prozessweite Timer (zweite Stelle), siehe OP-S9-11                                                                                                                                                                                                     | `master/mod.rs:61`                                                                               | bewusst, dokumentiert |
| OP-S9-16 | `CapabilityRuntimePersona`-Naht für die Runtime-Persona-Auflösung                                                                                                                                                                                      | `master/understanding_loop.rs:19,44,321`, `mod.rs:71`                                            | bewusst, Naht         |
| OP-S9-17 | Von P5 geöffnete Sandbox-Naht, Body bleibt S11 (siehe OP-S9-2)                                                                                                                                                                                         | `master/toolforge/sandbox_runner.rs:12`                                                          | offen bis S11         |
| OP-S9-18 | Schlüsselauflösung in `secret_store` nutzt die S4-Crypto-Grundelemente                                                                                                                                                                                 | `master/connectors/secret_store.rs:7`                                                            | bewusst, Grenze       |
| OP-S9-19 | Fail-closed-Gate-Adapter                                                                                                                                                                                                                               | `master/mod.rs:79`                                                                               | bewusst, Grenze       |
| OP-S9-20 | Repository-Fehler, die in TypeScript geworfen hätten, laufen über den fail-closed-Gate-Adapter                                                                                                                                                         | `master/mod.rs:79`, `tool_policy/service.rs:15,333`                                              | bewusst, Grenze       |

Nicht beobachtet und daher hier nicht geführt: OP-S9-1, OP-S9-9, OP-S9-10. Die IDs
1–20 sind nicht lückenlos vergeben; das ist kein Fehler, sondern nur ein Hinweis,
dass die Nummerierung im Bahn-Code entstanden ist.

### Offene Doku-Lücken aus der Bahn-Verifikation

Klein, nicht blockierend, bewusst nicht mehr in dieser Runde gefixt:

- `master/connectors/gmail/types.rs` nennt im Kopf den Bereich `1-16`, `types.ts`
  hat aber 17 Zeilen (die 17. ist leer).
- Die LOC-Angaben in einigen Modulköpfen sind locker: `tool_policy.rs` sagt
  "~197" bei 222 Zeilen, `connectors.rs` sagt "~530" bei 472 Zeilen.

## 8. Befehle

```powershell
pnpm dev                    # Rust-Gateway (3000) + web-ui (3001) + Scheduler
pnpm rust:test              # cargo test im Container
pnpm rust:clippy            # clippy mit -D warnings
pnpm rust:fmt:check         # cargo fmt --check
pnpm fixtures:security-rules    # SECURITY_RULES nach Rust exportieren
pnpm fixtures:nextauth-token    # Session-Token-Fixture aus dem echten next-auth
pnpm verify:logs-parity     # Rust gegen die Referenzdaten (golden/) auf /api/logs
pnpm verify:route-parity    # alle Paritätsfamilien gegen die Referenzdaten (golden/)
pnpm verify:route-coverage   # Rust-Routentabelle gegen scripts/verify/route-table.json
```

Der Container-Smoke für die HTTP- und WS-Verträge:

```powershell
docker build -f docker/Dockerfile.gateway -t betaclaw-gateway-local .
docker run -d --name betaclaw-gateway-ws -p 127.0.0.1:3999:3000 `
  -e NODE_ENV=development -e REQUIRE_AUTH=false `
  -e LOGS_DB_PATH=/app/.local/logs.db -e WORKSPACE_ROOT=/app `
  betaclaw-gateway-local
pnpm verify:logs-parity
```

### Schneller Workflow

Messwerte vom 2026-10-10 auf dem Windows-Host (Rust 1.94.1), Befehl
`cargo test --workspace --features betaclaw-gateway/test-support`. Alle Läufe
grün, 545 Tests (449 core, 82 gateway lib, 7 gateway_http, 7 nextauth_parity).
Aktuelle Testzahlen und Liefernachweise stehen bei der Abnahme der Nacharbeiten in
Abschnitt 7. Route-Coverage prüft deklarierte Pfad-/Methodenpaare und darf nicht als
vollständiger Verhaltens- oder Cutover-Nachweis bezeichnet werden.

| Lauf                            | Gesamtdauer                  | core   | gateway lib | gateway_http | nextauth_parity |
| ------------------------------- | ---------------------------- | ------ | ----------- | ------------ | --------------- |
| Baseline warm (Profil vorher)   | 21,26 s                      | 7,01 s | 10,46 s     | 2,13 s       | 0,00 s          |
| Einmal-Rebuild mit neuem Profil | 169,2 s (Cargo-Build 2m 32s) | 1,53 s | 9,39 s      | 2,13 s       | 0,00 s          |
| Neu warm (neues Profil)         | 14,57 s                      | 1,13 s | 9,35 s      | 2,12 s       | 0,00 s          |

Neu warm gegen Baseline warm: -6,69 s (-31,5 %). Die `finished in`-Werte sind die
Laufzeiten der Testbinaries, die Gesamtdauer enthält zusätzlich den Cargo-Start.

- **Ein Target-Verzeichnis pro Worktree**, per `CARGO_TARGET_DIR` gesetzt. Nie ein
  frisches Target anlegen: ein frischer Build dauerte gemessen 2m 32s, ein warmer
  Lauf rund 15 s.
- **Verifikation als ein Lauf** mit demselben Target: erst
  `cargo fmt --all -- --check`, dann
  `cargo clippy --workspace --all-targets --features betaclaw-gateway/test-support -- -D warnings`,
  dann `cargo test --workspace --features betaclaw-gateway/test-support`.
  Clippy braucht eigene Check-Artefakte: der erste Clippy-Lauf nach einem Testlauf
  dauerte 68,8 s.
- **Während der Arbeit nur das betroffene Crate testen**, zum Beispiel
  `cargo test -p betaclaw-core`. Das volle Gate läuft nur am Ende eines Slices.
- **Dev-Profil** in `rust/Cargo.toml`: `debug = "line-tables-only"` und
  `opt-level = 2` für alle Dependencies (`[profile.dev.package."*"]`). Workspace-Crates
  bleiben unoptimiert. Trade-off: Im Debugger sind keine lokalen Variablen sichtbar,
  bei Bedarf `debug = true` temporär setzen. Das Profil gilt auch im Docker-Pfad, weil
  `./rust` gemountet wird; dort fällt einmalig ein Rebuild im Volume an.
- **Docker-Pfad**: `pnpm rust:test`, `pnpm rust:clippy` und `pnpm rust:fmt:check`
  laufen im Container `rust:1.94-bookworm` mit den persistenten Volumes
  `betaclaw-cargo-registry`, `betaclaw-rust-target` und `betaclaw-rustup`. Der erste
  Lauf ist langsam, danach schnell. Das Container-Target ist vom Host-Target getrennt.
- **Host-Beschleuniger**: `sccache` und `cargo-nextest` sind auf dem Host nicht
  installiert. Entscheidung offen.
