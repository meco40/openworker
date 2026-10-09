# BetaClaw 0.1.0: Release-Nachprüfung

Stand: 2026-10-09. Basis: öffentlicher Commit
`7196b97e6f6fe6618c3e8b84b65849610d00110a`. Korrekturen liegen isoliert auf
`codex/public-release-go`; fremde Änderungen im Hauptcheckout sind nicht Bestandteil.

## Umfang der Freigabe

Vorbereiteter Source-Release für eine eigene Docker-Selfhosting-Installation
mit vertrauenswürdigem Betreiber, Anmeldung, canonical PostgreSQL und getrennten
App-/Worker-Rollen. Keine Freigabe als Sandbox oder als öffentlicher Dienst für
beliebige fremde Nutzer. Externe Modelle benötigen eigene Provider-Konfiguration.
Der enthaltene Avatar bleibt CC BY-NC 4.0; kommerzielle Verwendung benötigt einen
geeigneten Ersatz gemäß THIRD_PARTY_NOTICES.

**GO für den lokal geprüften Docker-Selfhosting-Kandidaten 0.1.0.** Der letzte
vollständige Produktions-Smoke am 2026-10-09 ist grün. Veröffentlichung, Tag und
GitHub-CI dieses Kandidaten sind nicht erfolgt. Der öffentliche Commit
`7196b97e` bleibt bis zur Übernahme der Korrekturen **NO-GO**.

## Nachprüfung der zwölf Befunde

| Auditbefund | Nachprüfung und Korrektur |
| --- | --- |
| 1: angemeldeter WS 401 | Mit echtem Produktionslogin bestätigt. Node-Request erhält geparste Cookies vor NextAuth `getToken`; signierte, sichere und gechunkte Cookies getestet. Der erste Ansatz über `NextRequest` verursachte einen separaten Server-Importfehler und wurde durch den eigenständigen Cookie-Parser ersetzt. |
| 2: leere PostgreSQL-DB startet nicht | Gegen leere DB bestätigt. Compose führt Migrationen mit Admin-Zugang vor Web/Scheduler aus; neue CLI `world-model:migrate`. |
| 3: Mem0-Erstkonfiguration blockiert | Unkonfigurierter Mem0-503 bestätigt. Der Standardpfad verwendet jetzt konsequent PostgreSQL/canonical. Mem0 bleibt ausdrücklich optional mit dokumentiertem Bootstrap. |
| 4: Python ohne Freigabe | Auf öffentlicher Basis mit harmlosem Code erneut reproduziert. ToolManager und Handler prüfen Approval/Policy; verschachtelte Aufrufe ebenfalls. Hash des exakten Codes verhindert Freigabeverwechslungen durch Whitespace-Normalisierung. |
| 5: ungültige Prospective-SQL | Echte PostgreSQL-Fehler erneut bestätigt. Parameterfolge und Enum-Casts korrigiert; sechs echte Repository-Tests übernommen. |
| 6: Worker-Rechte/Scopes | Fehlende Grants und DDL beim Worker-Start bestätigt. Separater Migrationsdienst, Migration 019, scoped Discovery/Prospective-/Retry-Pfade und echte Worker-Rollen-Tests. Externe Scopes ohne Chat werden explizit über `WORLD_MODEL_DISPATCH_SCOPES` eingetragen. |
| 7: Symlink-Ausbruch | Lesen und Überschreiben einer synthetischen externen Datei auf Basis erneut reproduziert. Reale Pfade sowie bestehende Parents neuer Dateien werden validiert; Read/Write/Edit/Patch-Test schützt den externen Canary. Keine Behauptung einer vollständigen OS-Sandbox/TOCTOU-Abwehr. |
| 8: Python/Chromium fehlen | Im ursprünglichen Image bestätigt. Debian-Runner enthält Python 3 und Browser/Systembibliotheken zur gelockten Playwright-Version. Produktionsprüfung führt beide tatsächlich aus. |
| 9: bisherige Gates beweisen keinen Produktionschat | Bestätigte Testkonfiguration: Anmeldung aus, Memory/Modelle gemockt. Neuer verpflichtender Produktions-Smoke verwendet echte Anmeldung, PostgreSQL, Rollen, Provider-HTTP-Dispatch und WS; nur der entfernte Modellserver ist ein lokales HTTP-Fixture. Historische Harness-Rolloutmetriken bleiben ungeändert und sind keine Freigabe. |
| 10: Sicherheitsanzeigen übertreiben Schutz | Im Code bestätigt. Anzeigen heißen jetzt HTTPS/WebCrypto und Command Policy und beschreiben die tatsächlichen Prüfungen. |
| 11: High in Entwicklungsabhängigkeit | Erneuter Audit bestätigt `lint-staged > micromatch > braces@3.0.3`. Gezieltes Upgrade auf lint-staged 17.6.0 entfernt diese Kette. Node-Mindestversion und Hook-Kompatibilität werden separat geprüft. |
| 12: lokaler Dirty-Stand nicht releasefähig | Ursprüngliche wechselnde Standardtestfehler und Formatprobleme sind real, aber kein pauschaler Produktdefekt. Dieser Kandidat basiert auf dem öffentlichen Commit und enthält nur geprüfte Release-Korrekturen. Fremder Arbeitsstand bleibt erhalten. |

Zusätzlich beim Durchlaufen des Docker-Modellpfads gefunden: Lokale
Provider-Endpunkte waren hart auf `localhost` gesetzt; Embeddings verlangten
selbst bei unterstütztem `authMethod=none` ein Secret. Docker-Host-Endpunkte und
keyless lokale Embeddings werden jetzt berücksichtigt und getestet.

## Nachweise

Alle Installationen, Builds, Tests und Runtime-Prüfungen verwenden eigene
Container/Datenbanken. Keine vorhandenen Nutzerdaten oder fremden Dienste ändern.

- Standard-Volltest nach Anwendungskorrekturen: **3.133 bestanden, 37 externe
  Tests übersprungen; 615 Dateien bestanden, 14 übersprungen**.
- Echte PostgreSQL-Lane: **36 bestanden, ein externer Graphiti-Test übersprungen**.
  Enthält sechs Prospective-Repository- und zwei Worker-Rollen-Tests.
- Letzter Cookie/Embedding/ToolManager-Fokus: **17/17**, Typecheck grün.
- Anwendungskandidat: Check grün, Oxlint **0 Fehler/0 Warnungen**.
- Frozen-Lockfile-Installation mit lint-staged 17.6.0 bestanden; vollständiger
  und Produktions-`pnpm audit` jeweils **0 Advisories**. Der echte Hook mit der
  vollständigen Änderungsliste besteht. Node >=22.22.1 und Git >=2.32 erforderlich.
- Abschließender Volltest mit dem neuen Lockfile ebenfalls **3.133 bestanden,
  37 übersprungen**; Check grün, **0 Oxlint-Fehler/-Warnungen**.
- Next.js-Build **50 Seiten**, Dockerimage `betaclaw-release-go:0.1.0` gebaut.
  Image-ID: `sha256:52c8e23e6a870bfad3c825b53bee72895809080362a59844ab5c2f9ea7b03241`.
- Smoke-E2E **11/11**, Browser-E2E **69/69**. Der erste Smoke-Versuch ohne
  `.next`-Build schlug erwartungsgemäß fehl; nach korrekter Build-Vorbereitung
  bestand der vollständige Lauf. Dies war kein unterdrückter Produktfehler.
- Produktions-Smoke auf frischen Volumes: anonyme API/WS **401**, fremder Origin
  **403**, echte Anmeldung, authentifizierter WS **101**, Provider-Chat und
  Verlauf-Persistenz, Embeddings, canonical Memory-Schreiben/Lesen und
  Scheduler-Health **200**. Kein Model-Hub-Testmodus, kein Memory-Stub.
- Tatsächliche DB-Identität **world_model_worker** geprüft; Open Loop wird
  scoped geleast und in die Outbox gestellt, Standing Intent fortgeschrieben.
  Dies ist kein Nachweis externer Benachrichtigungszustellung.
- Python vor Approval abgewiesen, danach direkt und verschachtelt mit Exit 0;
  Chromium führt einen Screenshot im Produktionsimage aus.
- PostgreSQL-Dump und Restore in eine eigene leere Testdatenbank bestanden;
  mindestens eine Memory-Zeile erhalten. Kein vollständiger Restore aller
  SQLite-/Workspace-Volumes oder Upgrade vorhandener Benutzerdaten behauptet.
- Gitleaks-Quellsnapshot: **0 Funde** bei 20,59 MB; ursprüngliche öffentliche
  Historie war im Basis-Audit geprüft. Keine Historienänderung vorgenommen.

Private Rohbelege liegen unter `.tmp/release-go-20261009/` im Hauptcheckout und
im eigenen Testcontainer. Die reproduzierbare öffentliche Prüfung heißt
`pnpm run test:e2e:production` und ist im erforderlichen CI-Job E2E Smoke verankert.
Sie erzeugt eigene Secrets, eine leere DB und eigene Volumes, und entfernt nur
dieses zufällig benannte Testprojekt. Fehlerlogs bleiben erhalten.

## Grenzen und Veröffentlichung

Die Prüfungen beweisen Installierbarkeit und Protokoll-/Persistenzpfade; die
Antwortqualität eines realen KI-Modells ist nicht gemessen. OAuth, externe
Messaging-Konten, Voice/Kamera, Real-Graphiti, native Windows/macOS-Installation,
Last/Dauerbetrieb, Restore aller drei Volumes und vollständiger
OS-/Python-Schwachstellenscan bleiben ungeprüft.
Die konkrete Lizenzgrenze des Avatars bleibt bestehen.

Vor Veröffentlichung exakt den Kandidaten übertragen, erforderliche GitHub-CI
auf dessen SHA abwarten und Version/Tag `v0.1.0` auf diesem geprüften SHA anlegen.
Bestehende Installationen müssen alle drei Volumes sichern und einen Restore
prüfen; der neue Compose-Weg importiert alte Host-`.local`-Daten nicht automatisch.
Ein erfolgreicher Erststart ersetzt keine individuelle Datenmigration.

Primärquellen, geprüft am 2026-10-09:
[braces-Advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm),
[lint-staged-Migration](https://github.com/lint-staged/lint-staged/blob/main/MIGRATION.md),
[Playwright-Docker-Anforderungen](https://playwright.dev/docs/docker).
