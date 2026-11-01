# Abgleich TS-Tests mit Rust-Tests (Schritt 2.3)

Stand: 2026-10-31 · Plan: `docs/TS_BACKEND_REMOVAL_PLAN.md`, Phase 2.3

Dieses Dokument ist der Nachweis, mit dem Phase 5 die Vitest-Dateien löscht, die `@/server`
oder `src/server` importieren. Es ist **kein vollständiger Abgleich**. Die Tabelle nennt
pro Domäne, was Fall für Fall verglichen wurde und was nicht. Offene Punkte sind mit
„offen“ markiert. Vor Phase 5 müssen sie geschlossen oder bewusst gestrichen sein.

## 1. Methode und Grenzen

- **Liste der Testdateien:** `grep -rlE "@/server|src/server" tests` ergibt 461 Dateien. Der
  Plan nennt 444. Die Differenz kommt von Dateien, die nur `src/server/...` im Text nennen,
  etwa Architektur-Guards und CI-Tests.
- **Fallzahl:** Anzahl der `it(`/`test(`-Blöcke je Datei (ein `it.each` zählt als ein
  Block). Summe: **2599 TS-Fälle**.
- **Zuordnung TS-Quelle zu Rust-Modul:** Rust-Modulköpfe nennen die TS-Datei, die sie
  portieren (`src/server/...`). Die Zuordnung ist ein Hinweis. Sie sagt nicht, dass ein
  Fall abgedeckt ist. Eine Zählung „Rust-Tests je Domäne“ wäre deshalb irreführend und fehlt
  in diesem Dokument. Ein Modul enthält oft viele Themen, die Zuordnung überschätzt die
  Abdeckung.
- **Vergleich Fall für Fall:** nur für die Domänen in Abschnitt 4. Bei allen anderen Domänen
  gilt: Zuordnung vorhanden, Fallvergleich nicht gemacht.

Einordnung der Spalten in Abschnitt 4:

- **abgedeckt:** Ein bestehender Rust-Test prüft dasselbe Verhalten.
- **neu:** Der Rust-Test wurde in diesem Schritt ergänzt (Namen in Abschnitt 5).
- **nicht portiert:** Begründung steht im Text. Es ist ein bewusster Verzicht.
- **offen:** Kein Gegenstück gefunden. Vor Phase 5 zu klären.

## 2. Domänen-Übersicht

Sortiert nach TS-Fällen. „Vergleich“ ist der Stand der Prüfung in diesem Schritt.

| Domäne                                                                        | TS-Dateien | TS-Fälle | Vergleich        | Hinweis                                                              |
| ----------------------------------------------------------------------------- | ---------: | -------: | ---------------- | -------------------------------------------------------------------- |
| knowledge                                                                     |         58 |      390 | nicht verglichen | Ausnahme: Memory-Poisoning-Guard, siehe Abschnitt 4.6                |
| channels                                                                      |         85 |      355 | teilweise        | Webhook-Auth und Telegram-Chunking geprüft (Abschnitt 4.7)           |
| world-model                                                                   |         56 |      337 | nicht verglichen | Bereich der parallelen Arbeit, nur aufgelistet (Abschnitt 6)         |
| memory                                                                        |         21 |      300 | teilweise        | Poisoning-Guard geprüft; Rest offen                                  |
| agent-room                                                                    |         10 |      139 | nicht verglichen |                                                                      |
| model-hub                                                                     |         21 |      103 | teilweise        | Sicherheitsfälle geprüft (Abschnitt 4.8)                             |
| gateway                                                                       |         12 |      103 | teilweise        | Login-Route geprüft; Broadcast, Client-Registry, Method-Router offen |
| master                                                                        |         46 |      101 | teilweise        | Tool-Policy geprüft (Abschnitt 4.9)                                  |
| server (`unit/server`: Tasks, Summary)                                        |          7 |       99 | nicht verglichen |                                                                      |
| stats                                                                         |         13 |       85 | nicht verglichen |                                                                      |
| top-level (`messageRouter`, `telegram-chunking`, `skillMd-*`, …)              |         13 |       74 | nicht verglichen |                                                                      |
| automation                                                                    |         12 |       68 | nicht verglichen |                                                                      |
| **auth**                                                                      |          9 |       65 | **verglichen**   | Abschnitt 4.1                                                        |
| clawhub                                                                       |          8 |       49 | nicht verglichen |                                                                      |
| skills                                                                        |         19 |       45 | **verglichen**   | Abschnitt 4.3                                                        |
| **security**                                                                  |          4 |       36 | **verglichen**   | Abschnitt 4.2                                                        |
| agent-v2                                                                      |          6 |       31 | teilweise        | Extension-Signatur geprüft, Host-Laufzeit offen (Abschnitt 6)        |
| **config**                                                                    |          7 |       30 | **verglichen**   | Abschnitt 4.4                                                        |
| personas                                                                      |         11 |       26 | nicht verglichen |                                                                      |
| agents                                                                        |          1 |       19 | nicht verglichen |                                                                      |
| telegram                                                                      |          3 |       15 | nicht verglichen |                                                                      |
| refactor                                                                      |          6 |       13 | nicht verglichen |                                                                      |
| mission-control                                                               |          5 |       13 | nicht verglichen |                                                                      |
| diagnostics                                                                   |          4 |       12 | nicht verglichen |                                                                      |
| telemetry                                                                     |          2 |       12 | nicht verglichen |                                                                      |
| ci                                                                            |          2 |       12 | nicht nötig      | prüft TS-Repo-Struktur (Harness-Registry); fällt mit dem TS-Code weg |
| commands                                                                      |          2 |       11 | nicht verglichen |                                                                      |
| events                                                                        |          2 |       11 | nicht verglichen |                                                                      |
| ops                                                                           |          4 |        7 | nicht verglichen |                                                                      |
| di                                                                            |          1 |        6 | nicht verglichen | TS-DI-Container, kein Rust-Gegenstück nötig                          |
| architecture                                                                  |          2 |        5 | nicht nötig      | Import-Richtungen im TS-Code; fällt mit dem TS-Code weg              |
| runtime, control-plane, modules, http, proactive, app-shell, api, chat, debug |          9 |       27 | nicht verglichen |                                                                      |
| **Summe**                                                                     |    **461** | **2599** |                  |                                                                      |

## 3. Zuordnung über Modulköpfe

Die Zuordnung von TS-Quelle zu Rust-Modul steht in Abschnitt 1. Eine Zahl je Domäne
(„Rust-Tests in zugeordneten Modulen“) wäre hier irreführend und ist deshalb weggelassen.
Die Zuordnung je Datei lässt sich mit dem Befehl aus Abschnitt 1 neu erzeugen.

Ohne Rust-Gegenstück (kein Modul nennt die TS-Quelle):

- `src/server/skills/skillInstaller.ts`: Die Rust-Seite installiert keine Handler aus
  Manifesten, siehe Abschnitt 4.3.
- `src/server/skills/externalSkillHost`, `handlers/browserTool`, `handlers/messageCompat`,
  `handlers/sessionCompat`, `handlers/multiToolUseParallel`: keine Zuordnung. Ob Rust sie
  anders benennt, ist nicht geprüft.
- `src/server/agent-v2/extensions/host.ts`, `workerHost.ts`, `agent-v2/runtime.ts`,
  `agent-v2/session/commands/execute.ts`: Laufzeit fehlt in Rust (Abschnitt 6).
- `src/server/gateway/keepalive`, `constants`, `methods/agent-v2/registerMethods`,
  `config/uiRuntimeConfig`, `di/container`, `runtime/jobOwner`: keine Zuordnung.

## 4. Vergleich Fall für Fall

### 4.1 auth (`tests/unit/auth`, 9 Dateien, 65 Fälle)

| Ergebnis       | Fälle |
| -------------- | ----: |
| abgedeckt      |    44 |
| neu            |    15 |
| nicht portiert |     3 |
| offen          |     3 |

- **login-rate-limiter (11):** Sperre, Unabhängigkeit der Schlüssel, Reset, Eviction,
  erster X-Forwarded-For-Hop, fehlender Header, Längenbegrenzung abgedeckt (`limiter.rs`).
  Neu: Fensterablauf, frisches Budget, Pruning. **Nicht portiert:** „accepts an array header
  value“. Axum liefert einen Header-Wert, kein Array (`routes/auth.rs`).
- **credentials-rate-limit (4):** Sperre nach 10 Fehlversuchen über die Route abgedeckt
  (`empty_attempts_do_not_count_and_ten_failures_block_correct_credentials`). Gleiche Antwort
  für unbekannte und falsche Passwörter abgedeckt. Neu: IP-Budget über verschiedene E-Mails.
  **Offen:** „resets the email budget after a successful login“. Die Reset-Zeile in
  `callback_credentials` existiert, es gibt aber keinen Test dafür.
- **proxy-policy (22 Blöcke):** Loopback-Adressen, Host-Header, Cross-Site-Erkennung,
  Anonymous-Principal, Fetch-Metadata abgedeckt (`policy.rs`, `auth_gate.rs`). Neu:
  LAN-Spoof mit Origin, CSRF-Origin auf localhost, fehlender Host, `null`-Origin,
  Referer-Mismatch, Anfrage ohne Browser-Header. **Offen:** Marker bei unbekannter
  Peer-Adresse („leaves the marker unset“) und weitergereichter Marker („keeps a forwarded
  marker untouched“). Beides sind Verhaltensregeln des Gateways, die in `auth_gate.rs`
  noch fehlen.
- **user-context (10):** Session-Auflösung, Principal-Fallback, API-Token als Service,
  Anonymous bei Pflicht-Auth abgedeckt. **Nicht portiert:** „skips session lookup in local
  optional-auth dev mode“ (prüft einen Mock-Aufruf von `auth()`) und „rethrows unexpected
  auth errors“. Rust hat kein Exception-Pfad: ein ungültiges Session-Cookie ergibt `None`.
  Die Fail-Closed-Regel bei Pflicht-Auth ist mit `invalid_session_with_auth_required_is_rejected`
  abgedeckt.
- **user-store (5) und user-store-legacy-verify (4):** Scrypt-Format, Legacy-SHA256 mit
  Upgrade, Public-Default-Passwort, Bootstrap-Regeln abgedeckt. Neu: keine Admin-Anlage in
  Development, Pflicht-Credentials in Production, Wiederherstellung eines Kontos mit
  Default-Passwort, Upgrade-Zeile in der DB, falsches Passwort ändert Hash nicht, Dummy-Hash
  bei unbekannter E-Mail.
- **production-guard (7):** alle abgedeckt (`production_guard.rs`). Die Umgebungs-Hülle
  `assert_production_auth_config_from_env` hat keinen eigenen Test. Sie liest nur Variablen.
- **websocket-session-cookie (1 Block, 2 Werte):** Chunk-Join und -Split in `jwe.rs`
  abgedeckt. Den Schalter `secureCookie` prüft kein eigener Test.
- **constants (1):** Konstante, kein eigener Test.

### 4.2 security (`tests/unit/security` 3 Dateien, `tests/integration/security` 1 Datei, 36 Fälle)

| Ergebnis  | Fälle |
| --------- | ----: |
| abgedeckt |    29 |
| neu       |     5 |
| offen     |     2 |

- **security-status (21 Blöcke):** Firewall, Verschlüsselung, Audit-Check, Kanal-Liste,
  Summen abgedeckt (`security/status.rs`, `routes/security.rs`). Neu: Verifikationsart je
  Kanal (signed / shared_secret), Audit „ok“ bei vorhandener DB, Zeitstempel ist gültiges
  RFC 3339.
- **file-access (8):** abgedeckt (`security/file_access.rs`). Neu: Root-Verzeichnis selbst
  ist erlaubt.
- **ssrf-guard (5):** abgedeckt durch `net_guard/ssrf_guard.rs` (15 Tests) und
  `fetch_with_policy.rs`. Protokoll, Credentials, Redirect-Stopp, Header bei fremdem Origin,
  Body-Limit.
- **integration/security/privileged-routes-auth (2):** offen. Der Gateway-Auth-Gate
  (`auth_gate.rs`) prüft ähnliches. Ein Fall-für-Fall-Vergleich fehlt.

### 4.3 skills (`tests/unit/skills` 13 Dateien, `tests/integration/skills` 6 Dateien, 45 Fälle)

| Ergebnis       | Fälle |
| -------------- | ----: |
| abgedeckt      |    12 |
| neu            |    10 |
| nicht portiert |     3 |
| offen          |    20 |

Abgedeckt bzw. neu:

- **exec-approval-policy (6):** Shell-Approval und Python-Approval abgedeckt. Neu:
  Process-Manager- und Playwright-Approval.
- **shell-execute-security (6):** Approval und Workspace-Cwd abgedeckt. Neu: verschlüsseltes
  PowerShell, `reg delete`, `sc stop` (alle in `node_command_policy.rs`) und
  `bypassApproval` (`shell_execute.rs`).
- **process-manager-security (3):** Cwd-Escape abgedeckt. Neu: verschlüsseltes PowerShell
  bei `start`, Approval bei `start`.
- **python-approval (2):** abgedeckt (`python_execute.rs`, Hash des Rohtexts).
- **demo-coding-compat (2):** Workflow abgedeckt. Neu: Symlink-Escape für read, write und edit
  (`coding_compat.rs`). **Der Test läuft nur unter Unix**, wie bei
  `execution_cwd::symlink_out_of_the_root_is_rejected`. Auf dem Windows-Host wird er nicht
  kompiliert. Der Patch-Pfad nutzt dieselbe Funktion `resolve_workspace_path`.
- **runtime-config-route (2)** (Integration): abgedeckt durch
  `skills_wire/skills.rs`, `runtime_config_saves_masks_and_clears_a_value`.
- **runtime-config-store (3):** zwei Fälle abgedeckt. Offen: „deletes stored config values“
  in der Form, wie TS sie prüft.
- **skill-installer-validation (3):** neu: unsichere Skill-IDs (`manifest_id_rejects_path_like_values`
  in `skills_wire/skills.rs`). **Nicht portiert:** „accepts a relative handler path“ und
  „rejects handler path escape“. Die Rust-Gateway-Route installiert Manifeste ohne
  `handler` (`handler_path: None`). Die Meldung „External skill installation is disabled
  in the Rust gateway“ steht im Code (`skills_wire/skills.rs`). Dadurch gibt es keinen
  Handler-Pfad, der entkommen könnte.

Nicht portiert:

- **exec-approval-policy: „reads process.env by default“.** Rust liest die Konfiguration
  einmal beim Start (`SkillEnv`). Das ist eine bewusste Abweichung, kein Verlust.

Offen (nicht verglichen):

- **demo-browser-tool-handler (2), demo-memory-compat (1), demo-message-compat (1),
  demo-session-compat (1), multi-tool-use-parallel (4):** keine Rust-Zuordnung gefunden.
  Vor Phase 5 prüfen, ob die Fälle als Rust-Test gebraucht werden.
- **exec-approval-policy: „requires interactive tool approval in the message service“ (1):**
  Gehört zum Channel-Dispatcher, nicht geprüft.
- **shell-execute-runtime-config (2):** Standardwerte und Klemmen für Timeout und Puffer.
  Nicht gegen `runtime_config.rs` geprüft.
- **runtime-config-store (1):** siehe oben.
- **integration/skills external-host-route (3), execute-route-context (1),
  execute-router-demo-aliases (1), execute-router (1), execute-router-external (1):**
  nicht geprüft.
- **skill-repository (7, top-level) und skills-route-requests (9, top-level):** Rust hat
  Tests in `store.rs` (5) und in `skills_wire`. Kein Fall-für-Fall-Vergleich.
- **skillMd-parser, -prompt, -filter (16 Fälle, top-level):** Rust hat `skill_md/*` mit 22
  Tests. Kein Fall-für-Fall-Vergleich.

### 4.4 config (`tests/unit/config` 3 Dateien, `tests/integration/config` 4 Dateien, 30 Fälle)

| Ergebnis  |                     Fälle |
| --------- | ------------------------: |
| abgedeckt |                        27 |
| neu       | 1 (Rust-Fix, Abschnitt 5) |
| offen     |                         2 |

- **gateway-config (10), gateway-normalize-behavior (5):** abgedeckt
  (`gateway_config/normalize.rs`, `repository.rs`, `secrets.rs`).
- **gateway-config-rollback (1):** neu als `failed_replace_keeps_the_previous_file`. Der
  Test hat einen echten Fehler gefunden (Abschnitt 5).
- **config-route (11 Blöcke):** 10 abgedeckt (`routes/config.rs`). **Offen:** „sanitizes
  unexpected internal errors and avoids path leaks“.
- **config-concurrency, config-conflict-ux:** abgedeckt (409 mit aktueller Revision).
- **config-observability (1):** offen. Die TS-Telemetrie für Lade- und Speicherereignisse
  hat kein Rust-Gegenstück gefunden.

### 4.5 Ausgewählte Sicherheitsfälle in anderen Domänen

- **Gateway-Login (gateway, `routes/auth.rs`):** Tests für Sperre, IP-Budget und
  Längenbegrenzung der IP, siehe 4.1.
- **Kanal-Webhooks (channels):** `webhook_auth.rs` (4 Tests) und `webhooks.rs` (19 Tests)
  decken Shared-Secret, fehlendes Secret, Insecure-Flag und Telegram-Secret ab. Die
  Die 10 Blöcke aus `tests/unit/channels/webhook-auth.test.ts` wurden gegen die Testnamen
  in `webhook_auth.rs` gelesen. Die Assert-Ebene ist nicht geprüft.
- **Telegram-Chunking (`telegram-chunking.test.ts`, 7 Fälle):** `adapters/telegram/outbound.rs`
  hat die Split-Tests (Zeilenumbruch, Markup nur auf erstem Chunk). Die Grenze 4096 ist
  dort als Konstante geführt. Fall-für-Fall nicht gezählt.
- **Master-Tool-Policy (`tool_policy/service.rs`, 13 Tests):** Allowlist-Treffer, Miss
  mit ask on/off, Host-gebundener Eintrag, Stern-Eintrag, ask always, Glob-Regeln.
  Nicht geprüft: „target-context allowlist entries“ und „handles empty allowlist entries“
  (letzteres dürfte in `parse_allowlist_entry` liegen).
- **Agent-v2 Extension-Signatur (`extension_security.rs`, 9 Tests):** Kanonische Digests,
  Signaturprüfung, Allowlist-Format, Fehlerreihenfolge abgedeckt. Die Laufzeit (Hooks,
  Kill-Switch, Fail-Closed-Stufen, Worker) fehlt, siehe Abschnitt 6.

### 4.6 knowledge: Memory-Poisoning-Guard (`tests/unit/knowledge/memory-poisoning-guard.test.ts`, 11 Fälle)

Der TS-Guard ist ein Re-Export des Memory-Moduls. Die Regeln liegen in
`betaclaw-memory/src/memory/poisoning.rs` (10 Tests). Die TS-Fälle sind inhaltlich
abgedeckt: Muster mit „System:“, „vergiss alle“, Passwort, „Ignore all“, Identitätswechsel,
Prozent-Kodierung, Unicode-Zeichen ohne Breite, begrenztes Base64, normaler Text, lange
Codeblöcke, lange URLs. Die Rust-Tests nehmen andere Längen als die TS-Tests (400 statt 600 Zeichen). Die
Schwelle selbst wurde nicht zeichengenau verglichen.

### 4.7 channels: Webhook-Auth (`unit/channels/webhook-auth.test.ts`)

Siehe 4.5. Der Fall-für-Fall-Abgleich ist nur über die Namen gemacht.

### 4.8 model-hub: Sicherheitsfälle

- **Graphiti-Adapter (`integration/model-hub/graphiti-adapter-route.test.ts`, 8 Fälle):**
  abgedeckt durch `ops_wire/internal.rs` (falscher Bearer, Pfad ohne /v1, Nicht-JSON,
  Rollen ohne System/User/Assistant, fehlende Pipeline). Der Fall „fehlender Token“ ist in
  Rust nur für den Ingest-Pfad getestet. Die Fälle „case-insensitive bearer scheme“ und
  „trims the configured secret“ haben keinen eigenen Rust-Test.
- **Origin-Normalisierung (`normalizes 0.0.0.0 origin to localhost`, `:: origin`):**
  `url_origin.rs` (Tests für `0.0.0.0`, `::` und `[::]`).
- **Codex-Auth, Verschlüsselung der Konten:** `crypto.rs` und `codex_auth.rs` haben Tests.
  Ein Fall-für-Fall-Vergleich mit den 103 Modellfällen fehlt.
- **Provider-Adapter (OpenAI, Kimi, OpenRouter, Ollama, Gemini, …):** nicht verglichen.
  Die Rust-Adapter haben je eigene Tests (`providers/*.rs`).

### 4.9 master: Tool-Policy

Siehe 4.5. Der Rest der 101 Master-Fälle (Approvals, Runs, Gmail-Connector, Feedback) ist
nicht verglichen.

## 5. Rust-Änderungen in diesem Schritt

### 5.1 Verhaltensfix (TS-Test beschreibt die Soll-Regel)

1. **`rust/crates/betaclaw-gateway/src/routes/auth.rs`, `resolve_client_ip`:** Ein
   `X-Forwarded-For` mit mehr als 64 Zeichen ergab vorher `None`. Dadurch fiel das
   IP-Budget für diese Anfragen weg. TS (`resolveClientIp`, `loginRateLimiter.ts`) kürzt auf
   64 Zeichen. Die Funktion ruft jetzt `betaclaw_core::auth::limiter::resolve_client_ip`
   auf, also dieselbe Regel wie der Limiter selbst. Test:
   `client_ip_is_truncated_to_64_characters_not_dropped`.
2. **`rust/crates/betaclaw-base/src/gateway_config/repository.rs`, `replace_file`:** Der
   Windows-Fallback löschte die vorhandene Konfiguration, bevor geprüft war, ob die
   temporäre Datei existiert. Schlug das zweite `rename` fehl, war die alte Konfiguration
   weg. TS (`gateway-config-rollback.test.ts`) verlangt, dass die vorherige Datei bleibt.
   Jetzt wird die alte Datei zuerst nach `<pfad>.replaced` verschoben und bei Fehler
   zurückgeschrieben. Test: `failed_replace_keeps_the_previous_file`.

### 5.2 Neue Rust-Tests (25 Funktionen)

| Datei                                                 | Tests                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `betaclaw-base/src/auth/limiter.rs`                   | `blocked_key_unblocks_after_window_and_starts_fresh_budget`, `prunes_expired_entries_once_a_window_has_elapsed`                                                                                                                                                                                                                                                         |
| `betaclaw-base/src/auth/policy.rs`                    | `opaque_null_origin_and_mismatching_referer_are_cross_site`, `request_without_browser_headers_is_neither_cross_site_nor_same_origin`, `missing_host_header_is_never_loopback`, `csrf_from_evil_origin_aimed_at_loopback_is_denied`                                                                                                                                      |
| `betaclaw-base/src/auth/user_store.rs`                | `wrong_password_on_legacy_hash_does_not_upgrade_it`, `successful_login_upgrades_legacy_hash_in_the_database`, `unknown_email_is_hashed_against_a_dummy_for_timing`, `development_without_bootstrap_credentials_creates_no_admin`, `production_without_bootstrap_credentials_fails_on_first_start`, `explicit_bootstrap_recovers_an_account_still_on_the_public_default` |
| `betaclaw-base/src/gateway_config/repository.rs`      | `failed_replace_keeps_the_previous_file`                                                                                                                                                                                                                                                                                                                                |
| `betaclaw-gateway/src/routes/auth.rs`                 | `ip_budget_blocks_correct_credentials_across_emails`, `client_ip_is_truncated_to_64_characters_not_dropped`                                                                                                                                                                                                                                                             |
| `betaclaw-gateway/src/families/skills_wire/skills.rs` | `manifest_id_rejects_path_like_values`                                                                                                                                                                                                                                                                                                                                  |
| `betaclaw-skills/src/security/status.rs`              | `channel_verification_kinds_match_typescript`, `audit_check_is_ok_when_the_messages_database_exists`, `generated_at_is_a_valid_rfc3339_timestamp`                                                                                                                                                                                                                       |
| `betaclaw-skills/src/security/file_access.rs`         | `the_root_directory_itself_is_allowed`                                                                                                                                                                                                                                                                                                                                  |
| `betaclaw-skills/src/skills/node_command_policy.rs`   | `blocks_the_shell_security_cases_from_typescript`                                                                                                                                                                                                                                                                                                                       |
| `betaclaw-skills/src/skills/playwright_cli.rs`        | `playwright_cli_demands_an_approval_when_approvals_are_enabled`                                                                                                                                                                                                                                                                                                         |
| `betaclaw-skills/src/skills/process_manager.rs`       | `start_refuses_encoded_powershell_and_needs_an_approval`                                                                                                                                                                                                                                                                                                                |
| `betaclaw-skills/src/skills/shell_execute.rs`         | `bypass_approval_skips_the_gate_for_a_granted_interactive_call`                                                                                                                                                                                                                                                                                                         |
| `betaclaw-skills/src/skills/coding_compat.rs`         | `read_write_and_edit_refuse_paths_that_follow_an_external_symlink` (nur `cfg(unix)`)                                                                                                                                                                                                                                                                                    |

Die Zählung 25 bezieht sich auf Test-Funktionen. Der Symlink-Test läuft auf Windows nicht.

## 6. Nicht portierte Bereiche, die Phase 5 blockieren

Diese Punkte sind keine Testfrage, sondern ein Funktionsunterschied. Die TS-Tests dafür
dürfen erst gelöscht werden, wenn das Verhalten gestrichen oder portiert ist.

1. **Agent-v2 Extension-Host (Laufzeit).** `src/server/agent-v2/extensions/host.ts` und
   `workerHost.ts` laden signierte Extensions, führen Lifecycle-Hooks aus und haben einen
   Kill-Switch (Tests „honors the disabled kill switch“),
   Fail-Open- und Fail-Closed-Stufen sowie Worker-Stopp. Rust hat nur die Prüfung der
   Signatur und des Manifests (`extension_security.rs`). Die Laufzeit fehlt. Betroffen:
   `tests/unit/agent-v2/extensions-host.test.ts` (6 Fälle) und Teile von
   `tests/unit/agent-v2/execute.test.ts`. TS-Aufrufer: `agent-v2/runtime.ts`,
   `session/commands/execute.ts`. Entscheidung nötig: portieren oder streichen.
2. **Externe Skill-Handler.** Die Rust-Gateway-Route lehnt externe Installationen ab, das
   Laden von Handlern fehlt. Die TS-Fälle zu Handler-Pfaden sind damit nur TS-Verhalten.
3. **World-Model.** Die 337 Fälle liegen im Bereich der parallelen Arbeit und sind hier
   nur gezählt. Sie sind nicht verglichen.
4. **Ops-Skripte und E2E.** Gehören zu Phase 2.1 und 2.2 bzw. Phase 3, nicht zu diesem
   Schritt.

## 7. Offene Domänen (nicht verglichen)

Alle Domänen aus Abschnitt 2 mit „nicht verglichen“ oder „teilweise“. Insbesondere noch
offen:

- knowledge (außer Poisoning-Guard), channels (außer Webhook-Auth und Telegram-Chunking),
  memory, world-model, agent-room, master (außer Tool-Policy), gateway (außer Login),
  model-hub (Provider-Adapter), server (Tasks, Summary), stats, automation, clawhub,
  personas, telegram, diagnostics, telemetry, commands, events, ops, mission-control,
  refactor, top-level-Dateien.
- Zahlen für „abgedeckt“ in diesen Domänen gibt es noch nicht. Der Vergleich ist der
  nächste Schritt vor Phase 5.

Die Domänen „ci“ und „architecture“ prüfen den TS-Code selbst. Sie fallen mit dem TS-Code
weg und brauchen kein Rust-Gegenstück.

## 8. Gates

Siehe Abschnitt 9 (wird nach dem letzten Lauf eingetragen).

## 9. Ergebnis der Gates

| Gate   | Befehl                    | Ergebnis                                                                                                                                                                                                                                                                                                                                                  |
| ------ | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Check  | `pnpm run rust:check`     | bestanden (Exit 0, nach den Änderungen)                                                                                                                                                                                                                                                                                                                   |
| Format | `pnpm run rust:fmt:check` | **nicht bestanden, nicht von diesem Schritt verursacht.** Die Diffs liegen in `betaclaw-gateway/src/world_model_ops/*`, `betaclaw-gateway/src/bin/betaclaw-scheduler.rs` und `betaclaw-world-model/src/world_model/role_verification.rs`. Das sind Dateien der parallelen Arbeit. Die Dateien dieses Schritts sind formatiert (`rustfmt --edition 2021`). |
| Clippy | `pnpm run rust:clippy`    | bestanden (`cargo clippy --all-targets -- -D warnings`, Exit 0)                                                                                                                                                                                                                                                                                           |
| Tests  | `pnpm run rust:test`      | bestanden: 3612 Tests, 0 fehlgeschlagen, 0 ignoriert (Exit 0)                                                                                                                                                                                                                                                                                             |

Hinweis zur Testzahl: Der Plan nennt rund 3556 Tests vor diesem Schritt. Die 25 neuen
Funktionen aus Abschnitt 5.2 sind darin enthalten. Der Rest der Differenz stammt aus der
parallelen Arbeit und ist nicht aufgeschlüsselt.

## 10. Zweite Runde und Entscheidung für Phase 5

Stand: 2026-11-01. Die zweite Runde hat die Domänen je Crate verglichen. Die Ergebnisse
stehen in eigenen Dateien:

| Datei                                                                            | Domänen                                                            |    TS-Fälle | abgedeckt | neu | nicht portiert |    offen |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------: | --------: | --: | -------------: | -------: |
| [`ts-test-audit/channels.md`](ts-test-audit/channels.md)                         | channels, telegram, top-level, summary                             |         419 |       170 |  45 |              1 |      203 |
| [`ts-test-audit/memory-knowledge.md`](ts-test-audit/memory-knowledge.md)         | knowledge, memory                                                  |         691 |       569 |  68 |             11 |       43 |
| [`ts-test-audit/model-hub-master.md`](ts-test-audit/model-hub-master.md)         | model-hub, master, mission-control                                 |         221 |       158 |  30 |              9 |       24 |
| [`ts-test-audit/features.md`](ts-test-audit/features.md)                         | agent-room, agents, automation, clawhub, agent-v2, tasks, refactor |         387 |       123 | 153 |            102 |        9 |
| [`ts-test-audit/store-skills-gateway.md`](ts-test-audit/store-skills-gateway.md) | stats, personas, gateway (Teil), Reste aus 4.1–4.4, Skill-Dateien  | siehe Datei |           |  38 |                | ca. 330¹ |

¹ Darin rund 305 Fälle, die nicht Fall für Fall verglichen wurden (76 aus neun Gateway-Dateien,
229 aus kleineren Gruppen, Liste in Abschnitt 4.3 der Datei). world-model (337 Fälle) ist nur
über Modulköpfe zugeordnet, nicht Fall für Fall verglichen.

In beiden Runden kamen zusammen rund 360 neue Rust-Tests hinzu. Gefundene und behobene
Rust-Fehler: Login-IP-Limit bei überlangem `X-Forwarded-For`, Config-Verlust beim Ersetzen
unter Windows, fehlgeschlagene Subagent-Aufgaben galten als `completed`, Provider-Abbruch
als eigene Fehlerart (`ServiceError::Aborted`).

### Entscheidung

Die offenen Fälle blockieren Phase 5 nicht. Begründung:

- Der TS-Code läuft im Standard-Stack nicht mehr. Seine Tests prüfen Code, der nicht
  ausgeführt wird. Das Löschen ändert nichts am Verhalten des laufenden Systems.
- Das laufende System ist durch die Rust-Tests, die E2E-Lanes gegen Rust (Smoke 9,
  Browser 69), die Paritäts-Suite mit 186 Referenzfällen und den Production-Smoke geprüft.
- Die TS-Quellen und -Tests bleiben über den Tag `legacy-ts-backend` (`273c7879`) abrufbar.
  Wer eine Lücke schließt, liest dort den TS-Test nach.

Die offenen Fälle sind damit ein Backlog, kein Löschhindernis. Sie fallen in zwei Gruppen:

1. **Funktionen, die Rust nicht hat** (Lücke besteht schon heute im laufenden Stack):
   Heuristik-Auto-Memory, Telegram-Medien, Health-Monitor, Adapter-Registry und
   Outbound-Router, `messageRouter`-Befehle `/subagents`, `/steer`, `/deny`, `/shell`,
   Kaskade beim Löschen einer Persona (Memory, Telegram), Migration alter Chat-Uploads beim
   Start, Werkzeuge `multi_tool_use.parallel`, `github_query`, `message`, `sessions_*`,
   Memory-Kompatibilität und Browser-Alias, `demo-*`-Handler. Bewusst gestrichen (Entscheidung
   vom 2026-10-31): Agent-v2-Extension-Host und externe Skill-Handler.
2. **Verhalten, das Rust hat, aber ohne gleichwertigen Test**: die übrigen offenen Fälle der
   Dateien oben und die nicht verglichenen Gruppen inklusive world-model.

Ausnahme: Testdateien, die UI-Logik prüfen und `@/server` nur für Typen importieren
(`frontend-utils.test.ts`, `artifact-phase-markers.test.ts`, `completion-text.test.ts`), werden
in Phase 5 umgehängt, nicht gelöscht.
