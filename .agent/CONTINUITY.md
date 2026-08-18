# CONTINUITY

## [PLANS]

- 2026-08-18T21:50:00+02:00 [USER] Setze den Plan `docs/plans/2026-08-18-world-model-complete-implementation-plan.md` sauber und professionell um. Ausgangspunkt war `docs/plans/README.md`. Grundsatz: komplette fachliche Umsetzung, nicht nur Teile.
- 2026-08-18T23:57:00+02:00 [USER] Den vollständig reviewten und validierten World-Model-Arbeitsstand auf `main` committen und zum vorhandenen Upstream pushen.

## [DECISIONS]

- 2026-08-18T10:15:00+02:00 [ASSUMPTION SUPERSEDED] Die fruehere Einschraenkung auf Phasen 7-9 wurde nach Nutzer-Feedback aufgehoben. Die in dieser Betriebsumgebung umsetzbaren Phasen 1-6, 10 und die Kernbausteine von 11 und 15 wurden nachgeholt. Die verbleibenden Bestandteile (Phase 12 Graphiti real, Phase 13 Backfill gegen Produktionsdaten, Phase 14 Mem0-Datenmigration, Rest von Phase 15 Cutover) erfordern reale Infrastruktur/Deployments und bleiben als dokumentierte Folge-Arbeitspakete.
- 2026-08-18T23:36:00+02:00 [TOOL] Die Aussage, Phasen 1-11 seien weitgehend umgesetzt, ist durch Diff-Review superseded: mehrere Bausteine sind isolierte Scaffolds ohne produktive Verdrahtung. Canonical-Cutover bleibt gesperrt.

## [PROGRESS]

- 2026-08-18T21:40:00+02:00 [TOOL] Ist-Zustand erfasst: World Model Fundament (Phasen 0-6 teilweise vorhanden).
- 2026-08-18T22:08:00+02:00 [CODE] Phasen 7-9 (Proaktive Sekretaerin): Open-Loop-Zustellung, Standing Intents, Heartbeat, Antwortkorrelation, Klärung, Benachrichtigungspolitik + Scheduler-Verdrahtung + Outbox-Handler + Env-Doku.
- 2026-08-18T22:34:00+02:00 [CODE] Nachgelieferte Phasen: (1) scope.ts + Migrationen 005/006 (Scope/Historie/RLS) + Tests; (2) observationService + deriveWriteHealth; (3) projector/ (types, idempotency, normalizeExtraction, projectWindow) + Tests; (4) eventLinker + correctionResolver (Kino/Essen) + Tests; (5) assertionRepository + assertionService; (6) actionAttemptRepository + actionService + canonicalTaskService + Tests; (10) queryPlanner (Temporal) + Tests.
- 2026-08-18T22:49:00+02:00 [CODE] Phase 11 Kern (Migration 007 pgvector-Indizes/Embedding-Versionierung, `retrieval/hybridRanker.ts`, `embeddings/embeddingText.ts`) + Phase 15 Kern (`metrics.ts`, `dataLifecycle.ts` Retentions-Policy) + Tests. Alles im Barrel exportiert.
- 2026-08-18T23:36:00+02:00 [CODE] Review-Korrekturen: Migrationen 005-007 syntaktisch/lokal frisch validiert; RLS-Parent-Policies korrigiert und echte Cross-Workspace-Isolation getestet; Mode/Legacy-Flags vereinheitlicht; Workspace-Scope in Entity/Relation/Retrieval/Due-Loop-Pfaden ergänzt; Projector-Transaktion, Assertion/Event/Relation-Replay und Action-Attempt-Race gehärtet; unbekannte Outbox-Events werden nicht mehr fälschlich quittiert; Required-Modus blockiert fehlgeschlagene Observation-Writes.
- 2026-08-18T23:57:00+02:00 [TOOL] Vor dem Commit war `main` exakt synchron mit `origin/main` (`0/0` Divergenz); der vollständige Arbeitsbaum-Diff ist damit ohne Remote-Konflikt pushbar.

## [OUTCOMES]

- 2026-08-18T22:49:00+02:00 [CODE SUPERSEDED] World-Model-Unit-Suite war gruen, deckte aber ungültige Migrationen, echte RLS-Isolation, tote Produktivpfade und unregistrierte Outbox-Handler nicht ab; daraus durfte keine Phasen-Vollständigkeit abgeleitet werden.
- 2026-08-18T23:36:00+02:00 [TOOL] Nach Review-Korrekturen: Typecheck gruen; fokussiert 23 Dateien/114 Tests gruen; PostgreSQL-Integration 4 Dateien/8 Tests gruen; frische Datenbank hat alle damaligen 7 Migrationen erfolgreich angewendet. Vollständige Gates standen zu diesem Zeitpunkt noch aus.
- 2026-08-18T23:49:00+02:00 [TOOL] Abschlussvalidierung: `pnpm run check` ohne Warnungen/Fehler, `pnpm run test` 599 Dateien/3003 Tests gruen, `pnpm run build` gruen, Smoke-E2E 7 Dateien/11 Tests gruen; World-Model-E2E nach zusaetzlichem Projector-Test 5 Dateien/9 Tests gruen.
- 2026-08-18T23:50:00+02:00 [CODE] Migration 008 stellt Projection-Replay-Indizes auch fuer bereits lokal angewendete Migration 005 her; bestehende DB wendete 008 an, frische DB wendete alle 8 Migrationen an.

## [DISCOVERIES]

- 2026-08-18T22:04:00+02:00 [TOOL] `write_to_file` meldet bei grossen Inhalten teils leere `content`-Parameter; zuverlaessig ist PowerShell `Set-Content -Value @"..."@`.
- 2026-08-18T22:15:00+02:00 [CODE] RLS (Migration 006) muss rollen-bewusst sein (`world_model_is_scoped_session`), sonst bricht Legacy-Bestand — behoben.
- 2026-08-18T22:40:00+02:00 [CODE] `graphiti-shadow-handler.test.ts` braucht isolierte Teststruktur (`vi.doUnmock` + `vi.resetModules` + dynamischem Import in `beforeEach`) — behoben.
- 2026-08-18T22:41:00+02:00 [CODE] Temporaler Query Planner: Intent lowercase-normalisieren; Plural-Alternations-Reihenfolge korrigiert.
- 2026-08-18T23:36:00+02:00 [TOOL] `projectWindow`, `normalizeExtraction`, CanonicalTask/Action, ResponseCorrelation und StandingIntentCompiler haben außerhalb des World-Model-Moduls keine produktiven Aufrufer. Der Scheduler findet nun Scopes, aber es gibt keinen echten Kanal-Handler für `proactive.question.requested` oder `proactive.intent.fired`.
- 2026-08-18T23:48:00+02:00 [TOOL] Der neue Event-Flow-Integrationstest verwendete globales `TRUNCATE` und wurde einmal gegen den lokalen World-Model-Entwicklungscontainer ausgeführt; der Test ist jetzt marker-/scope-basiert. Die dabei geleerten damaligen World-Model-Entwicklungsdaten sind ohne separates Volume-Backup nicht aus diesem Test wiederherstellbar; Mem0 und das Container-Volume selbst wurden nicht gelöscht.

## [FOLLOWUPS]

- Release-Blocker: semantischen Projector in den echten Knowledge-/Chat-Pfad integrieren; Tasks, Korrekturen und Event-Linking persistieren; Checkpoint erst nach kanonischem Commit setzen.
- Release-Blocker: echte Channel-Handler samt Delivery Receipt für proaktive Fragen/Intent-Aktionen registrieren; Asked-Status erst nach bestätigter Zustellung; Leases, Backoff und DLQ für Open Loops abschließen.
- Release-Blocker: Mission-Control-Tasks, Tool-/E-Mail-/Kalender-Aktionen und Response Correlation an kanonische Services anbinden; RLS-Datenbankrollen tatsächlich als Runtime-Credentials einsetzen.
- Phase 11 Rest: produktiver Embedding-Worker (`embeddingWorker.ts`), `retrieval/vector.ts`, Hybrid-Retrieval-Integration — erfordert Embedding-Endpunkt.
- Phase 12: Graphiti real anbinden (Client, Rebuild, Evaluator) — erfordert reale Graphiti-Instanz.
- Phase 13: Backfill-/Reconcile-Skripte — erfordert Produktionsdaten.
- Phase 14: Mem0-Reduktion + Factual-Memory-Audit — erfordert Mem0-Migrationsdaten.
- Phase 15 Rest: `app/api/health/world-model/route.ts`, Incidents-Runbook, Failure Drills, Canary/Rollback, Produktiv-Cutover.
