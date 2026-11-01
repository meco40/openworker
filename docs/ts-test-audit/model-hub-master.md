# Abgleich TS-Tests mit Rust-Tests: model-hub, master, mission-control (Schritt 2.3)

Stand: 2026-11-01 · Plan: `docs/TS_BACKEND_REMOVAL_PLAN.md`, Phase 2.3 · Methode: `docs/TS_TEST_COVERAGE_AUDIT.md` (Abschnitt 1)

Geprüfte Crates: `rust/crates/betaclaw-model-hub`, `rust/crates/betaclaw-master`. Mission-control hat keinen Rust-Anteil in diesen Crates (siehe Abschnitt 4).

## 1. Umfang und Zählung

- TS-Testdateien: 72 (model-hub 21, master 46, mission-control 5), gefunden mit `grep -rlE "@/server|src/server"` auf die Verzeichnisse `tests/unit/model-hub`, `tests/integration/model-hub`, `tests/contract/model-hub`, `tests/unit/master`, `tests/integration/master`, `tests/integration/mission-control`.
- TS-Fälle (`it(`/`test(`/`it.each(`-Zeilen, ein `it.each` zählt als ein Fall): **221**.
  - model-hub: 106 (Tabelle in `TS_TEST_COVERAGE_AUDIT.md` nennt 103; Differenz von 3 nicht aufgeklärt).
  - master: 102 (Tabelle nennt 101; Differenz von 1 nicht aufgeklärt).
  - mission-control: 13 (stimmt mit der Tabelle).
- Nicht erfasst: `tests/unit/personas/master-system-persona.test.ts` und `tests/unit/world-model/mission-control-bridge.test.ts` gehören zu den Domänen personas und world-model.
- Vergleich: Name und Verhalten der TS-Fälle gegen die Testnamen und, bei unklaren Fällen, gegen den TS-Testkörper. Die Assert-Ebene ist nicht vollständig geprüft.

Ergebnis je Spalte:

| Domäne          | TS-Fälle | abgedeckt |    neu | nicht portiert |  offen |
| --------------- | -------: | --------: | -----: | -------------: | -----: |
| model-hub       |      106 |        80 |     13 |              6 |      7 |
| master          |      102 |        77 |     17 |              3 |      5 |
| mission-control |       13 |         1 |      0 |              0 |     12 |
| **Summe**       |  **221** |   **158** | **30** |          **9** | **24** |

Offen (24) sind alle Routen- oder Feature-Tests, deren Gegenstück in `betaclaw-gateway` oder `betaclaw-features` liegt. Diese Crates sind nicht meine (Abschnitt 4).

## 2. Ergebnis je TS-Datei

### 2.1 model-hub

| TS-Datei                                               |   Fälle | abgedeckt |    neu | nicht portiert | offen |
| ------------------------------------------------------ | ------: | --------: | -----: | -------------: | ----: |
| `contract/model-hub/provider-catalog.test.ts`          |       2 |         1 |      1 |              0 |     0 |
| `integration/model-hub/graphiti-adapter-route.test.ts` |      10 |         3 |      0 |              0 |     7 |
| `unit/model-hub/codex-auth.test.ts`                    |       3 |         2 |      1 |              0 |     0 |
| `unit/model-hub/connectivity.test.ts`                  |      13 |         9 |      4 |              0 |     0 |
| `unit/model-hub/gateway-core.test.ts`                  |       4 |         3 |      0 |              1 |     0 |
| `unit/model-hub/gateway-prompt-logging.test.ts`        |       4 |         2 |      0 |              2 |     0 |
| `unit/model-hub/kimi-models.test.ts`                   |       1 |         1 |      0 |              0 |     0 |
| `unit/model-hub/model-fetcher.test.ts`                 |       7 |         5 |      0 |              2 |     0 |
| `unit/model-hub/openai-codex-models.test.ts`           |       5 |         5 |      0 |              0 |     0 |
| `unit/model-hub/openai-compatible-tools.test.ts`       |       3 |         3 |      0 |              0 |     0 |
| `unit/model-hub/opencode-adapter.test.ts`              |       3 |         3 |      0 |              0 |     0 |
| `unit/model-hub/provider-registry.test.ts`             |       2 |         2 |      0 |              0 |     0 |
| `unit/model-hub/reasoning-effort-open-code.test.ts`    |       3 |         3 |      0 |              0 |     0 |
| `unit/model-hub/refuseless-adapter.test.ts`            |       5 |         0 |      5 |              0 |     0 |
| `unit/model-hub/runtime-key.test.ts`                   |       4 |         2 |      2 |              0 |     0 |
| `unit/model-hub/service-core.test.ts`                  |      10 |         9 |      0 |              1 |     0 |
| `unit/model-hub/service-dispatch.test.ts`              |       7 |         7 |      0 |              0 |     0 |
| `unit/model-hub/service-embeddings.test.ts`            |      13 |        13 |      0 |              0 |     0 |
| `unit/model-hub/service-reasoning-effort.test.ts`      |       1 |         1 |      0 |              0 |     0 |
| `unit/model-hub/url-origin.test.ts`                    |       3 |         3 |      0 |              0 |     0 |
| `unit/model-hub/xai-models.test.ts`                    |       3 |         3 |      0 |              0 |     0 |
| **Summe**                                              | **106** |    **80** | **13** |          **6** | **7** |

### 2.2 master

| TS-Datei                                                                |   Fälle | abgedeckt |    neu | nicht portiert | offen |
| ----------------------------------------------------------------------- | ------: | --------: | -----: | -------------: | ----: |
| `integration/master/master-actions-execution-route.test.ts`             |       2 |         1 |      0 |              0 |     1 |
| `integration/master/master-approvals-route.test.ts`                     |       1 |         1 |      0 |              0 |     0 |
| `integration/master/master-events-route.test.ts`                        |       2 |         2 |      0 |              0 |     0 |
| `integration/master/master-feature-flag-parity.test.ts`                 |       2 |         2 |      0 |              0 |     0 |
| `integration/master/master-feedback-route.test.ts`                      |       3 |         2 |      0 |              0 |     1 |
| `integration/master/master-gmail-route.test.ts`                         |       2 |         2 |      0 |              0 |     0 |
| `integration/master/master-metrics-route.test.ts`                       |       1 |         1 |      0 |              0 |     0 |
| `integration/master/master-observability-contract.test.ts`              |       1 |         1 |      0 |              0 |     0 |
| `integration/master/master-reminders-lifecycle.test.ts`                 |       2 |         2 |      0 |              0 |     0 |
| `integration/master/master-runs-route.test.ts`                          |       3 |         3 |      0 |              0 |     0 |
| `integration/master/master-runtime-tool-loop.test.ts`                   |       1 |         0 |      0 |              0 |     1 |
| `integration/master/master-settings-route.test.ts`                      |       2 |         2 |      0 |              0 |     0 |
| `integration/master/master-subagents-route.test.ts`                     |       1 |         1 |      0 |              0 |     0 |
| `unit/master/execution-runtime/master-runtime-persona-config.test.ts`   |       2 |         1 |      0 |              0 |     1 |
| `unit/master/execution-runtime/runtime-modularization-contract.test.ts` |       2 |         0 |      0 |              2 |     0 |
| `unit/master/execution-runtime/tool-runner.test.ts`                     |       1 |         1 |      0 |              0 |     0 |
| `unit/master/gmail-client-behavior.test.ts`                             |       7 |         4 |      3 |              0 |     0 |
| `unit/master/gmail-client-real-mode.test.ts`                            |       1 |         1 |      0 |              0 |     0 |
| `unit/master/gmail-connector.test.ts`                                   |       1 |         1 |      0 |              0 |     0 |
| `unit/master/gmail-route-world-model.test.ts`                           |       2 |         1 |      0 |              0 |     1 |
| `unit/master/master-apprenticeship.test.ts`                             |       1 |         1 |      0 |              0 |     0 |
| `unit/master/master-approval-policy.test.ts`                            |       4 |         4 |      0 |              0 |     0 |
| `unit/master/master-approval-service.test.ts`                           |       1 |         1 |      0 |              0 |     0 |
| `unit/master/master-capability-inventory.test.ts`                       |       1 |         1 |      0 |              0 |     0 |
| `unit/master/master-connector-secret-lifecycle.test.ts`                 |       1 |         1 |      0 |              0 |     0 |
| `unit/master/master-delegation-policy.test.ts`                          |       3 |         2 |      1 |              0 |     0 |
| `unit/master/master-delegation-runtime.test.ts`                         |       1 |         1 |      0 |              0 |     0 |
| `unit/master/master-idempotency-ledger.test.ts`                         |       1 |         1 |      0 |              0 |     0 |
| `unit/master/master-learning.test.ts`                                   |       1 |         1 |      0 |              0 |     0 |
| `unit/master/master-maintenance-loop.test.ts`                           |       1 |         1 |      0 |              0 |     0 |
| `unit/master/master-notes-reminders-cron.test.ts`                       |       1 |         1 |      0 |              0 |     0 |
| `unit/master/master-orchestrator.test.ts`                               |       2 |         2 |      0 |              0 |     0 |
| `unit/master/master-reminders-service.test.ts`                          |       3 |         3 |      0 |              0 |     0 |
| `unit/master/master-scope-migration.test.ts`                            |       1 |         1 |      0 |              0 |     0 |
| `unit/master/master-subagent-pool.test.ts`                              |       2 |         0 |      1 |              1 |     0 |
| `unit/master/master-subagent-session-service.test.ts`                   |       3 |         2 |      1 |              0 |     0 |
| `unit/master/master-system-safety.test.ts`                              |       2 |         2 |      0 |              0 |     0 |
| `unit/master/master-tool-policy.test.ts`                                |       1 |         1 |      0 |              0 |     0 |
| `unit/master/master-toolforge.test.ts`                                  |       1 |         1 |      0 |              0 |     0 |
| `unit/master/master-verification.test.ts`                               |       3 |         3 |      0 |              0 |     0 |
| `unit/master/master-workspace-isolation.test.ts`                        |       3 |         3 |      0 |              0 |     0 |
| `unit/master/migration-store-branches.test.ts`                          |       2 |         0 |      2 |              0 |     0 |
| `unit/master/runtime-persona-branches.test.ts`                          |       3 |         3 |      0 |              0 |     0 |
| `unit/master/subagent-pool-branches.test.ts`                            |       6 |         1 |      5 |              0 |     0 |
| `unit/master/tool-policy-service-branches.test.ts`                      |      15 |        11 |      4 |              0 |     0 |
| `unit/master/repository/master-repository.harness.ts`                   |       0 |         0 |      0 |              0 |     0 |
| **Summe**                                                               | **102** |    **77** | **17** |          **3** | **5** |

### 2.3 mission-control

| TS-Datei                                                                |  Fälle | abgedeckt |   neu | nicht portiert |  offen |
| ----------------------------------------------------------------------- | -----: | --------: | ----: | -------------: | -----: |
| `integration/mission-control/dispatch-real-execution-required.test.ts`  |      6 |         1 |     0 |              0 |      5 |
| `integration/mission-control/full-planning-to-review-flow.test.ts`      |      1 |         0 |     0 |              0 |      1 |
| `integration/mission-control/planning-poll-dispatch-assignment.test.ts` |      1 |         0 |     0 |              0 |      1 |
| `integration/mission-control/tasks-route-workspaces.test.ts`            |      3 |         0 |     0 |              0 |      3 |
| `integration/mission-control/workspace-access-routes.test.ts`           |      2 |         0 |     0 |              0 |      2 |
| **Summe**                                                               | **13** |     **1** | **0** |          **0** | **12** |

## 3. Neue Rust-Tests

Die Tabelle nennt Testfunktionen. Ein Test kann mehrere TS-Fälle abdecken (zum Beispiel die drei Kimi-Fälle in `connectivity_routes_to_the_kimi_code_endpoint_and_normalises_the_key`).

### 3.1 betaclaw-model-hub

| Datei                                   | Test                                                                   | TS-Quelle                                         |
| --------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------- |
| `src/model_hub/codex_auth.rs`           | `reads_the_credentials_from_the_codex_home_auth_file`                  | `codex-auth.test.ts:27`                           |
| `src/model_hub/provider_catalog.rs`     | `oauth_is_offered_only_where_supported`                                | `contract/.../provider-catalog.test.ts:31`        |
| `src/model_hub/providers/kimi.rs`       | `connectivity_routes_to_the_kimi_code_endpoint_and_normalises_the_key` | `connectivity.test.ts:136`, `:165`, `:189`        |
| `src/model_hub/providers/opencode.rs`   | `connectivity_calls_the_models_endpoint_with_the_bearer_key`           | `connectivity.test.ts:101`                        |
| `src/model_hub/providers/refuseless.rs` | `fetch_models_enriches_the_live_entry_without_a_duplicate`             | `refuseless-adapter.test.ts:11`                   |
| `src/model_hub/providers/refuseless.rs` | `fetch_models_keeps_the_supplied_model_when_the_live_list_is_empty`    | `refuseless-adapter.test.ts:29`                   |
| `src/model_hub/providers/refuseless.rs` | `fetch_models_retains_the_model_metadata_on_a_network_failure`         | `refuseless-adapter.test.ts:71`                   |
| `src/model_hub/providers/refuseless.rs` | `dispatch_sends_bearer_auth_with_the_output_cap_and_tools`             | `refuseless-adapter.test.ts:36`                   |
| `src/model_hub/providers/refuseless.rs` | `connectivity_does_not_report_an_invalid_key_as_success`               | `refuseless-adapter.test.ts:61`                   |
| `src/model_hub/runtime.rs`              | `an_empty_key_is_missing_in_development_and_production`                | `runtime-key.test.ts:7`                           |
| `src/model_hub/runtime.rs`              | `the_public_example_is_refused_in_hex_as_well`                         | `runtime-key.test.ts:13`                          |
| `src/model_hub/service/gateway.rs`      | `a_provider_abort_escapes_as_an_aborted_error`                         | `shared/http.ts:45-47` (Verhaltensfix, siehe 4.1) |

### 3.2 betaclaw-master

| Datei                                      | Test                                                             | TS-Quelle                                                               |
| ------------------------------------------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `src/master/delegation/subagent_pool.rs`   | `execute_completes_a_job_without_a_session`                      | `subagent-pool-branches.test.ts:62`                                     |
| `src/master/delegation/subagent_pool.rs`   | `a_failing_task_fails_the_job_and_the_session`                   | `subagent-pool-branches.test.ts:94`                                     |
| `src/master/delegation/subagent_pool.rs`   | `a_failing_task_without_a_session_still_fails_the_job`           | `subagent-pool-branches.test.ts:138`                                    |
| `src/master/delegation/subagent_pool.rs`   | `a_session_cancelled_during_the_task_stays_cancelled_on_success` | `subagent-pool-branches.test.ts:173`, `master-subagent-pool.test.ts:54` |
| `src/master/delegation/subagent_pool.rs`   | `a_session_cancelled_during_the_task_stays_cancelled_on_failure` | `subagent-pool-branches.test.ts:217`                                    |
| `src/master/delegation/dispatcher.rs`      | `a_failing_task_fails_the_job_and_rejects_the_dispatch`          | Verhaltensfix, siehe 4.2                                                |
| `src/master/delegation/dispatcher.rs`      | `the_session_is_created_before_its_job`                          | `master-subagent-session-service.test.ts:130`                           |
| `src/master/delegation/trigger_policy.rs`  | `the_cooldown_is_keyed_by_workspace_scope`                       | `master-delegation-policy.test.ts:107`                                  |
| `src/master/tool_policy/service.rs`        | `target_context_entries_match_the_glob`                          | `tool-policy-service-branches.test.ts:263`                              |
| `src/master/tool_policy/service.rs`        | `wildcard_subject_entries_match_any_action_on_their_host`        | `tool-policy-service-branches.test.ts:297`                              |
| `src/master/tool_policy/service.rs`        | `fingerprint_entries_match`                                      | `tool-policy-service-branches.test.ts:321`                              |
| `src/master/tool_policy/service.rs`        | `blank_allowlist_entries_are_skipped`                            | `tool-policy-service-branches.test.ts:346`                              |
| `src/master/repository/migration_store.rs` | `migrating_a_scope_merges_colliding_rows_by_recency`             | `migration-store-branches.test.ts:138`                                  |
| `src/master/repository/migration_store.rs` | `a_scope_migration_onto_itself_is_a_noop`                        | `migration-store-branches.test.ts:97` (Teil "ignores noop")             |
| `src/master/connectors/gmail/client.rs`    | `maps_nested_html_missing_fields_and_invalid_dates`              | `gmail-client-behavior.test.ts:61`                                      |
| `src/master/connectors/gmail/client.rs`    | `search_results_are_fetched_in_detail`                           | `gmail-client-behavior.test.ts:160`                                     |
| `src/master/connectors/gmail/client.rs`    | `an_omitted_messages_collection_is_an_empty_result`              | `gmail-client-behavior.test.ts:215`                                     |

Nicht neu getestet, weil bereits abgedeckt oder offen: die Gmail-Modusfälle (`it.each` mock/auto) sind über `the_mock_env_flag_forces_mock_mode` und `a_mock_token_sends_and_lists` abgedeckt; die Tool-Loop-Verdrahtung ist offen (Abschnitt 5.2).

## 4. Rust-Fixes

### 4.1 Abbruch eines Providers (model-hub, `service/mod.rs`, `service/gateway.rs`)

- Vorher: Ein Abbruch oder Timeout beim HTTP-Aufruf wurde in `ServiceError::Transport` gewandelt. Der Chat-Pfad zeigte `AI dispatch failed: The operation was aborted`.
- TS: `fetchWithTimeout` (`Models/shared/http.ts:45-47`) reicht den `AbortError` unverändert weiter. Er verlässt `dispatchWithFallback` als geworfener Fehler. `aiDispatcher.ts:41-46` macht daraus `Generation aborted.`
- Fix: neue Variante `ServiceError::Aborted(String)`. `From<HttpError>` bildet `Aborted` und `Timeout` darauf ab (beide sind `AbortError` in Node). Die Anzeige (`Display`) bleibt der bisherige Text, daher ändert sich ohne Gateway-Änderung nichts am sichtbaren Text.
- Klarstellung zum Auftrag: Der Fall `chat.rs:178,401` (`GatewayResponse::failure("Aborted")` vor dem Versuch eines Modells) ist TS-konform. TS gibt dort ebenfalls `error: 'Aborted'` zurück (`service/dispatch/chat.ts:123`), also `AI dispatch failed: Aborted`. Das bleibt unverändert.
- Test: `a_provider_abort_escapes_as_an_aborted_error`.
- **Offen, nicht in meinen Crates:** Die Gateway-Stellen `betaclaw-gateway/src/families/chat_runtime/model.rs` (`.map_err(failed)`) und `families/master/model.rs` müssen `ServiceError::Aborted` auf `PortError::Aborted` abbilden. Erst dann erscheint `Generation aborted.` im Chat. Das ist eine Ein-Zeilen-Änderung in `betaclaw-gateway`, die der Koordinator einplanen sollte.

### 4.2 Fehlschlagende Subagent-Aufgabe (master, `delegation/subagent_pool.rs`, `delegation/dispatcher.rs`, `orchestrator.rs`, `execution/runtime/execution_flow.rs`)

- Vorher: Die Aufgabe war `FnOnce() -> DelegationTaskResult` und konnte nicht fehlschlagen. Schlug ein Capability-Aufruf fehl, wurde der Job als `completed` mit leerer Ausgabe markiert, die Session ebenfalls `completed`. Der Fehler wurde erst danach über `task_error` ausgegeben.
- TS (`subagentPool.ts:78-99`): Job `failed` mit `lastError`, Event `error`, Session `failed`, dann Rethrow. Eine während der Aufgabe abgebrochene Session bleibt `cancelled`, ohne Fehler (`:72-77`).
- Fix: Die Aufgabe liefert `Result<DelegationTaskResult, String>`. `SubagentPool::execute` gibt `SubagentExecuteError::{Storage, Task}` zurück. Der Dispatcher meldet die Fehlermeldung als `reason` (`accepted: false`). Die Ausführungsschicht gibt den Fehler wie bisher weiter. Der Heartbeat wird auch im Fehlerfall gestoppt.
- Abweichung: TS wirft den Fehler bis zum Aufrufer. Rust meldet ihn als Dispatch-Ergebnis. Diese Form ist in `OP-S9-11` (`docs/RUST_MIGRATION.md`) dokumentiert. Die Beschreibung dort ("Fehlerpfad liefert `{ accepted: false, reason }` statt Unwind") passt nur noch für Repository-Fehler. **Der Koordinator sollte OP-S9-11 in `RUST_MIGRATION.md` anpassen.** Ich habe `RUST_MIGRATION.md` nicht geändert.

### 4.3 Lint in `betaclaw-master/src/master/connectors/secret_store.rs`

- Vorbestehende Clippy-Warnungen (Datei unverändert gegenüber HEAD): `chunks_exact` mit konstanter Größe durch eine Indexschleife ersetzt (gleiches Verhalten, verwirft den Rest wie vorher), ungenutzter `use base64::Engine as _` im Testmodul entfernt.

## 5. Nicht portiert, offen

### 5.1 Nicht portiert (mit Begründung)

| TS-Datei / Fall                                                                                       | Begründung                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gateway-core.test.ts`: Fallback "OpenAI-kompatibel ohne Adapter"                                     | Der Katalog hat keinen Eintrag mit `apiBaseUrl` ohne Adapter (S4 hat die letzte Lücke geschlossen). Der Fallback-Zweig in `service/gateway.rs` ist nicht erreichbar, ein Test braucht Katalog-Injektion.                                                      |
| `model-fetcher.test.ts`: Fallback ohne Adapter, Default-Modelle ohne apiBase                          | Gleicher Grund wie oben (`model_fetcher.rs`).                                                                                                                                                                                                                 |
| `gateway-prompt-logging.test.ts`: Kosten (OpenRouter, xAI)                                            | Preise und Schätzung der Prompt-Tokens liegen im Stats-Crate (Observer-Schnittstelle). Die Rust-Seite liefert nur die Rohdaten (`PromptDispatchEvent`), die Quelle `exact`/`estimated` ist getestet.                                                          |
| `service-core.test.ts`: Wrapper list/get/update/delete                                                | Reine Weiterleitung ohne Logik. Das Verhalten steckt im Repository (`sqlite.rs`: `list_accounts_is_newest_first`, `delete_account_cascades_to_the_pipeline`, `health_status_round_trips_the_null_and_boolean_states`).                                        |
| `runtime-modularization-contract.test.ts` (2)                                                         | Architekturtest über TS-Dateiimporte. Fällt mit dem TS-Code weg.                                                                                                                                                                                              |
| `master-subagent-pool.test.ts`: "renews session heartbeat while long-running work is still executing" | Die periodischen Ticks laufen über den Scheduler-Seam (`OP-S9-11`, `subagent_pool.rs` Modulkopf). Die Synchronisation vor der Aufgabe und das Stoppen nach der Aufgabe sind getestet (`execute_completes_the_job_and_the_session` zählt Schedule und Cancel). |

### 5.2 Offen (mit Grund)

Alle offenen Fälle liegen in Crates, die nicht zu meinem Auftrag gehören. Die Routen-Tests liegen in `betaclaw-gateway`, Mission-Control in `betaclaw-features` und `betaclaw-gateway`.

- **Graphiti-Route (7 offen):** `integration/model-hub/graphiti-adapter-route.test.ts`. Gegenstück: `betaclaw-gateway/src/families/ops_wire/internal.rs`. Offen sind: Dispatch mit Tool-Calls im OpenAI-Format, Antwort ohne Usage, 502-Mapping bei Provider-Fehler, fehlendes Token (nur für den Ingest-Pfad getestet), die Varianten "Basic"/leerer Bearer, case-insensitive Schema mit Trim (bereits in Audit 4.8 offen), optionale Parameter ungültig. Vorhanden und abgedeckt: aktive Pipeline 503, Endpunkte nur `/chat/completions`, Body kein JSON.
- **master, Integrationsroute (3 offen):**
  - `master-actions-execution-route`: Export des Ergebnisbündels nicht in den Gateway-Tests gefunden.
  - `master-feedback-route`: Validierung des Ratings nicht in Gateway-Tests benannt (Fall "nicht abgeschlossener Run" und "abgeschlossener Run" abgedeckt).
  - `master-runtime-tool-loop`: Verdrahtung des Leases während eines Tool-Laufs. Die Lease-Semantik ist in `runs_store.rs` getestet, die Verdrahtung nicht.
- **master, Unit (2 offen):**
  - `master-runtime-persona-config`, Fall 1: Der Planer-Pfad ist neu getestet (`the_planner_uses_the_persona_profile_and_system_instruction`). Der Codegen-Pfad mit Persona-Systeminstruktion ist nicht geprüft.
  - `gmail-route-world-model`, Fall 1: Der Bridge-Aufruf mit Receipt liegt in `betaclaw-world-model` (S6), nicht in meinen Crates.
- **mission-control (12 offen):** Gegenstücke in `betaclaw-features/src/tasks/...` und `betaclaw-gateway` (Tasks-Route, Planung, Dispatch, Workspace-Zugriff). Nur "AI dispatch failed" ist abgedeckt (`betaclaw-features/src/tasks/dispatch/failure.rs`). Diese Domäne muss beim Koordinator oder einer Agentin für `betaclaw-features`/`betaclaw-gateway` geprüft werden.

## 6. Prüfungen

Alle Befehle auf dem Host, einmal ausgeführt.

| Prüfung          | Befehl                                                                               | Ergebnis                                                                                                                                                                                                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Format           | `cargo fmt --manifest-path rust/Cargo.toml -p betaclaw-model-hub -p betaclaw-master` | Exit 0                                                                                                                                                                                                                                                                                                                                                     |
| Clippy model-hub | `cargo clippy --manifest-path rust/Cargo.toml -p betaclaw-model-hub --all-targets`   | Keine Warnungen im Crate. Warnungen nur in `betaclaw-base` (`auth/limiter.rs:97`, `config.rs:260`), fremde Arbeit. Mit `-- -D warnings` schlägt der Lauf deshalb in `betaclaw-base` fehl.                                                                                                                                                                  |
| Clippy master    | `cargo clippy --manifest-path rust/Cargo.toml -p betaclaw-master --all-targets`      | Keine Warnungen im Crate, nach 4.3. Warnungen nur in `betaclaw-base`.                                                                                                                                                                                                                                                                                      |
| Tests model-hub  | `cargo test --manifest-path rust/Cargo.toml -p betaclaw-model-hub`                   | **565 bestanden, 0 fehlgeschlagen, 0 ignoriert.**                                                                                                                                                                                                                                                                                                          |
| Tests master     | `cargo test --manifest-path rust/Cargo.toml -p betaclaw-master`                      | **348 bestanden, 1 fehlgeschlagen:** `master::workspace_scope::tests::resolve_like_node_collapses_dot_segments` (`workspace_scope.rs:324`). Die Datei ist gegenüber HEAD unverändert. Der Test erwartet `/x` für einen absoluten Pfad, Windows liefert `E:\x`. Vorbestehend und plattformabhängig, nicht geändert. Doc-Tests liefen nach dem Fehler nicht. |

Tests mit `cfg(unix)` in meinen Crates: keine gefunden, also keine übersprungen.

## 7. Was die TS-Löschung in Phase 5 noch blockiert

1. Die 24 offenen Fälle (Abschnitt 5.2), vor allem die Routentests. Sie brauchen Tests in `betaclaw-gateway` und `betaclaw-features`.
2. Der Gateway-Mapping-Schritt für `ServiceError::Aborted` (Abschnitt 4.1).
3. OP-S9-11 in `docs/RUST_MIGRATION.md` an den neuen Stand anpassen (Abschnitt 4.2).
4. Die Fallzahlen weichen von der Tabelle in `TS_TEST_COVERAGE_AUDIT.md` ab (model-hub 106 statt 103, master 102 statt 101). Der Koordinator sollte die Tabelle mit dieser Zählung abgleichen.
