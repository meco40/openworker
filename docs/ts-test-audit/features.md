# Abgleich TS-Tests mit Rust: Domänen `features` (Schritt 2.3)

Stand: 2026-10-31 · Crate: `rust/crates/betaclaw-features` · Plan: `docs/TS_BACKEND_REMOVAL_PLAN.md`, Phase 2.3
Methode: `docs/TS_TEST_COVERAGE_AUDIT.md`, Abschnitt 1 und 4. Die Tabelle `TS_TEST_COVERAGE_AUDIT.md` ist nicht geändert; der Koordinator übernimmt die Zahlen.

## 1. Umfang und Zählweise

| TS-Quelle (Tests)                                                 | Dateien |   Fälle |
| ----------------------------------------------------------------- | ------: | ------: |
| `tests/unit/agent-room` (nur Dateien mit `@/server`)              |      10 |     139 |
| `tests/unit/agents`                                               |       1 |      19 |
| `tests/unit/automation` und `tests/integration/automation`        |      12 |      68 |
| `tests/unit/clawhub` und `tests/integration/clawhub`              |       8 |      49 |
| `tests/unit/agent-v2`                                             |       6 |      36 |
| `tests/unit/server/tasks` (nur der Tasks-Teil der Zeile „server“) |       4 |      63 |
| `tests/unit/refactor` (nur Dateien mit `@/server`)                |       6 |      13 |
| **Summe**                                                         |  **47** | **387** |

- Gezählt werden `it(`/`test(`-Blöcke. Ein `it.each` zählt als ein Block.
- Die Zeile „server“ im Audit umfasst auch `sqlite.test.ts`, `summaryService-perf.test.ts` und `proactive/runtime.test.ts`. Diese drei sind nicht Teil dieses Dokuments.
- Abweichung zum Audit: Die Übersicht nennt für `agent-v2` 31 Fälle. Gezählt habe ich 36 Blöcke (Namen aus den Dateien). Die Zählregel des Audits ist nicht nachvollziehbar, deshalb nehme ich meine Zahl. Bitte beim Zusammenführen prüfen.
- Vergleich Fall für Fall über Testnamen und Verhalten. Bei Rust-Tests wurden die Testkörper gelesen, soweit sie den Fall prüfen. Fälle, die nur einen Mock-Aufruf oder SQL-Text prüfen, zählen nach dem Verhalten, das Rust prüfen müsste.
- Gateway-Gegenstücke (`betaclaw-gateway`) habe ich gelesen, aber nicht geändert. Sie stehen in der Spalte „davon Gateway“.

## 2. Ergebnis je Domäne

| Domäne                               | TS-Fälle | abgedeckt | davon Gateway |     neu | nicht portiert | offen |
| ------------------------------------ | -------: | --------: | ------------: | ------: | -------------: | ----: |
| agent-room                           |      139 |        23 |             0 |      79 |             37 |     0 |
| agents                               |       19 |         2 |             0 |      17 |              0 |     0 |
| automation                           |       68 |        32 |             5 |      26 |              4 |     6 |
| clawhub                              |       49 |        27 |            10 |      20 |              2 |     0 |
| agent-v2                             |       36 |         4 |             0 |       0 |             32 |     0 |
| tasks (Tasks-Teil von `unit/server`) |       63 |        35 |            11 |      11 |             14 |     3 |
| refactor                             |       13 |         0 |             0 |       0 |             13 |     0 |
| **Summe**                            |  **387** |   **123** |        **26** | **153** |        **102** | **9** |

Die Spalte „davon Gateway“ ist in „abgedeckt“ enthalten. Die 9 offenen Fälle liegen alle im Gateway (Abschnitt 6).

## 3. Rust-Änderungen

- Keine Verhaltensänderung am Rust-Code. Es wurde keine Abweichung gefunden, bei der die TS-Soll-Regel gilt und Rust falsch ist. Geändert wurden nur `#[cfg(test)]`-Module.
- `cargo fmt -p betaclaw-features` lief über die geänderten Dateien.

## 4. Neue Rust-Tests (97 Funktionen)

Alle neuen Tests stehen im Modul, das die TS-Quelle portiert (Modulkopf nennt die TS-Datei).

**agent-room**

- `agent_room/services/agent_session.rs`: `parse_keeps_session_entries_in_order_and_skips_speakers`, `a_persona_without_a_session_is_not_found`, `a_session_for_a_new_persona_is_appended`, `no_speaker_without_a_buffer_an_empty_buffer_or_a_speaker_entry`
- `agent_room/prompt/speaker_selector.rs`: `two_personas_alternate_and_a_lone_lead_always_speaks`, `without_a_phase_or_with_an_unknown_one_every_persona_takes_equal_turns`, `each_phase_gives_its_role_more_turns`, `the_lead_is_boosted_in_the_result_phase`
- `agent_room/prompt/phase_service.rs`: `turns_required_is_rounds_times_agents`, `a_phase_stays_open_until_every_agent_has_spoken`, `critique_runs_three_rounds_before_best_case`, `the_result_phase_completes_the_swarm`, `the_turn_cap_is_checked_by_count_only`, `a_value_inside_the_range_is_used_as_given`
- `agent_room/prompt/text_utils.rs`: `a_duplicated_speaker_label_on_one_line_counts_as_one_turn`, `phase_markers_are_not_turns_and_empty_text_has_none`, `without_markers_every_turn_is_in_the_current_phase`, `every_leading_label_form_is_stripped`
- `agent_room/prompt/turn_prompt.rs`: `research_turns_point_the_agent_at_web_search_and_source_urls`
- `agent_room/services/conflict_radar.rs`: `text_without_any_signal_is_quiet`, `a_single_english_risk_keyword_scores_25`, `a_single_german_risk_keyword_scores_25`, `two_risk_signals_reach_medium`, `a_down_vote_is_a_severe_signal`, `risk_and_severe_signals_combine_to_high`, `confidence_is_capped_at_100`, `only_the_text_after_the_last_marker_is_analyzed`, `nothing_after_the_last_marker_is_quiet`, `excerpts_are_cut_at_120_characters`, `hold_is_never_set`
- `agent_room/services/swarm_artifact.rs`: `text_within_the_limit_is_returned_unchanged`, `clamping_keeps_the_tail`, `snapshots_append_skip_blanks_and_keep_non_consecutive_repeats`, `history_keeps_the_last_24_snapshots`, `consensus_score_is_rounded_and_clamped_to_0_100`, `the_first_turn_opens_the_phase_and_later_turns_append`, `a_multi_turn_run_with_a_phase_change_builds_the_expected_artifact`, `a_long_artifact_is_clamped_after_appending`
- `agent_room/services/turn_completion.rs`: `the_lookup_takes_the_first_terminal_event_of_the_command`, `the_completed_text_comes_from_the_first_known_field`, `no_known_text_field_gives_an_empty_string`
- `agent_room/swarm_phases.rs`: `labels_are_unique_and_fit_the_marker_format`, `rounds_are_one_except_ideation_and_critique`

**agents**

- `agents/subagent_registry.rs`: `a_missing_invalid_or_mismatched_store_loads_as_empty`, `records_missing_a_required_field_are_dropped_on_load`, `updates_for_an_unknown_run_return_none`, `a_failed_run_is_an_error_unless_it_was_already_killed`, `aborting_without_a_runtime_marks_the_run_killed_and_reports_false`, `running_runs_are_active_and_finished_runs_are_recent`, `the_recent_window_is_at_least_one_minute_and_excludes_older_runs`, `count_active_counts_only_running_runs_of_the_conversation`, `listings_return_only_the_runs_of_the_given_conversation`

**automation**

- `automation/service.rs`: `create_rule_rejects_an_unknown_timezone_and_a_bad_cron_expression`, `an_explicit_next_run_is_kept_and_a_disabled_rule_has_none`, `updating_an_unknown_rule_returns_none`, `enabling_a_rule_clears_its_last_error_and_schedules_it`, `manual_runs_need_a_known_rule_and_are_marked_manual`, `metrics_count_rules_and_runs_and_report_the_lease_age`, `a_rule_without_a_flow_graph_has_none_and_an_unknown_rule_has_none`, `a_queued_run_whose_rule_is_gone_is_dead_lettered`, `a_dead_letter_below_the_pause_threshold_keeps_the_rule_enabled`, `a_success_after_a_dead_letter_resets_the_failure_counter`, `a_retry_is_due_after_its_configured_backoff`
- `automation/sqlite_repository/mod.rs`: `unknown_ids_give_none_or_false`, `a_saved_flow_graph_is_read_back_and_a_legacy_rule_has_none`, `a_corrupt_stored_flow_graph_reads_as_none`
- `automation/commands.rs`: `list_resume_remove_and_run_take_their_arguments`, `an_every_command_with_an_out_of_range_interval_is_unsupported`
- `automation/executor.rs`: `the_runner_summary_is_returned_for_the_user_and_prompt`, `a_missing_or_zero_timeout_uses_the_default_instead_of_cutting_the_run`
- `automation/flow_compiler.rs`: `a_skill_step_names_the_skill_and_carries_its_parameters`
- `automation/flow_validator.rs`: `a_second_trigger_is_rejected`, `a_manual_trigger_needs_no_schedule`

**clawhub**

- `clawhub/service.rs`: `search_clamps_the_limit_and_trims_the_query`, `explore_parses_json_and_defaults_the_sort_to_newest`, `explore_without_json_output_gives_an_empty_list`, `install_without_force_omits_the_flag`, `update_passes_the_version_and_force_for_all_and_for_one_slug`, `an_invalid_update_slug_never_reaches_the_cli`, `uninstall_removes_only_the_row_when_nothing_else_exists`, `uninstall_removes_only_the_directory_when_nothing_else_exists`, `without_a_lockfile_sync_returns_the_table_as_it_is`, `an_unreadable_lockfile_leaves_the_table_alone`, `an_empty_skills_object_in_the_lockfile_clears_the_table`, `the_slug_is_the_title_when_the_skill_has_no_meta_title`, `set_enabled_turns_a_skill_on_and_off`, `a_skills_value_that_is_not_an_object_leaves_the_table_alone`, `sync_removes_rows_that_are_not_in_the_lockfile_and_skips_unsafe_slugs`
- `clawhub/cli.rs`: `a_missing_binary_and_npx_fall_back_to_npm_exec`, `the_launchers_next_to_the_executable_are_the_last_resort`
- `clawhub/prompt_builder.rs`: `only_enabled_skills_appear_in_the_block`

**tasks**

- `tasks/repository.rs`: `list_narrows_by_status_business_workspace_and_agent_newest_first`, `get_returns_the_task_or_not_found`, `an_update_changes_the_fields_and_reports_the_previous_title`, `deleting_an_unknown_task_is_not_found`
- `tasks/workspace.rs`: `an_invalid_created_at_is_replaced_by_the_current_time`, `every_reserved_character_becomes_an_underscore`

## 5. Nicht portiert, mit Begründung

**agent-room: 37 Fälle**

- `frontend-utils.test.ts` (30): Hilfsfunktionen der UI (`modules/agent-room/utils`: Artefakt-Kürzung, Fehlerklassifikation, Replay-Reducer, Diff). Kein Backend-Verhalten. Die Datei importiert `@/server/agent-v2/types` nur als Typ. Vor Phase 5 auf einen Shared-Typ umhängen, dann ist die Datei nicht mehr Teil der Löschliste.
- `artifact-phase-markers.test.ts` (4): Zeilen-Parser und Label-Zuordnung der UI (`modules/agent-room/agentTurnParser`), Fallback ohne Marker. Das Backend zählt Turns nur über die Zählfunktion; dieser Teil ist in den neuen Tests abgedeckt. Die Datei hat außerdem einen dynamischen Import von `countStructuredTurns` aus `@/server`. Vor Phase 5 umhängen.
- `conflict-radar-service.test.ts` (2): „null-ish input“ (JavaScript-Umwandlung, Rust nimmt `&str`), „updatedAt als ISO-Zeitstempel“ (Rust-Funktion ist rein, der Zeitpunkt kommt vom Aufrufer).
- `swarm-artifact-service.test.ts` (1): „null-ish input“ bei `clampArtifact` (gleiche Begründung).

**automation: 4 Fälle**

- `executor.test.ts` (2): „aborts the underlying runPrompt signal on timeout“ und „maps timeout-triggered abort errors“. Rust bricht durch Verwerfen des Futures ab (dokumentiert in `executor.rs`). AbortSignal und AbortController-Mock gibt es in Rust nicht.
- `flowTypes.test.ts` (1): „version must be 1“ prüft ein TS-Literaltyp, kein Laufzeitverhalten.
- `runtime-singleton.test.ts` (1): „uses existing global runtime instance“. Node-Modul-Singleton; Rust hält die Instanz im Anwendungszustand.

**clawhub: 2 Fälle**

- `clawhub-service-branches` „uses default limit 25 for non-numeric“: Rust nimmt `i64`, die Umwandlung passiert in der Route.
- `clawhub-service-branches` „returns the container-managed instance“: TS-DI-Singleton (`getClawHubService`).

**agent-v2: 32 Fälle, Entscheidung offen**
Rust portiert nur Persistenz und Signatur (`agent_v2/mod.rs`). Diese Teile fehlen:

- `execute.test.ts` (7): `commands/execute.ts` ist nicht portiert (Modulkopf `session/commands/mod.rs`). Der Ausführungspfad hängt an dem Channel-Dienst (S8).
- `extensions-host.test.ts` (7) und `worker-host-behavior.test.ts` (11): Extension-Host-Laufzeit (`extensions/host.ts`, `workerHost.ts`). Nicht portiert, Entscheidung offen, wie vom Auftrag vorgegeben.
- `session-manager-behavior.test.ts` (5): Klasse `AgentV2SessionManager` mit `processQueue`, Hooks und Ereignis-Broadcast. Nicht portiert (Modulkopf `session/mod.rs`).
- `session-manager-persona.test.ts` (2): Persona-Bindung bei Session-Erstellung (`state/create.ts`, S8). Nicht portiert.
  Entscheidung nötig: diese Laufzeit portieren oder streichen. Bis dahin sind die sechs Dateien nicht löschbar, außer `repository.test.ts` (Abschnitt 2).

**tasks: 14 Fälle**

- `autoTesting.test.ts` (10): Standard über `NODE_ENV` (2), Log-Level für fehlende Tasks und lokale Abbrüche (2), Node-Abbruchklassifikation mit `ECONNABORTED`, `ABORT_ERR`, „socket hang up“, `cause.code` und Nicht-Objekt-Fehlern (6). Rust hat keine Umgebungs-Standardregel dieser Art und keine Node-Fehlerklassifikation.
- `taskService.test.ts` (3): „TaskNotFoundError has correct properties“, „TaskForbiddenError …“, „TaskNoUpdatesError …“. Rust-Fehler sind Enum-Varianten (`TaskError`), die Statuszuordnung liegt im Gateway.
- `taskWorkspace.test.ts` (1): „uses deterministic workspace root in production mode“. Die Pfadwahl hängt an `NODE_ENV`. Rust liest den Pfad über `resolve_root()` aus der Umgebung; ein Test dafür wäre umgebungsabhängig.

**refactor: 13 Fälle**
Alle 13 Fälle lesen TS-Quelltext als Text und prüfen seine Struktur (`read('src/server/...')`, `toContain(...)`). Sie prüfen kein Verhalten. Rust hat dafür kein Gegenstück; die Fälle fallen mit dem TS-Code weg. Die Architektur-Guards in Phase 5 entscheiden über die Behandlung.

## 6. Offen (Gateway, nicht in diesem Crate)

Diese Fälle liegen im Gateway. Der Auftrag beschränkt Änderungen auf `betaclaw-features`. Der Koordinator muss sie einem Gateway-Auditor zuweisen.

- `automation/runtime-class.test.ts`:
  - „logs errors when processTick fails and keeps runtime alive“: Test für Fehler im Tick fehlt in `scheduler_runtime.rs`.
  - „starts once, schedules interval with unref, and stops cleanly“: Doppelstart-Schutz fehlt im Test. `unref` ist Node-Detail.
- `automation/runtime-singleton.test.ts`:
  - „default runPrompt uses default conversation, truncates summary, and handles abort“: Standard-Prompt-Runner im Gateway, Kürzung der Zusammenfassung nicht getestet.
- `integration/automation/automations-routes.test.ts`:
  - „returns 401 when REQUIRE_AUTH is true and no session exists“
  - „keeps automation auth behavior independent of chat session flag“
  - „returns 401 for GET /api/automations/metrics when auth is required and session is missing“
    Auth-Regeln für Automations-Routen sind in `families/tasks/automations.rs` nicht getestet.
- `tests/unit/server/tasks/workspaceCleanupRuntime.test.ts`:
  - „runs startup cleanup and interval cleanup when enabled“
  - „does nothing when runtime is disabled“
  - „returns an empty report if cleanup run fails“
    Der Schalter ist in `workspace_cleanup.rs` getestet (`test_parse_enabled_table`), der Lauf von Start und Intervall nicht.

Gateway-Gegenstücke, die ich als abgedeckt gezählt habe (Namen gelesen, Assertions stichprobenartig):

- `automation/runtime-class.test.ts`: „returns early when scheduler lease is not acquired“ → `automation_runtime_acquires_lease_runs_tick_and_releases_on_stop` (`scheduler_runtime.rs`).
- `automation/runtime-singleton.test.ts`: „creates singleton service/runtime and parses retry backoff from env“ → `automation_runtime_options_parse_custom_environment`.
- `integration/automation/automations-routes.test.ts`: CRUD, Limits, Metriken → `families/tasks/automations.rs`.
- `clawhub-routes.test.ts`: alle 10 Fälle → `families/skills_wire/clawhub.rs`, inklusive 401 (Zeile 532) und 404 (Zeilen 389, 433).
- `autoTesting.test.ts` (Parser-Fälle „false“, „0“, „off“, „on“, „yes“, unbekannter Wert) → `workspace_cleanup::parse_boolean` (`test_parse_boolean_env`). Die Funktion ist dieselbe Tabelle; die TS-Funktion ist eine andere Umgebungsvariable.
- `workspaceCleanupRuntime.test.ts` (Parser, Intervall, Fallback) → `test_parse_boolean_env`, `test_resolve_interval_ms`.

## 7. Blocker für das Löschen der TS-Tests in Phase 5

1. Drei UI-nahe Dateien importieren `@/server` nur für Typen oder einen dynamischen Import: `frontend-utils.test.ts`, `completion-text.test.ts`, `artifact-phase-markers.test.ts`. Vor Phase 5 umhängen, nicht löschen. Bei `completion-text.test.ts` ist der Backend-Fall in Rust abgedeckt (`the_completed_text_comes_from_the_first_known_field`). Der Test prüft aber die UI-Funktion `extractCommandCompletionText`, die weiter existiert. Löschen würde deren Test entfernen.
2. `agent-v2`: 32 Fälle ohne Rust-Gegenstück (Abschnitt 5). Entscheidung portieren oder streichen, bevor die Dateien `execute`, `extensions-host`, `worker-host-behavior`, `session-manager-behavior`, `session-manager-persona` gelöscht werden.
3. `automation` (6 Gateway-Fälle) und `tasks` (3 Gateway-Fälle) sind offen, bis der Gateway-Audit sie prüft.
4. `refactor`: keine Blocker; die Dateien prüfen TS-Quelltext und fallen mit dem TS-Code weg. Die Architektur-Guards aus Phase 5 müssen dazu passen.

## 8. Prüfungen

- `cargo fmt --manifest-path rust/Cargo.toml -p betaclaw-features`: Exit 0.
- `cargo clippy --manifest-path rust/Cargo.toml -p betaclaw-features --all-targets -- -D warnings`: Ergebnis siehe Abschnitt 9.
- `cargo test --manifest-path rust/Cargo.toml -p betaclaw-features`: Ergebnis siehe Abschnitt 9.
- Das Crate hat kein `test-support`-Feature. Keine der neuen Tests ist `cfg(unix)`-gebunden.

## 9. Ergebnis der Gates (Host, Windows)

| Gate                     | Befehl                                                                            | Ergebnis                                                                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Format                   | `cargo fmt --manifest-path rust/Cargo.toml -p betaclaw-features`                  | bestanden (Exit 0)                                                                                                                                    |
| Clippy                   | `cargo clippy --manifest-path rust/Cargo.toml -p betaclaw-features --all-targets` | Exit 0. Eine Warnung in `proactive/service.rs:161` (`sort_by_key`), nicht aus diesem Schritt.                                                         |
| Clippy mit `-D warnings` | `... -- -D warnings`                                                              | nicht bestanden, bricht in `betaclaw-base` ab (`clamped.max(BASE)`, `match` durch `?`). Das ist außerhalb dieses Crates und nicht aus diesem Schritt. |
| Tests                    | `cargo test --manifest-path rust/Cargo.toml -p betaclaw-features`                 | 310 bestanden, 2 fehlgeschlagen, 0 ignoriert                                                                                                          |

Die zwei fehlgeschlagenen Tests existieren unverändert in `HEAD` (`clawhub/cli.rs`):

- `clawhub::cli::tests::when_nothing_exists_the_last_missing_error_is_returned` (Zeile 415 in HEAD): erwartet `"/node/bin/pnpm"`. Windows baut den Pfad mit `\`, Ergebnis `"/node/bin\\pnpm"`.
- `clawhub::cli::tests::a_cmd_launcher_that_cannot_spawn_is_run_through_comspec` (Zeile 433 in HEAD): erwartet `"/node/bin/npx.cmd"`, Ergebnis `"/node/bin\\npx.cmd"`.

Beide sind Pfadtrennzeichen-Annahmen von Linux. Sie laufen im Container-Gate unter Linux. Ich habe sie nicht geändert, weil die Regel lautet, Rust-Tests nicht abzuschwächen. Der Koordinator entscheidet, ob sie plattformunabhängig formuliert werden.

Ein neuer Test brauchte eine Korrektur: Die Löschung einer Regel über `delete_rule` entfernt auch ihre Läufe (Cascade). Der TS-Fall „Lauf ohne Regel wird Dead-Letter“ ist deshalb in der Test-Fassung `a_queued_run_whose_rule_is_gone_is_dead_lettered` über eine Datei-Datenbank nachgebildet, bei der die Regelzeile per SQL ohne Cascade entfernt wird. Der Test läuft grün.

Neue Tests: 97 Funktionen (Abschnitt 4), alle grün.
