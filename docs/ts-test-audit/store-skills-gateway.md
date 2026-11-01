# Abgleich TS-Tests mit Rust-Tests: store, skills, gateway, base (Schritt 2.3)

Stand: 2026-11-01 · Plan: `docs/TS_BACKEND_REMOVAL_PLAN.md`, Phase 2.3 · Methode: `docs/TS_TEST_COVERAGE_AUDIT.md`

Dieses Dokument deckt die Domänen stats, personas, gateway, die offenen Fälle von skills,
auth, security und config sowie die übrigen Zeilen aus Abschnitt 2 des Audits ab, soweit
sie nicht anderen Agenten zugewiesen sind. Die Spalten entsprechen Abschnitt 4 des Audits:
**abgedeckt** (bestehender Rust-Test), **neu** (in diesem Schritt ergänzt), **nicht portiert**
(bewusster Verzicht mit Begründung), **offen** (kein Gegenstück, noch nicht geklärt).

Die Fallzahlen stammen aus derselben Zählung wie im Audit: je `it(`/`test(`-Block, ein
`it.each` zählt als ein Block. Die Zuordnung der Dateien ist die Grep-Liste aus Abschnitt 1.

## 1. Ergebnis je Domäne

### 1.1 stats (13 Dateien, 85 Fälle)

| TS-Datei                                              |  Fälle | abgedeckt |    neu | nicht portiert | offen |
| ----------------------------------------------------- | -----: | --------: | -----: | -------------: | ----: |
| `unit/stats/engineering-metrics-aggregator`           |      2 |         2 |      0 |              0 |     0 |
| `unit/stats/engineering-metrics-service-branches`     |     18 |        13 |      5 |              0 |     0 |
| `unit/stats/engineering-snapshot-repository-branches` |      3 |         2 |      1 |              0 |     0 |
| `unit/stats/harness-rollout`                          |      4 |         4 |      0 |              0 |     0 |
| `unit/stats/openrouter-pricing`                       |     14 |         7 |      7 |              0 |     0 |
| `unit/stats/pr-risk-classifier`                       |      3 |         3 |      0 |              0 |     0 |
| `unit/stats/prompt-audit`                             |      8 |         3 |      5 |              0 |     0 |
| `unit/stats/prompt-dispatch-repository`               |      5 |         3 |      2 |              0 |     0 |
| `unit/stats/token-usage-repository`                   |     14 |        11 |      3 |              0 |     0 |
| `unit/stats/xai-pricing`                              |      3 |         3 |      0 |              0 |     0 |
| `integration/stats/engineering-route`                 |      4 |         3 |      1 |              0 |     0 |
| `integration/stats/prompt-logs-route`                 |      6 |         1 |      5 |              0 |     0 |
| `integration/stats/stats-route-sessions-lens`         |      1 |         0 |      1 |              0 |     0 |
| **Summe**                                             | **85** |    **55** | **30** |          **0** | **0** |

Hinweise:

- `engineering-route`: Die Fälle „partial metrics“ und „fresh snapshot“ sind auf
  Service-Ebene abgedeckt (`run_signals_keep_completed_runs_…`, `merge_sizes_and_async_breaches_…`,
  `a_fresh_stored_snapshot_is_served_with_its_age`), nicht auf Route-Ebene. Das ist als abgedeckt gezählt.
- `prompt-logs-route`: Der 401-Fall für DELETE ist durch `prompt_logs_list_and_clear` abgedeckt.

### 1.2 personas (11 Dateien, 26 Fälle)

| TS-Datei                                                 |  Fälle | abgedeckt |   neu | nicht portiert | offen |
| -------------------------------------------------------- | -----: | --------: | ----: | -------------: | ----: |
| `unit/personas/master-system-persona`                    |      2 |         2 |     0 |              0 |     0 |
| `unit/personas/persona-filesystem-storage`               |      3 |         2 |     1 |              0 |     0 |
| `unit/personas/persona-preferred-model`                  |      3 |         3 |     0 |              0 |     0 |
| `unit/personas/persona-project-workspace`                |      5 |         2 |     3 |              0 |     0 |
| `unit/personas/persona-workspace`                        |      4 |         2 |     0 |              0 |     2 |
| `integration/personas/master-system-persona-routes`      |      2 |         2 |     0 |              0 |     0 |
| `integration/personas/persona-nexus-tools-readiness`     |      1 |         0 |     0 |              0 |     1 |
| `integration/personas/personas-files-route-filesystem`   |      1 |         1 |     0 |              0 |     0 |
| `integration/personas/personas-memory-cascade-delete`    |      2 |         0 |     0 |              0 |     2 |
| `integration/personas/personas-model-binding-route`      |      1 |         1 |     0 |              0 |     0 |
| `integration/personas/personas-model-binding-validation` |      2 |         0 |     2 |              0 |     0 |
| **Summe**                                                | **26** |    **15** | **6** |          **0** | **5** |

### 1.3 gateway (12 Dateien, 103 Fälle; Login-Route ist nicht Teil dieser Summe)

| TS-Datei                                       |   Fälle | abgedeckt |   neu | nicht portiert |  offen |
| ---------------------------------------------- | ------: | --------: | ----: | -------------: | -----: |
| `unit/gateway/broadcast`                       |      10 |         6 |     2 |              2 |      0 |
| `unit/gateway/client-registry`                 |      10 |         7 |     3 |              0 |      0 |
| `unit/gateway/method-router`                   |       7 |         4 |     2 |              1 |      0 |
| `unit/gateway/connection-handler`              |      14 |         0 |     0 |              0 |     14 |
| `unit/gateway/keepalive`                       |       2 |         0 |     0 |              0 |      2 |
| `unit/gateway/channels-methods`                |       6 |         0 |     0 |              0 |      6 |
| `unit/gateway/chat-methods`                    |       4 |         0 |     0 |              0 |      4 |
| `unit/gateway/sessions-methods`                |       3 |         0 |     0 |              0 |      3 |
| `unit/gateway/agent-room-security`             |       3 |         0 |     0 |              0 |      3 |
| `unit/gateway/agent-v2-methods`                |       3 |         0 |     0 |              0 |      3 |
| `unit/gateway/agent-v2-swarm-contracts`        |      18 |         0 |     0 |              0 |     18 |
| `unit/gateway/agent-v2-swarm-methods-branches` |      23 |         0 |     0 |              0 |     23 |
| **Summe**                                      | **103** |    **17** | **7** |          **3** | **76** |

Nur `broadcast`, `client-registry` und `method-router` wurden in diesem Schritt Fall für Fall
verglichen (vom Auftrag benannt). Die übrigen neun Dateien sind **nicht verglichen**, siehe Abschnitt 4.

### 1.4 auth, security, config, skills (nur die offenen Fälle aus Abschnitt 4 des Audits)

| Bereich                                                       | Offen vor diesem Schritt | abgedeckt | neu | nicht portiert | offen |
| ------------------------------------------------------------- | -----------------------: | --------: | --: | -------------: | ----: |
| auth (4.1)                                                    |                        3 |         0 |   2 |              1 |     0 |
| security (4.2, `integration/security/privileged-routes-auth`) |                        2 |         0 |   2 |              0 |     0 |
| config (4.4)                                                  |                        2 |         0 |   1 |              1 |     0 |
| skills (4.3)                                                  |                       20 |         4 |   0 |              1 |    15 |

Details zu skills, Zeile je Fall:

- abgedeckt: `shell-execute-runtime-config` (2, Standardwerte und Klemmen in `skills/types.rs`
  `exec_config_defaults_and_clamps_match_the_env_parsers`), `runtime-config-store` „deletes stored config values“
  (`runtime_config_saves_masks_and_clears_a_value`), `execute-router` „routes file_read“ (`execute_runs_an_active_skill_and_surfaces_handler_errors` und
  `file_read`-Handler-Tests).
- nicht portiert: `execute-router-external` „loads and executes an installed external handler“. Die Rust-Gateway-Route
  lehnt externe Installation ab (`skills_wire/skills.rs`), siehe Audit 4.3.
- offen (15): siehe Abschnitt 4.2.

### 1.5 Weitere Zeilen aus Abschnitt 2 (top-level und skill-Dateien)

| TS-Datei                        |  Fälle | abgedeckt |   neu | nicht portiert | offen |
| ------------------------------- | -----: | --------: | ----: | -------------: | ----: |
| `skill-repository.test.ts`      |      7 |         5 |     2 |              0 |     0 |
| `skills-route-requests.test.ts` |      9 |         7 |     0 |              0 |     2 |
| `unit/skillMd-parser.test.ts`   |      6 |         5 |     1 |              0 |     0 |
| `unit/skillMd-prompt.test.ts`   |      5 |         5 |     0 |              0 |     0 |
| `unit/skillMd-filter.test.ts`   |      5 |         5 |     0 |              0 |     0 |
| **Summe**                       | **32** |    **27** | **3** |          **0** | **2** |

`skills-route-requests`: offen sind `github_query` und `multi_tool_use.parallel`, siehe 4.2.

## 2. Neue Rust-Tests in diesem Schritt

| Datei                                                         | Test                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `betaclaw-store/src/stats/prompt_audit.rs`                    | `redacts_bearer_and_authorization_values`, `redacts_nested_tool_parameters_and_attachment_paths`, `medium_band_sits_between_35_and_69`                                                                                                                                                                                       |
| `betaclaw-store/src/stats/prompt_dispatch/mod.rs`             | `before_cursor_returns_only_strictly_older_rows`, `provider_filter_selects_one_provider`                                                                                                                                                                                                                                     |
| `betaclaw-store/src/stats/token_usage.rs`                     | `totals_and_summary_respect_the_time_range`, `list_entries_is_newest_first`                                                                                                                                                                                                                                                  |
| `betaclaw-store/src/stats/openrouter_pricing.rs`              | `non_finite_and_non_numeric_rates_read_as_zero`, `non_object_tiers_are_dropped`, `invalid_env_values_are_not_positive_integers`                                                                                                                                                                                              |
| `betaclaw-store/src/stats/engineering_metrics_service.rs`     | `snake_case_payload_keys_are_read`, `a_fresh_snapshot_without_payload_fields_keeps_the_computed_sections`, `scenario_and_worktree_sections_come_from_the_repository_stats`, `a_broken_rollout_config_falls_back_to_the_unavailable_config`                                                                                   |
| `betaclaw-store/src/stats/engineering_snapshot_repository.rs` | `malformed_rollout_payloads_read_as_none`                                                                                                                                                                                                                                                                                    |
| `betaclaw-store/src/personas/workspace.rs`                    | `project_names_become_safe_slugs`                                                                                                                                                                                                                                                                                            |
| `betaclaw-store/src/personas/repository.rs`                   | `legacy_content_fills_an_existing_empty_file`                                                                                                                                                                                                                                                                                |
| `betaclaw-gateway/src/families/stats_wire/stats.rs`           | `prompt_logs_are_filtered_by_risk_and_provider`, `preset_windows_keep_recent_rows_and_drop_old_ones`, `clearing_prompt_logs_removes_the_rows_and_token_usage`, `prompt_logs_without_a_caller_are_unauthorized`, `sessions_lens_counts_each_conversation_once_by_channel`, `engineering_without_signals_reports_null_metrics` |
| `betaclaw-gateway/src/families/chat_runtime/persona.rs`       | `separate_task_requests_get_distinct_folders`, `removal_outside_the_projects_directory_is_refused`                                                                                                                                                                                                                           |
| `betaclaw-gateway/src/routes/personas.rs`                     | `unavailable_models_and_blank_profile_ids_are_rejected`, `put_on_a_foreign_persona_is_not_found`                                                                                                                                                                                                                             |
| `betaclaw-gateway/src/routes/auth.rs`                         | `a_successful_login_resets_the_email_budget`                                                                                                                                                                                                                                                                                 |
| `betaclaw-gateway/src/auth_gate.rs`                           | `unknown_peer_leaves_the_marker_unset`                                                                                                                                                                                                                                                                                       |
| `betaclaw-gateway/src/routes/mod.rs`                          | `privileged_routes_answer_401_without_a_user_context`, `legacy_local_context_keeps_model_hub_routes_readable` (Modul `privileged_route_tests`)                                                                                                                                                                               |
| `betaclaw-gateway/src/routes/config.rs`                       | `internal_load_errors_are_sanitised`                                                                                                                                                                                                                                                                                         |
| `betaclaw-gateway/src/gateway_methods.rs`                     | `a_failed_method_keeps_its_code_and_message`, `responses_echo_the_request_id`                                                                                                                                                                                                                                                |
| `betaclaw-base/src/gateway/broadcast.rs`                      | `a_gone_socket_is_skipped_without_error`                                                                                                                                                                                                                                                                                     |
| `betaclaw-base/src/gateway/registry.rs`                       | `get_and_get_all_cover_every_registered_connection`                                                                                                                                                                                                                                                                          |
| `betaclaw-skills/src/skills/store.rs`                         | `unknown_ids_report_false_on_toggle_and_remove`                                                                                                                                                                                                                                                                              |
| `betaclaw-skills/src/skills/skill_md/parser.rs`               | `crlf_line_endings_parse_like_lf`                                                                                                                                                                                                                                                                                            |

Insgesamt 38 neue Testfunktionen.

## 3. Rust-Fixes (Verhalten)

Keine Verhaltensänderung in diesem Schritt. Zwei Lint-Korrekturen in `betaclaw-base`,
die `cargo clippy -D warnings` blockierten (ohne Verhaltensänderung):

- `betaclaw-base/src/auth/limiter.rs` `active_entry`: `match` durch `?` ersetzt.
- `betaclaw-base/src/config.rs` `resolve_max_requests_per_minute`: redundantes `.max(0)` entfernt
  (der Wert ist vorher auf 10..=10 000 geklemmt).

Korrekturen an eigenen neuen Tests bei der Prüfung (Erwartungen, keine Produktlogik):

- `betaclaw-store/src/stats/engineering_metrics_service.rs` `snake_case_payload_keys_are_read`: `median_pr_size` ist `Option<i64>`, Erwartung `Some(200)`.
- `betaclaw-store/src/personas/repository.rs` `legacy_content_fills_an_existing_empty_file`: unnötige Referenz entfernt (Clippy).
- `betaclaw-gateway/src/routes/auth.rs` `a_successful_login_resets_the_email_budget`: JSON-Login antwortet mit 200 und `url`, nicht mit 302. Erwartung angepasst.
- `betaclaw-gateway/src/routes/mod.rs` `legacy_local_context_keeps_model_hub_routes_readable`: `require_auth = false` explizit gesetzt, damit eine Umgebungsvariable `REQUIRE_AUTH` den Test nicht ändert.

Lint-Korrekturen in Test-Modulen fremder Vorarbeit in meinem Crate (ohne Verhaltensänderung):

- `betaclaw-skills/src/skills/process_manager.rs`: `Instant` und `id_of` nur unter `cfg(unix)` (auf Windows sonst ungenutzt).
- `betaclaw-skills/src/skills/shell_execute.rs`: ungenutztes `use std::time::Duration` entfernt.

## 4. Nicht portiert und offen

### 4.1 Nicht portiert (bewusste Abweichung, mit Begründung)

| Fall                                                                                  | Begründung                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `broadcast`: „closes socket on send errors and swallows close failures“               | Die Rust-Frame-Serialisierung ist ein `serde_json::Value` und kann nicht fehlschlagen. Der 1011-Pfad in `send_event` ist unerreichbar.                                                                  |
| `broadcast`: „protocol filter: options.protocol = v2“                                 | Das Rust-Gateway kennt nur Protokoll v2. `ClientHandle.protocol` wird gesetzt, ein Filter ist nicht nötig.                                                                                              |
| `method-router`: „dispatches methods in explicit v2 namespace“                        | Es gibt keinen Namespace-Parameter. Rust hat nur die v2-Registry.                                                                                                                                       |
| `auth`: „keeps a forwarded marker untouched“                                          | Das Rust-Gateway besitzt den öffentlichen Listener selbst (kein Proxy-Hop davor). Der Marker wird immer aus dem Socket abgeleitet, eingehende Werte werden entfernt. Das ist strenger als die TS-Regel. |
| `config`: „config-observability“ (TS-Telemetrie `config.load.success` u. a.)          | `src/server/telemetry/configEvents.ts` ist das einzige Vorkommen der Ereignisnamen. Es gibt keinen Konsumenten im Repository. Rust protokolliert über `tracing`.                                        |
| `skills`: „execute-router-external: loads and executes an installed external handler“ | Externe Installation ist in der Rust-Route abgeschaltet (Audit 4.3).                                                                                                                                    |

### 4.2 Offen (kein Gegenstück oder Entscheidung nötig)

| Bereich          | Fall                                                                                                                                                                                                                        | Stand                                                                                                                                                                                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| personas         | `persona-workspace`: „migrates legacy chat uploads into persona workspace“ und „returns gracefully when messages schema is not initialized yet“ (2)                                                                         | Die TS-Migration `src/server/personas/personaWorkspaceMigration.ts` läuft beim Start (`src/server/channels/messages/runtime.ts:78`). In Rust gibt es nur den Marker-Pfad `.migration-v1.done`, keine Migration. Entscheidung nötig: portieren oder streichen. |
| personas         | `persona-nexus-tools-readiness` (1)                                                                                                                                                                                         | Der Test ruft alle Laufzeit-Tools auf. Shell, Datei, Python, Vision und DB haben Rust-Tests. Browser, GitHub, Subagenten und `multi_tool_use.parallel` sind laut `families/master/skills.rs:10-18` nicht portiert.                                            |
| personas         | `personas-memory-cascade-delete` (2): Mem0-/Gedächtnis-Löschung und Telegram-Abmeldung                                                                                                                                      | `routes/personas.rs` (Kommentar um Zeile 444) übernimmt nur die Konversationen. Der Rest ist als S5–S7 markiert. Die Telegram-Registry hat `remove_by_persona_id`, die Abmeldung fehlt. Entscheidung nötig vor Phase 5.                                       |
| gateway          | 76 Fälle in 9 Dateien (`connection-handler`, `keepalive`, `channels-methods`, `chat-methods`, `sessions-methods`, `agent-room-security`, `agent-v2-methods`, `agent-v2-swarm-contracts`, `agent-v2-swarm-methods-branches`) | Nicht verglichen in diesem Schritt.                                                                                                                                                                                                                           |
| skills           | `demo-browser-tool-handler` (2)                                                                                                                                                                                             | Kein Rust-Gegenstück gefunden (Browser-Tool-Alias).                                                                                                                                                                                                           |
| skills           | `demo-memory-compat` (1)                                                                                                                                                                                                    | `skills/memory_compat.rs` ist nur ein Trait, nicht implementiert (S5).                                                                                                                                                                                        |
| skills           | `demo-message-compat` (1) und `demo-session-compat` (1)                                                                                                                                                                     | `message` und `sessions_*` sind in `families/master/skills.rs:12-18` als nicht portiert gelistet.                                                                                                                                                             |
| skills           | `multi-tool-use-parallel-handler` (4)                                                                                                                                                                                       | Laut `families/master/skills.rs:18` nicht in S11 portiert.                                                                                                                                                                                                    |
| skills           | `exec-approval-policy`: „requires interactive tool approval in the message service“ (1)                                                                                                                                     | Gehört zum Channel-Dispatcher (`betaclaw-channels`), nicht in meinen Crates.                                                                                                                                                                                  |
| skills           | `integration/skills/external-host-route` (3)                                                                                                                                                                                | Rust-Route `/api/skills/external-host` existiert (`families/skills_wire/skills.rs`), hat aber keine Tests.                                                                                                                                                    |
| skills           | `execute-route-context` (1)                                                                                                                                                                                                 | Weitergabe von Benutzer- und Request-Kontext an den Dispatch nicht gezielt geprüft.                                                                                                                                                                           |
| skills           | `execute-router-demo-aliases` (1)                                                                                                                                                                                           | Alias `exec`/`process` nicht geprüft.                                                                                                                                                                                                                         |
| skills           | `skills-route-requests`: `github_query` (1), `multi_tool_use.parallel` (1)                                                                                                                                                  | Nicht portiert, siehe oben.                                                                                                                                                                                                                                   |
| nicht verglichen | Dateien aus Abschnitt 2 ohne Fall-für-Fall-Abgleich (Stand dieses Schritts)                                                                                                                                                 | Siehe 4.3.                                                                                                                                                                                                                                                    |

### 4.3 Nicht verglichen in diesem Schritt (Umfang je Gruppe)

| Gruppe                    | Dateien                                                                                                                                                                                                           | Fälle |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----: |
| gateway, Rest             | 9 Dateien (siehe 1.3)                                                                                                                                                                                             |    76 |
| top-level                 | `messageRouter` (12), `telegram-chunking` (7), `next-config-tracing` (5), `turbopack-path-patterns` (1), `flow-api` (6), `control-plane-metrics-route` (4), `debug` (1), `chat/webui-nexus-chat-stream-tools` (2) |    38 |
| server (Summary)          | `unit/server/summaryService-perf` (24), `unit/server/proactive/runtime` (9), `unit/server/sqlite` (3)                                                                                                             |    36 |
| diagnostics               | `unit/diagnostics/safe-trace-payload` (2), `integration/diagnostics` doctor, health, scheduler-health (10)                                                                                                        |    12 |
| telemetry / logs          | `integration/telemetry/logs-route` (9), `logs-ingest-route` (3)                                                                                                                                                   |    12 |
| commands                  | `unit/commands` health-check-helpers (3), health-command (8)                                                                                                                                                      |    11 |
| events                    | `unit/events` event-bus (10), runtime-subscribers (1)                                                                                                                                                             |    11 |
| ops                       | `integration/ops/ops-routes` auth-instances (2), nodes (3), sessions (2)                                                                                                                                          |     7 |
| di                        | `unit/di/container`                                                                                                                                                                                               |     6 |
| runtime                   | `unit/runtime/job-owner` (Job-Ownership, Phase-4-Berührung)                                                                                                                                                       |     5 |
| control-plane             | `unit/control-plane/vector-node-count`                                                                                                                                                                            |     4 |
| http                      | `unit/http/fetch-with-policy` (Zuordnung `net_guard/fetch_with_policy.rs`)                                                                                                                                        |     3 |
| app-shell, api, proactive | `unit/app-shell/default-view-config` (3), `unit/api/with-user-context` (2), `unit/proactive/proactive-gate-service` (3)                                                                                           |     8 |
| Zuordnung unklar          | `channels-pair-route.test.ts` (6, vermutlich channels), `unit/modules` (1 Datei), `e2e`, `contract`                                                                                                               |    6+ |

Die Gruppen „server (Tasks)“ mit 63 Fällen gehören zum Tasks-Agenten und sind nicht enthalten.
`messages` und `inbox` haben keine eigene Testdatei in der Grep-Liste.

Summe der nicht verglichenen Fälle in dieser Tabelle: 229 (ohne Zeile „Zuordnung unklar“).

## 5. Prüfungen

Ergebnisse der Läufe auf dem Host (kein Container):

| Schritt                   | Befehl                                                                                  | Ergebnis                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Format                    | `rustfmt --edition 2021` auf den 20 geänderten Dateien                                  | ausgeführt (nur die eigenen Dateien, nicht `cargo fmt -p`, damit die Dateien paralleler Agenten nicht verändert werden)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Clippy `betaclaw-base`    | `cargo clippy -p betaclaw-base --all-targets -- -D warnings`                            | bestanden (exit 0), nach den Lint-Korrekturen                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Clippy `betaclaw-store`   | `cargo clippy -p betaclaw-store --all-targets -- -D warnings`                           | im letzten vollen Lauf: ein Lint in meinem Test (`needless_borrows`), behoben. Danach nicht erneut mit Clippy gelaufen.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Clippy `betaclaw-skills`  | `cargo clippy -p betaclaw-skills --all-targets -- -D warnings`                          | bestanden (exit 0), nach den Lint-Korrekturen in `process_manager.rs` und `shell_execute.rs` (Test-Module)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Clippy `betaclaw-gateway` | `cargo clippy -p betaclaw-gateway --all-targets --features test-support -- -D warnings` | **nicht verifiziert.** Clippy bricht im Abhängigkeitscrate `betaclaw-features` ab (`src/proactive/service.rs:161`, `sort_by` statt `sort_by_key`). Fremde Datei, nicht geändert. Die Gateway-Dateien dieses Schritts wurden deshalb nicht von Clippy geprüft.                                                                                                                                                                                                                                                                                                                                                                                          |
| Test `betaclaw-base`      | `cargo test -p betaclaw-base`                                                           | bestanden (exit 0)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Test `betaclaw-store`     | `cargo test -p betaclaw-store`                                                          | bestanden: 207 Tests, 0 fehlgeschlagen; Doc-Tests 0 (exit 0)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Test `betaclaw-skills`    | `cargo test -p betaclaw-skills`                                                         | bestanden (exit 0)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Test `betaclaw-gateway`   | `cargo test -p betaclaw-gateway --features test-support`                                | Vollauf: 575 bestanden, 5 fehlgeschlagen. Zwei der fünf sind meine Tests (`routes::auth::…::a_successful_login_resets_the_email_budget`, `routes::privileged_route_tests::legacy_local_context_keeps_model_hub_routes_readable`); beide korrigiert und einzeln erneut gelaufen, exit 0. Die übrigen drei liegen nicht in meinen Dateien: `model_hub_transport::tests::a_connection_failure_is_a_transport_error` und `…transport_errors_omit_the_request_url` (Timeout) sowie `routes::security::tests::cached_credential_connection_reopens_when_file_recreated` (Windows-Dateisperre). Ob sie vor meinen Änderungen fehlschlagen, ist nicht geprüft. |

Zu den Testläufen der Gateway-Tests: Im Verzeichnis `rust/crates/betaclaw-gateway` entstand dabei die gitignorte Datei `mission-control.db` (Testartefakt, nicht eingecheckt, nicht gelöscht).

## 6. Blocker für das Löschen der TS-Tests (Phase 5)

1. Persona-Löschung: Gedächtnis-Kaskade und Telegram-Abmeldung fehlen in Rust (4.2). Entscheidung nötig.
2. Persona-Migration für Chat-Uploads hat kein Rust-Gegenstück (4.2). Entscheidung nötig.
3. Nicht portierte Laufzeit-Tools: `multi_tool_use.parallel`, `github_query`, `message`, `sessions_*`, Browser-Alias, Memory-Compat (4.2). Entscheidung: portieren oder streichen.
4. Externer Skill-Host (`/api/skills/external-host`): Route vorhanden, ohne Tests (4.2).
5. Gateway: 76 Fälle in 9 Dateien und 229 Fälle in den Gruppen von 4.3 sind noch nicht verglichen. Ohne diesen Abgleich ist die Freigabe der Löschung für diese Bereiche nicht belegt.
6. Gateway-Clippy: bricht im fremden Crate `betaclaw-features` ab (Abschnitt 5). Die Gateway-Dateien dieses Schritts sind deshalb nicht von Clippy geprüft. Die Gateway-Tests laufen; drei fremde Fehlschläge (Model-Hub-Transport, Sicherheits-Route) bleiben offen und sind nicht geklärt.
