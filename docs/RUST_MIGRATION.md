# Backend-Migration nach Rust

Status: in Umsetzung · Worktree `E:\web\clawtest-rust` (Branch `rust`, von `6dcdd322`)
Letzte Aktualisierung: 2026-10-10

Ziel: Das produktive Backend gehört Rust. HTTP, WebSocket, Auth, Geschäftslogik,
Datenzugriff, Integrationen sowie Scheduler und Hintergrundjobs. Next.js/React/TypeScript
bleiben Benutzeroberfläche. Next.js darf während der Übergangszeit dünner Reverse-Proxy
sein, aber keine Backend-Geschäftslogik mehr enthalten.

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
Statements, gleiche `_migrations`-Buchführung). Die 19 World-Model-`.sql`-Dateien bleiben an
ihrem Ort und werden von Rust mit demselben Advisory-Lock-Verfahren angewendet.

## 4. Migrationsreihenfolge

| #   | Slice                                                              | LOC       | Inhalt                                                                                                                     |
| --- | ------------------------------------------------------------------ | --------- | -------------------------------------------------------------------------------------------------------------------------- |
| S0  | Fundament                                                          | ca. 2k    | axum-Server, Auth-Gate, Reverse-Proxy, Docker, CI. Topologie „Rust besitzt 3000"                                           |
| S1  | Transport, Auth, Gateway-WS, Observability                         | ca. 3k    | JWE-Auth, scrypt, SQLite, WS-Framing/Registry/Broadcast/Keepalive, Rate-Limits, Event-Bus. `/api/logs*`, `/api/security/*` |
| S2  | Config, Gateway-Config, Personas, Security-Routen                  | ca. 3k    | kleine isolierte DBs, Sicherheits-Flags                                                                                    |
| S3  | Messages/Conversations/Inbox/Sessions-Store                        | ca. 6k    | reine SQLite-Repos, trägt Chat und Agent-Room                                                                              |
| S4  | Model Hub                                                          | ca. 5.8k  | 16 Provider, Pipeline, Crypto, Embeddings. Mechanischster Code, entsperrt alles LLM-abhängige                              |
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

**Slice-Status** (Legende: ✅ abgeschlossen · 🚧 in Arbeit · ▢ offen)

| Slice | Thema                                                              | Status |
| ----- | ------------------------------------------------------------------ | ------ |
| S0    | Fundament                                                          | ✅     |
| S1    | Transport, Auth, Gateway-WS, Observability                         | ✅     |
| S2    | Config, Gateway-Config, Personas, Security-Routen                  | ✅     |
| S3    | Messages/Conversations/Inbox/Sessions-Store                        | ✅     |
| S4    | Model Hub                                                          | 🚧     |
| S5    | Memory                                                             | ▢      |
| S6    | World Model                                                        | ▢      |
| S7    | Knowledge                                                          | ▢      |
| S8    | Chat-Dispatch, Recall, Subagents, Tool-Loop                        | ▢      |
| S9    | Master                                                             | ▢      |
| S10   | Tasks, Workspaces, Agents, Automation                              | ▢      |
| S11   | Skills-Handler und Exec-Freigaben                                  | ▢      |
| S12   | Stats, Clawhub, Proactive, Debug, Files, Ops, Agent-v2, Agent-Room | ▢      |
| S13   | Endzustand                                                         | ▢      |

Der Feingrad je Slice (welche Routen/Methoden migriert sind, welche bewusst beim Proxy
bleiben) steht in den Fortschrittsnotizen in Abschnitt 7. Die offenen Abweichungen sind
im Register „Offene Punkte" am Ende von Abschnitt 7 gebündelt.

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

### 2026-10-10 — S0 und S1 abgeschlossen

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

- `POST /api/personas`, `PUT` und `DELETE /api/personas/{id}`. Sie brauchen die
  Model-Hub-Verdrahtung für `preferredModelId`. `GET /api/personas/templates`
  ist laut Slice-Plan zurückgestellt (statische Liste aus
  `src/lib/persona-templates`). Alle laufen weiter über den Proxy; die Tests
  `unported_persona_routes_fall_through_to_the_proxy` und
  `other_methods_fall_through_to_the_proxy` prüfen das.

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

### Offene Punkte (konsolidiert)

Register der bewusst offenen Abweichungen und Nacharbeiten, damit sie
slice-übergreifend nachverfolgbar bleiben.

| ID   | Punkt                                                                                                                                              | Herkunft         | Status                   |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------ |
| OP-1 | `DELETE /api/channels/conversations` bricht in TS die laufende Generierung ab und leert Summary-/Recall-Zustand; der Zustand liegt im Node-Prozess | S3               | offen bis S8             |
| OP-2 | TS-Metriken und Trace-Logs (`recordInbox*`, `logChatDisplayTrace`) fehlen; `resync` hat keine Wirkung                                              | S3               | offen bis S8             |
| OP-3 | Ungültiges JSON im Body: Rust-Text von `serde_json` weicht vom V8-Text ab (Personas S2, Messages S3); Status und Form stimmen                      | S2/S3            | bewusst, akzeptiert      |
| OP-4 | `GET /api/channels/messages?limit=abc`: TS reicht `NaN` durch, Rust nimmt 100                                                                      | S3               | bewusst, akzeptiert      |
| OP-5 | `PATCH` mit `modelOverride` als Zahl: Rust schreibt die Zahl als Text                                                                              | S3               | bewusst, akzeptiert      |
| OP-6 | Config-DB-Standardpfad löste gegen `WORKSPACE_ROOT` statt cwd auf                                                                                  | S2-Nacharbeit    | geschlossen (siehe oben) |
| OP-7 | Alte Datei `crates/betaclaw-gateway/.local/gateway-config.db` liegt noch auf der Platte                                                            | S2-Testisolation | manuell löschbar         |
| OP-8 | Testname `agrees_with_the_gateway_crate_implementation` (`revision.rs`) passt nicht mehr zum Inhalt                                                | S2-Testisolation | Umbenennen offen         |

## 8. Befehle

```powershell
pnpm dev                    # Rust-Gateway (3000) + web-ui (3001) + Scheduler
pnpm dev:node               # alter Node-Stack, nur zur Fehlersuche
pnpm rust:test              # cargo test im Container
pnpm rust:clippy            # clippy mit -D warnings
pnpm rust:fmt:check         # cargo fmt --check
pnpm fixtures:security-rules    # SECURITY_RULES nach Rust exportieren
pnpm fixtures:nextauth-token    # Session-Token-Fixture aus dem echten next-auth
pnpm fixtures:gemini-traffic    # Gemini-HTTP-Traffic als Rust-Fixture aufzeichnen
pnpm verify:logs-parity     # Rust gegen TypeScript auf /api/logs
pnpm verify:route-parity    # alle Paritätsfamilien (logs, config) gegen den Gateway
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
