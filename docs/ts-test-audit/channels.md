# Abgleich TS-Tests mit Rust-Tests: channels, telegram, top-level (Teil), summary

Stand: 2026-11-01 · Plan: `docs/TS_BACKEND_REMOVAL_PLAN.md`, Phase 2.3 · Methode: `docs/TS_TEST_COVERAGE_AUDIT.md`, Abschnitt 1

Dieses Dokument deckt die Domänen ab, die dem Audit für `betaclaw-channels` zugewiesen sind:

- **channels:** `tests/unit/channels` (77 Dateien, 331 Fälle) und `tests/integration/channels` (8 Dateien, 24 Fälle). Zusammen 85 Dateien, 355 Fälle. Diese Zahl stimmt mit der Domänen-Übersicht in `TS_TEST_COVERAGE_AUDIT.md`, Abschnitt 2, überein.
- **telegram:** `tests/unit/telegram` (3 Dateien, 15 Fälle).
- **top-level (Teil):** `tests/messageRouter.test.ts` (12), `tests/telegram-chunking.test.ts` (7), `tests/channels-pair-route.test.ts` (6). Zusammen 25 Fälle.
- **server (Summary):** `tests/unit/server/summaryService-perf.test.ts` (24 Fälle).

Gesamt: **92 Dateien, 419 Fälle**. Gezählt wie im Audit: jeder `it(`/`test(`-Block zählt einmal, `it.each` zählt als ein Block.

Nicht hier, weil sie zu anderen Domänen gehören: `tests/unit/gateway/channels-methods.test.ts` (gateway), `tests/unit/knowledge/conversation-summary-prompts.test.ts` (knowledge), `tests/unit/world-model/proactive-channel-delivery.test.ts` (world-model). Die Datei `tests/unit/channels/webhook-parsing.test.ts` importiert kein `@/server` und fällt nicht unter Phase 5.

Begriffe in den Tabellen:

- **abgedeckt:** Ein bestehender Rust-Test prüft dasselbe Verhalten.
- **neu:** Der Rust-Test wurde in diesem Schritt ergänzt (Namen in Abschnitt 4).
- **nicht portiert:** Bewusster Verzicht mit Begründung in Abschnitt 5.
- **offen:** Kein Gegenstück gefunden oder Zuständigkeit bei einem anderen Crate. Gründe in Abschnitt 6.

## 1. Ergebnis

| Ergebnis       |   Fälle |
| -------------- | ------: |
| abgedeckt      |     170 |
| neu            |      45 |
| nicht portiert |       1 |
| offen          |     203 |
| **Summe**      | **419** |

Die Zahl „offen“ ist hoch. Das ist ein Befund, keine Rechenlücke. Die Logik des Kanal-Pakets ist weitgehend geprüft. Der größte Teil der offenen Fälle liegt in Modulen **außerhalb von `betaclaw-channels`** (Store, Gateway, Knowledge, Inbox), oder es fehlt ein Rust-Gegenstück (Funktionsunterschied). Abschnitt 6 gruppiert die offenen Fälle nach Grund.

Für Phase 5 gilt: Die TS-Tests dieser Domänen dürfen **noch nicht** gelöscht werden. Abschnitt 7 nennt die Blocker.

Auf Assert-Ebene wurden nur die Fälle geprüft, die in `betaclaw-channels` liegen. Fälle, die nur über den Testnamen in anderen Crates zugeordnet sind, wurden nicht auf Assert-Ebene verglichen. Das ist in Abschnitt 3 vermerkt.

## 2. Ergebnis je TS-Datei

Spalten: Fälle (Blöcke), abgedeckt, neu, nicht portiert, offen.

| TS-Datei                                                                     |   Fälle | abgedeckt |    neu | nicht portiert |   offen |
| ---------------------------------------------------------------------------- | ------: | --------: | -----: | -------------: | ------: |
| `tests/integration/channels/inbox-route.test.ts`                             |      11 |         0 |      0 |              0 |      11 |
| `tests/integration/channels/message-delete-route.test.ts`                    |       1 |         1 |      0 |              0 |       0 |
| `tests/integration/channels/pairing-router.test.ts`                          |       1 |         1 |      0 |              0 |       0 |
| `tests/integration/channels/persona-isolation-routes.test.ts`                |       2 |         2 |      0 |              0 |       0 |
| `tests/integration/channels/project-delete-conversation-delete-flow.test.ts` |       1 |         1 |      0 |              0 |       0 |
| `tests/integration/channels/state-route.test.ts`                             |       3 |         3 |      0 |              0 |       0 |
| `tests/integration/channels/telegram-chatdelete-webhook.test.ts`             |       2 |         1 |      0 |              0 |       1 |
| `tests/integration/channels/whatsapp-accounts-route.test.ts`                 |       3 |         3 |      0 |              0 |       0 |
| `tests/messageRouter.test.ts`                                                |      12 |         7 |      0 |              0 |       5 |
| `tests/telegram-chunking.test.ts`                                            |       7 |         4 |      3 |              0 |       0 |
| `tests/channels-pair-route.test.ts`                                          |       6 |         5 |      1 |              0 |       0 |
| `tests/unit/channels/adapter-registry.test.ts`                               |       2 |         0 |      0 |              0 |       2 |
| `tests/unit/channels/adapter-types.test.ts`                                  |       3 |         3 |      0 |              0 |       0 |
| `tests/unit/channels/agent-room-queries-branches.test.ts`                    |       3 |         0 |      0 |              0 |       3 |
| `tests/unit/channels/agent-room-queries.test.ts`                             |       3 |         0 |      0 |              0 |       3 |
| `tests/unit/channels/ai-dispatcher-summary-refresh.test.ts`                  |       2 |         0 |      0 |              0 |       2 |
| `tests/unit/channels/ai-dispatcher-tool-loop.test.ts`                        |       4 |         4 |      0 |              0 |       0 |
| `tests/unit/channels/ai-dispatcher-tools-disabled.test.ts`                   |       1 |         0 |      0 |              0 |       1 |
| `tests/unit/channels/attachment-consistency.test.ts`                         |       2 |         0 |      0 |              0 |       2 |
| `tests/unit/channels/attachment-health-monitor.test.ts`                      |       3 |         0 |      0 |              0 |       3 |
| `tests/unit/channels/attachments.test.ts`                                    |       4 |         2 |      0 |              0 |       2 |
| `tests/unit/channels/auto-memory.test.ts`                                    |      10 |         0 |      0 |              0 |      10 |
| `tests/unit/channels/bridge-accounts.test.ts`                                |       4 |         4 |      0 |              0 |       0 |
| `tests/unit/channels/channel-bindings-repository.test.ts`                    |       2 |         0 |      0 |              0 |       2 |
| `tests/unit/channels/context-builder.test.ts`                                |       2 |         1 |      0 |              0 |       1 |
| `tests/unit/channels/credential-store.test.ts`                               |       8 |         1 |      0 |              0 |       7 |
| `tests/unit/channels/health-monitor.test.ts`                                 |       1 |         0 |      0 |              0 |       1 |
| `tests/unit/channels/imessage-branches.test.ts`                              |       4 |         0 |      4 |              0 |       0 |
| `tests/unit/channels/inbound-normalizers.test.ts`                            |       4 |         0 |      0 |              0 |       4 |
| `tests/unit/channels/message-repository-fts.test.ts`                         |      20 |         0 |      0 |              0 |      20 |
| `tests/unit/channels/message-repository-migration.test.ts`                   |       2 |         0 |      0 |              0 |       2 |
| `tests/unit/channels/message-repository-search-delegation.test.ts`           |       1 |         0 |      0 |              0 |       1 |
| `tests/unit/channels/message-repository-user-scope.test.ts`                  |       2 |         0 |      0 |              0 |       2 |
| `tests/unit/channels/message-repository.test.ts`                             |      18 |         0 |      0 |              0 |      18 |
| `tests/unit/channels/message-service-auto-session-memory.test.ts`            |       3 |         0 |      0 |              0 |       3 |
| `tests/unit/channels/message-service-delete-conversation.test.ts`            |       2 |         2 |      0 |              0 |       0 |
| `tests/unit/channels/message-service-inbox-fallback.test.ts`                 |       5 |         0 |      0 |              1 |       4 |
| `tests/unit/channels/message-service-knowledge-recall.test.ts`               |      13 |         8 |      0 |              0 |       5 |
| `tests/unit/channels/message-service-memory-recall.test.ts`                  |       5 |         5 |      0 |              0 |       0 |
| `tests/unit/channels/message-service-memory-trigger.test.ts`                 |       5 |         5 |      0 |              0 |       0 |
| `tests/unit/channels/message-service-modules.test.ts`                        |       4 |         2 |      0 |              0 |       2 |
| `tests/unit/channels/message-service-proactive-gate.test.ts`                 |       1 |         0 |      0 |              0 |       1 |
| `tests/unit/channels/message-service-project-approval-command.test.ts`       |       3 |         3 |      0 |              0 |       0 |
| `tests/unit/channels/message-service-project-command.test.ts`                |       6 |         4 |      0 |              0 |       2 |
| `tests/unit/channels/message-service-project-guard.test.ts`                  |       3 |         3 |      0 |              0 |       0 |
| `tests/unit/channels/message-service-project-workspace-cwd.test.ts`          |       3 |         1 |      0 |              0 |       2 |
| `tests/unit/channels/message-service-roleplay-tools-disabled.test.ts`        |       2 |         1 |      0 |              0 |       1 |
| `tests/unit/channels/message-service-shell-command.test.ts`                  |       4 |         3 |      0 |              0 |       1 |
| `tests/unit/channels/message-service-subagents.test.ts`                      |       4 |         4 |      0 |              0 |       0 |
| `tests/unit/channels/message-service-summary.test.ts`                        |       3 |         1 |      0 |              0 |       2 |
| `tests/unit/channels/message-service-tool-approval.test.ts`                  |       1 |         1 |      0 |              0 |       0 |
| `tests/unit/channels/message-service-webchat-tools.test.ts`                  |       2 |         1 |      0 |              0 |       1 |
| `tests/unit/channels/messages-runtime.test.ts`                               |       2 |         0 |      1 |              0 |       1 |
| `tests/unit/channels/project-repository.test.ts`                             |       5 |         0 |      0 |              0 |       5 |
| `tests/unit/channels/recall-fusion.test.ts`                                  |       8 |         3 |      5 |              0 |       0 |
| `tests/unit/channels/repository-query-modules.test.ts`                       |      16 |         0 |      0 |              0 |      16 |
| `tests/unit/channels/routing.test.ts`                                        |       3 |         0 |      0 |              0 |       3 |
| `tests/unit/channels/session-and-history-manager.test.ts`                    |       8 |         5 |      0 |              0 |       3 |
| `tests/unit/channels/skills-prompt.test.ts`                                  |       2 |         2 |      0 |              0 |       0 |
| `tests/unit/channels/slack-pairing.test.ts`                                  |       1 |         1 |      0 |              0 |       0 |
| `tests/unit/channels/slack-webhook-route.test.ts`                            |       2 |         2 |      0 |              0 |       0 |
| `tests/unit/channels/subagent-agent-profiles.test.ts`                        |       2 |         0 |      2 |              0 |       0 |
| `tests/unit/channels/telegram-code-pairing.test.ts`                          |       6 |         6 |      0 |              0 |       0 |
| `tests/unit/channels/telegram-group-migration.test.ts`                       |       3 |         2 |      1 |              0 |       0 |
| `tests/unit/channels/telegram-inbound-callbacks.test.ts`                     |       2 |         1 |      1 |              0 |       0 |
| `tests/unit/channels/telegram-inbound-media.test.ts`                         |       1 |         0 |      0 |              0 |       1 |
| `tests/unit/channels/telegram-media.test.ts`                                 |       5 |         0 |      0 |              0 |       5 |
| `tests/unit/channels/telegram-model-buttons.test.ts`                         |       6 |         5 |      0 |              0 |       1 |
| `tests/unit/channels/telegram-model-selection.test.ts`                       |       4 |         4 |      0 |              0 |       0 |
| `tests/unit/channels/telegram-native-command-handler.test.ts`                |       3 |         3 |      0 |              0 |       0 |
| `tests/unit/channels/telegram-outbound-branches.test.ts`                     |      25 |        15 |     10 |              0 |       0 |
| `tests/unit/channels/telegram-outbound-threading.test.ts`                    |       4 |         1 |      3 |              0 |       0 |
| `tests/unit/channels/telegram-pairing-confirm-route.test.ts`                 |       3 |         2 |      1 |              0 |       0 |
| `tests/unit/channels/telegram-pairing-poll-route.test.ts`                    |       2 |         0 |      2 |              0 |       0 |
| `tests/unit/channels/telegram-pairing.test.ts`                               |       1 |         0 |      1 |              0 |       0 |
| `tests/unit/channels/telegram-polling-lease.test.ts`                         |       5 |         1 |      4 |              0 |       0 |
| `tests/unit/channels/telegram-targets.test.ts`                               |       4 |         4 |      0 |              0 |       0 |
| `tests/unit/channels/telegram-webhook-pairing.test.ts`                       |       3 |         2 |      1 |              0 |       0 |
| `tests/unit/channels/tool-manager-behavior.test.ts`                          |       7 |         6 |      0 |              0 |       1 |
| `tests/unit/channels/tool-manager-process-manager-approval.test.ts`          |       1 |         1 |      0 |              0 |       0 |
| `tests/unit/channels/tool-manager-python-approval.test.ts`                   |       1 |         1 |      0 |              0 |       0 |
| `tests/unit/channels/tool-manager-subagents-context.test.ts`                 |       1 |         0 |      0 |              0 |       1 |
| `tests/unit/channels/unpair-telegram-hard-disconnect.test.ts`                |       2 |         0 |      2 |              0 |       0 |
| `tests/unit/channels/unpair-unsupported.test.ts`                             |       1 |         1 |      0 |              0 |       0 |
| `tests/unit/channels/unpair.test.ts`                                         |       3 |         1 |      2 |              0 |       0 |
| `tests/unit/channels/webhook-auth.test.ts`                                   |      12 |        12 |      0 |              0 |       0 |
| `tests/unit/channels/whatsapp-outbound.test.ts`                              |       1 |         0 |      1 |              0 |       0 |
| `tests/unit/channels/whatsapp-webhook-route.test.ts`                         |       2 |         2 |      0 |              0 |       0 |
| `tests/unit/telegram/persona-telegram-bot-registry.test.ts`                  |      12 |         0 |      0 |              0 |      12 |
| `tests/unit/telegram/persona-telegram-pairing.test.ts`                       |       1 |         0 |      0 |              0 |       1 |
| `tests/unit/telegram/persona-telegram-poller.test.ts`                        |       2 |         0 |      0 |              0 |       2 |
| `tests/unit/server/summaryService-perf.test.ts`                              |      24 |         0 |      0 |              0 |      24 |
| **Summe**                                                                    | **419** |   **170** | **45** |          **1** | **203** |

## 3. Anmerkungen zur Zuordnung

Die Zahlen oben sind das Ergebnis. Die Punkte hier erklären, wie einzelne Zuordnungen zustande kommen.

- **Namensvergleich über andere Crates:** Einige abgedeckte Fälle liegen in Modulen anderer Crates. Sie sind nur über Testnamen und Modulköpfe zugeordnet. Die Assert-Ebene ist nicht geprüft. Betroffen: `webhook-auth` (12, `betaclaw-gateway/src/families/channels_wire/webhook_auth.rs` und `webhooks.rs`), `telegram-model-buttons` (5), `telegram-model-selection` (4), `telegram-native-command-handler` (3, `telegram_commands.rs`), `telegram-chatdelete-webhook` (1), `slack-webhook-route` (2), `whatsapp-webhook-route` (2), `whatsapp-accounts-route` (3), `state-route` (3, Auth-Gate), `persona-isolation-routes` (2), `tool-manager-process-manager-approval` (1, `betaclaw-skills/process_manager.rs`), `tool-manager-python-approval` (1, `betaclaw-skills/python_execute.rs`), `message-service-modules` (2, `chat_runtime/summary.rs`).
- **Route-Ebene:** Die HTTP-Hülle (Statuscodes, Auth-Gate, Routen-Wiring) liegt im Gateway. Die Logik dahinter ist in diesem Crate getestet. Betroffen: `channels-pair-route` (5 Fälle), `pairing-router`, `message-delete-route`, `project-delete-conversation-delete-flow`, `telegram-pairing-confirm-route`, `telegram-pairing-poll-route`, `telegram-pairing`.
- **`messageRouter` (12):** Die Routing-Tabelle liegt in `betaclaw-gateway/src/families/chat_runtime/commands.rs`. Fälle wie `/subagents`, `/steer`, `/deny`, `/shell`, alte Worker-Befehle, unbekannte Slash-Befehle und leere Eingabe sind dort nicht getestet. Offen mit Zuständigkeit Gateway.
- **`telegram-chunking` (7):** Die Grenzfälle liegen in `adapters/telegram/outbound.rs`. `TELEGRAM_MAX_LENGTH` ist 4096. Die Fälle „exakt 4096“, „Hard-Cut bei 4096“ und „leerer Text“ sind neu.
- **`telegram-outbound-branches` (25) und `-threading` (4):** Die Sender-Logik ist in `outbound.rs` und `api.rs` getestet. Zehn Fälle waren nicht geprüft (Edit, Callback ohne Token, Callback-Warnung, Retry bei 429, Retry-Grenze, Parse-Mode, Topic-Thread) und sind neu.
- **`telegram-polling-lease` (5):** Die Lease-Logik im Store liegt in `credentials.rs` (abgedeckt). Der Start-Pfad, das Standby, der Stop und die Reihenfolge Offset-vor-Verarbeitung waren nicht geprüft und sind neu. Der 409-Fall ist abgedeckt.
- **`session-and-history-manager` (8):** Fünf Fälle sind abgedeckt, davon zwei über Gateway-Tests (`conversations_are_found_again_and_scoped_to_their_user`, `appended_user_message_is_listed_and_becomes_model_context`). Die übrigen drei (Default-Webchat-Konversation, Agent-Nachrichten, Limits) sind offen.
- **`summaryService-perf` (24):** Alle 24 Fälle sind offen. 17 Fälle (Mem0-Hintergrund, Circuit-Breaker, sequentielle Fakten, Metadaten) liegen in `betaclaw-knowledge` (`ingestion/fact_extractor.rs`, `ingestion/service.rs`). 6 SQLite-Fälle liegen in `betaclaw-store/messages_store`. Der Fall „Lock nach SQLite-Schreiben“ betrifft `summary_service.rs` und hat keinen Test.
- **Heuristik-Auto-Memory:** `auto-memory` (10) und `message-service-auto-session-memory` (3) betreffen den Heuristik-Modus aus `autoMemory.ts`. Rust verweigert diesen Modus beim Start (`betaclaw-gateway/src/families/chat_runtime/summary.rs:45`). Das ist ein Funktionsunterschied, siehe Abschnitt 6.
- **Unit-Tests der Store-Schicht:** `message-repository-*` (43), `repository-query-modules` (16), `project-repository` (5), `channel-bindings-repository` (2), `agent-room-queries` (3) und `agent-room-queries-branches` (3) prüfen `betaclaw-store`. Nicht in diesem Schritt verglichen.

## 4. Neue Rust-Tests (39 Funktionen)

Alle neuen Tests liegen in `rust/crates/betaclaw-channels`. Es gibt keine Änderung am Produktionscode, nur Testmodule.

| Datei                                                      | Tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/channels/adapters/imessage.rs`                        | `without_a_bridge_url_nothing_is_sent`, `the_chat_guid_and_message_go_to_the_send_route`, `one_trailing_slash_of_the_bridge_url_is_dropped`, `a_non_ok_answer_is_an_error_with_the_status`                                                                                                                                                                                                                                                                                              |
| `src/channels/adapters/whatsapp.rs`                        | `a_scoped_chat_id_is_split_into_recipient_and_account`, `a_missing_bridge_url_sends_nothing`                                                                                                                                                                                                                                                                                                                                                                                            |
| `src/channels/adapters/telegram/outbound.rs`               | `split_of_an_empty_text_is_one_empty_chunk`, `a_run_without_whitespace_is_cut_at_the_telegram_limit`, `a_text_of_exactly_the_limit_is_sent_in_one_message`, `a_topic_message_carries_its_thread_id`, `parse_mode_goes_on_the_first_chunk`, `an_edit_keeps_the_thread_of_a_direct_topic`, `an_edit_without_a_token_sends_nothing`, `a_rejected_edit_is_an_error_naming_the_edit`, `a_callback_answer_without_a_token_sends_nothing`, `a_rejected_callback_answer_is_logged_not_returned` |
| `src/channels/adapters/telegram/api.rs`                    | `a_rate_limit_is_retried_like_a_server_error`, `retries_stop_after_three_attempts_and_return_the_last_answer`                                                                                                                                                                                                                                                                                                                                                                           |
| `src/channels/pairing/unpair.rs`                           | `telegram_unpair_deletes_the_webhook_and_clears_the_credentials`, `discord_unpair_clears_the_token_without_an_api_call`, `telegram_unpair_stops_the_running_poller`, `telegram_unpair_fails_while_the_token_is_still_stored`                                                                                                                                                                                                                                                            |
| `src/channels/pairing/telegram_polling.rs`                 | `start_does_not_begin_while_another_runtime_holds_the_lease`, `start_takes_over_a_lease_that_has_expired`, `stop_cancels_the_standby_retry_scheduled_for_a_lost_lease`, `the_offset_is_persisted_before_a_long_update_finishes`, `start_does_nothing_when_the_transport_is_webhook`, `creating_the_poller_starts_nothing`, `a_second_start_while_active_changes_nothing`                                                                                                                |
| `src/channels/pairing/telegram_inbound.rs`                 | `an_authorized_callback_reaches_the_model_handler`, `a_second_chat_is_refused_once_the_pairing_is_connected`                                                                                                                                                                                                                                                                                                                                                                            |
| `src/channels/pairing/telegram_code.rs`                    | `a_missing_code_is_refused`, `migration_moves_a_pending_code_to_the_new_chat`                                                                                                                                                                                                                                                                                                                                                                                                           |
| `src/channels/pairing/telegram.rs`                         | `pairing_syncs_the_native_command_menu`                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `src/channels/messages/service/recall/fusion.rs`           | `each_source_alone_is_returned_under_its_label`, `every_chat_hit_is_listed`, `the_total_output_stays_within_the_fusion_budget`                                                                                                                                                                                                                                                                                                                                                          |
| `src/channels/messages/service/subagent/agent_profiles.rs` | `qa_profile_carries_the_playwright_cli_tool_and_skill`, `the_catalog_keeps_the_worker_and_qa_profiles`                                                                                                                                                                                                                                                                                                                                                                                  |

Die Testanzahl im Crate steigt von 307 auf 346 Tests.

## 5. Rust-Fixes und nicht portierte Fälle

**Rust-Fixes:** keine. Keine der TS-Erwartungen hat einen Rust-Fehler gezeigt. Alle neuen Tests sind bei der ersten Ausführung grün.

**Nicht portiert:**

1. `tool-manager-behavior`, Fall 1 („falls back for circular output“): Der Teil mit dem Fallback für zirkuläre Objekte entfällt. `serde_json::Value` kann nicht zirkulär sein. Die übrigen Teile (Format, Truncation) sind abgedeckt und zählen als abgedeckt.
2. `message-service-inbox-fallback`, Fall „uses the repository item when available and builds or omits the item in fallback mode“: Der listInbox-Fallback ist nicht portiert. `betaclaw-channels/src/channels/messages/service/message_service.rs` dokumentiert dies: Der Repository-Port liefert `listInbox` immer, daher ist der Fallback in Rust nicht erreichbar. Das ist die einzige bewusste Auslassung in dieser Domäne.

## 6. Offene Fälle (203) mit Grund

Die offenen Fälle sind nach Grund gruppiert. Die Zahlen dieser Gruppen stehen in der Tabelle in Abschnitt 2.

**a) Funktionsunterschied: Rust-Gegenstück fehlt (Phase-5-Blocker).**

- Heuristik-Auto-Memory (`autoMemory.ts`): `auto-memory`, `message-service-auto-session-memory`. Gateway verweigert den Modus beim Start.
- Telegram-Medien (`telegram/media.ts`): `telegram-media`, `telegram-inbound-media`. Keine Entsprechung in `betaclaw-channels` oder im Gateway.
- Health-Monitor und Attachment-Health: `health-monitor`, `attachment-health-monitor`. Nicht portiert.
- Attachment-Konsistenz: `attachment-consistency`. Gehört zum Ops-Skript `attachments:consistency` (Phase 3).
- Adapter-Registry und Outbound-Router (S8): `adapter-registry`, `routing`.
- Laufzeitfälle, die im Crate fehlen: `tool-manager-subagents-context` (Weiterleitung von `invokeSubagentToolCall`, `tool_manager.rs:289`), `tool-manager-behavior` Fall 7 (Process-Manager-Aktionen außer `start`), `message-service-webchat-tools` (Dispatch über Modell-Hub), `message-service-modules` (Status-Icon, Channel-Binding-Persona), `messages-runtime` (Health-Monitor-Teil von Fall 84).

**b) Pipeline-Test fehlt in diesem Crate.** `handle_inbound.rs` hat in `betaclaw-channels` nur einen Test. Die Stufen sind als Ports getrennt. Offen sind:

- `ai-dispatcher-summary-refresh` (2), `ai-dispatcher-tools-disabled` (1): Flags für Summary-Refresh und Skills-Abschnitt.
- `message-service-summary` (2): Wissens-Ingest im Summary-Refresh. `message-service-proactive-gate` (1): Event `summaryRefreshed`.
- `message-service-knowledge-recall` (5): Pipeline-Reihenfolge, Scope über den vollen Dispatch.
- `message-service-project-command` (2), `project-workspace-cwd` (2), `shell-command` (1), `roleplay-tools-disabled` (1): cwd-Weitergabe, Projekt-Liste, Shell-Skill deaktiviert, Inferenz ohne Tools.

**c) Zuständigkeit anderer Crates (nicht in diesem Schritt geprüft).**

- Store (`betaclaw-store/messages_store`, `personas/telegram_bots`): `message-repository-*` (43), `repository-query-modules` (16), `project-repository` (5), `channel-bindings-repository` (2), `agent-room-queries` und `-branches` (6), `persona-telegram-bot-registry` (12), SQLite-Fälle aus `summaryService-perf` (6).
- Inbox (Store und Gateway): `inbox-route` (11), `message-service-inbox-fallback` (4 von 5).
- Knowledge (`betaclaw-knowledge`): 17 Fälle aus `summaryService-perf` (Mem0, Circuit-Breaker, Fakten).
- Gateway: `messageRouter` (5), `credential-store` (7, `channels_wire/store.rs`), `inbound-normalizers` (4), `attachments` (2, Persona-Pfade), `context-builder` (1), `session-and-history-manager` (3), `telegram-model-buttons` (1, Seitenberechnung), `telegram-chatdelete-webhook` (1, Topic-Scope), `message-service-project-command` (2), `project-workspace-cwd` (2), `message-service-summary` (teils), `message-service-modules` (teils).
- Persona-Poller (Gateway, `persona_poller.rs`, parallel bearbeitet): `persona-telegram-poller` (2). `persona-telegram-pairing` (1) liegt beim Store oder Gateway.
- Summary-Lock nach SQLite-Schreiben (`summary_service.rs`): 1 Fall (Teil von `summaryService-perf`).

**d) Sonstige Lücken in diesem Crate.** `message-service-project-command` Fall „lists only projects for the active persona“ und Fall „deletes by list index“ sind offen, weil sie im Crate nicht namentlich getestet sind (`commands/project.rs`). Diese Fälle sind klein. Ein Folgeschritt kann sie in `commands/project.rs` nachziehen.

## 7. Blocker für das Löschen der TS-Tests

Diese TS-Dateien dürfen in Phase 5 nicht gelöscht werden, solange der Punkt offen ist:

1. **Funktionsunterschiede, Entscheidung nötig (portieren oder streichen):** Heuristik-Auto-Memory, Telegram-Medien, Health-Monitor, Attachment-Konsistenz (Ops-Skript, Phase 3), Adapter-Registry und Outbound-Router (S8).
2. **Store-Zuständigkeit:** Die Store-Fälle (Abschnitt 6c) brauchen den Store-Auditor. Dazu gehören `message-repository-*`, `repository-query-modules`, `project-repository`, `channel-bindings-repository`, `agent-room-queries*`, `persona-telegram-bot-registry`.
3. **Inbox:** `inbox-route` und `message-service-inbox-fallback` brauchen den Inbox-Vergleich (Store und Gateway).
4. **Knowledge:** Die Mem0- und Fakten-Fälle aus `summaryService-perf` brauchen den Knowledge-Auditor.
5. **Gateway-Zuständigkeit:** `messageRouter`, `credential-store`, `inbound-normalizers`, `session-and-history-manager`, `attachments` (Persona-Pfade). Die Telegram-Tests `telegram-model-buttons`, `telegram-chatdelete-webhook` und `persona-telegram-poller` sind ebenfalls Gateway-Themen.
6. **Pipeline-Tests:** Abschnitt 6b. Für die Message-Service-Dateien braucht es Integrationsfälle über `handle_inbound`.

Die TS-Tests mit `@/server` in diesen Domänen liegen also noch vollständig vor. Abschnitt 6 nennt die Zuständigkeit je Fall.

## 8. Gates

Alle Befehle wurden auf dem Host ausgeführt. Der Lauf des Coordinators (Container) steht aus.

| Gate                     | Befehl                                                                                                 | Ergebnis                                                                                                                                                                                                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Format                   | `cargo fmt --manifest-path rust/Cargo.toml -p betaclaw-channels` und `-- --check`                      | bestanden (Exit 0)                                                                                                                                                                                                                                                                                                        |
| Clippy                   | `cargo clippy --manifest-path rust/Cargo.toml -p betaclaw-channels --all-targets` (ohne `-D warnings`) | Exit 0. Keine Warnungen aus `betaclaw-channels`. Warnungen nur aus `betaclaw-base` und `betaclaw-world-model`.                                                                                                                                                                                                            |
| Clippy mit `-D warnings` | `cargo clippy ... --all-targets -- -D warnings`                                                        | **nicht bestanden, nicht von diesem Schritt verursacht.** `betaclaw-base` (Abhängigkeit, Arbeitskopie bereits geändert): `auth/limiter.rs:97` (`match` durch `?` ersetzen), `config.rs:260` (`clamped.max(BASE)`). Der Lauf bricht vor `betaclaw-channels` ab. Ohne `-D` gibt es für `betaclaw-channels` keine Warnungen. |
| Tests                    | `cargo test --manifest-path rust/Cargo.toml -p betaclaw-channels`                                      | bestanden: 346 Tests, 0 fehlgeschlagen, 0 ignoriert (Exit 0)                                                                                                                                                                                                                                                              |

`cfg(unix)`-Tests gibt es in diesem Crate nicht. Es wurde nichts auf dem Host übersprungen.

Nicht geändert: `docs/TS_TEST_COVERAGE_AUDIT.md` (Koordinator führt zusammen), keine TS-Tests, keine Commits, keine Stashes, keine Branches.
