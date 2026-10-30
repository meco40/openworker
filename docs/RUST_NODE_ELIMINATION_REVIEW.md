# Review der Nacharbeiten zur Node-Eliminierung

Die folgenden Befunde dokumentieren den ursprünglichen Prüfstand. Die Korrekturen
F1–F25 sind inzwischen implementiert; zusätzliche Laufzeitfehler aus dem
Produktions-Smoke sind im gemeinsamen PostgreSQL-Treiber und bei den
Automations-Datenbankpfaden behoben. Maßgeblicher aktueller Stand und Abnahmen:
[Nacharbeiten](RUST_NODE_ELIMINATION_FIXES.md) und
[Migrationsnachweise](RUST_MIGRATION.md). Die ursprünglichen Befunde bleiben als
Begründung der Korrekturen erhalten.

Prüfstand: 2026-10-29T06:08+01:00. Geprüft wurde der uncommittete Worktree
`E:\web\clawtest-rust`, Branch `rust`, HEAD `5ae79609`, gegen
`RUST_NODE_ELIMINATION_FIXES.md` und die betroffenen TS-/Rust-Aufrufer, Tests,
Build-Skripte, Images und Compose-Konfigurationen. Keine Anwendungskorrekturen.

**Ergebnis: noch nicht vollständig umgesetzt und für den vorgesehenen Betrieb
ohne Node noch nicht freigabefähig.** Die grünen Tests bestätigen die vorhandenen
Fälle, decken aber wesentliche Abnahmekriterien nicht ab.

## Befunde nach Priorität

1. **P1 – Swarms führen keine Turns aus (F3/A3).**
   `rust/crates/betaclaw-gateway/src/swarm_runtime.rs:133` prüft Turn-Zahl und
   Phasen, ruft aber weder Turn-Dispatch noch Completion auf. Retry-Verwaltung
   und die Paritätsfamilie `swarm` fehlen. Gleichzeitig aktiviert
   `docker-compose.yml:44` diesen Runner standardmäßig. Neue Swarms bleiben
   stehen; vorhandene laufende Swarms werden beim Start auf `hold` gesetzt.
   Vor dem Standard-Cutover muss A3 samt Verhaltensnachweis fertig sein.

2. **P1 – Telegram bestätigt auch fehlgeschlagene Verarbeitung (F1/A2).**
   `persona_poller.rs:196` protokolliert einen Fehler von `process_update` und
   läuft weiter; Zeile 209 speichert anschließend den höheren Offset.
   Bei einem DB-/Dispatch-Fehler kann die Nachricht dadurch dauerhaft
   übersprungen werden. Die TS-Referenz
   `src/server/telegram/personaTelegramPoller.ts:118` lässt den Fehler zur
   äußeren Catch-Grenze durch; `setPollingOffset` in Zeile 127 wird dann nicht
   erreicht. A2.4 ist missverständlich formuliert: Das tatsächliche TS-Verhalten
   muss maßgeblich sein. Fehler propagieren und Offset nur nach erfolgreicher
   Runde schreiben; mit einer Telegram-Attrappe absichern.

3. **P1 – Tool-Laufzeiten fehlen im ausgelieferten Rust-Image.**
   `docker/Dockerfile.gateway:72` installiert nur `ca-certificates` und `curl`.
   Der aktive Dispatcher in
   `rust/crates/betaclaw-gateway/src/families/master/skills.rs:149` ruft weiterhin
   `python_execute` und `playwright_cli` auf. Deren Implementierungen benötigen
   `python3` beziehungsweise `node` oder `npx playwright`.
   Im vorhandenen lokalen Image `betaclaw-gateway-local:latest` sind Python,
   Node, npx, Playwright und Chromium ebenfalls nicht vorhanden. Python-Aufrufe
   und Playwright-CLI-Aufrufe scheitern damit trotz gültiger Freigabe.
   Die benötigten Tool-Laufzeiten müssen im Auslieferungskonzept erhalten und
   mit dem Ziel eines Node-freien Backends vereinbart werden.

4. **P1 – Der Node-Scheduler beachtet den gemeinsamen Besitzer nicht (F2/A1).**
   `scheduler.ts:71` startet den Swarm bereits bei `SWARM_RUNNER=scheduler`.
   `BETACLAW_SWARM_RUNNER=off|rust` und der Node-Notschalter werden dort nicht
   ausgewertet. Damit bedeutet `off` im Node-Scheduler nicht aus; bei einem
   parallelen Rust-Scheduler können beide denselben Swarm bearbeiten.
   Auch dieser Einstieg muss `resolveJobOwner` verwenden.

5. **P1 – Die Routenprüfung liefert falsche Sicherheit (F9/C4).**
   `scripts/verify/route-coverage.mjs:30` enthält weiterhin eine feste Präfixliste.
   Es werden weder Rust-Router noch HTTP-Methoden gelesen. Gegenprobe mit einer
   isolierten, erfundenen Route `api/auth/definitely-missing` mit `DELETE`:
   Ausgabe »100 %«, Exit 0, obwohl kein Handler existiert. Die neue CI-Anbindung
   ändert daran nichts. Erforderlich ist der echte Pfad-/Methodenabgleich samt
   negativem Selbsttest.

6. **P1 – Der Fixture-Freshness-Check in CI kann nicht stabil bestehen (C1).**
   `.github/workflows/ci.yml:223` erzeugt die NextAuth-Fixtures neu und verlangt
   danach einen leeren Git-Diff. Der Generator erzeugt dabei zufällige JWEs und
   CSRF-Werte. Zwei unmittelbar aufeinanderfolgende Generierungen in einer
   Wegwerfkopie ergaben unterschiedliche Dateien. Ein regenerierter Zufallswert
   ist kein geeigneter Byte-Freshness-Vergleich. Der Check muss Kompatibilität
   validieren oder kontrolliert reproduzierbare Eingaben verwenden. Der stille
   CSRF-Eigenbau-Fallback im Generator muss außerdem entfallen (F7).

7. **P1 – Der Produktions-Smoke prüft noch die alte Topologie.**
   `scripts/e2e/run-production-smoke.mjs:46` baut das Node-Root-Dockerfile.
   `docker-compose.release-smoke.yml:10` setzt dieses Image für den Scheduler
   ein, übernimmt aber den neuen Compose-Befehl `betaclaw-scheduler`, den das
   Node-Image nicht enthält. Die Probe adressiert außerdem `http://web:3000`
   statt des Rust-Gateways und spätere Prüfungen führen Node im Scheduler aus.
   Der aufgelöste Compose-Plan bestätigt diese Kombination. Der Smoke-Ablauf muss
   auf die neue Auslieferung umgestellt werden; ein erfolgreicher Compose-
   Syntaxcheck beweist diesen Ablauf nicht.

8. **P2 – Auth-Parität und Reverse-Parität bleiben unvollständig (F6/F8).**
   `scripts/verify/parity/families/auth.mjs` fragt ausschließlich Rust ab. Login
   mit gültigem CSRF und Passwort, Sperre, Session mit Cookie, gültiger Logout
   und der TS-Vergleich fehlen. Der Reverse-Test kehrt bei fehlender Fixture
   erfolgreich zurück (`nextauth-reverse-parity.test.ts:12`) und prüft kein
   `getToken` oder CSRF. `tests/nextauth_parity.rs:239` schreibt die zufällige
   Rust-Fixture bei jedem Testlauf ohne Opt-in und ignoriert Schreibfehler.
   Die unabhängigen HTTP-Gegenproben dieses Reviews bestehen, ersetzen aber
   keine dauerhaft wirksamen Regressionstests.

9. **P2 – Laufzeiten werden beim Shutdown sofort abgebrochen (A5).**
   `PersonaPollerHandle::stop` und `SwarmRuntimeHandle::stop` rufen unmittelbar
   `JoinHandle::abort()` auf. Das äußere Fünf-Sekunden-Timeout in `main.rs`
   wartet deshalb nicht auf den Abschluss laufender Runden. Stopp signalisieren,
   Runde mit Zeitlimit abwarten und erst danach abbrechen. Ein entsprechender
   Shutdown-Test fehlt.

10. **P2 – Statische Auslieferung und Seiten-Weiche sind nur teilweise fertig.**
    `static_ui.rs:149` liest Dateien vollständig vor der ETag-Prüfung; `ServeDir`,
    Range-Unterstützung und Kompression fehlen. Der Modus wird pro Request neu
    gelesen. HTTP-Gegenproben: Range liefert 200 statt 206; eine unbekannte API
    im statischen Modus liefert 502 statt JSON-404; eine gültige Session bei
    `REQUIRE_AUTH=false` lässt `/login` mit 200 statt der geforderten 302 zurück.
    Eine ungültige Chunk-Session löscht nur das Haupt-Cookie, nicht `.0`/`.1`.

11. **P2 – `dev:static` übernimmt vorhandene veraltete Exporte (F21/D3).**
    `scripts/dev-stack-rust.mjs:379` baut nur, wenn `out/index.html` fehlt.
    Nach Änderungen an der UI wird sonst der alte Export gemountet.
    Der zugesagte Build vor dem Start muss auch bei vorhandenem `out/` erfolgen.

12. **P2 – Abschlussdokumentation widerspricht weiterhin dem Code (F25/F).**
    Trotz korrigierter Einleitung meldet
    `docs/RUST_NODE_ELIMINATION_PLAN.md:276` Block A als abgeschlossen und Zeile
    289 behauptet eine AST-basierte Coverage sowie echte Auth-Kreuztests.
    `docs/RUST_MIGRATION.md:3` meldet weiter »vollständig abgeschlossen (100 %)«,
    `AGENTS.md:212` weiterhin 100 % native Requests. Die betroffenen Aussagen
    müssen mit dem offenen Register übereinstimmen.

## Vollständiger Abgleich F1–F25

»Umgesetzt« bezeichnet hier den überprüften Codeumfang des jeweiligen Befunds,
nicht die vollständige Produktionsabnahme des gesamten Blocks.

| Punkt | Ergebnis                              | Nachweis / Rest                                                                                                                                                                   |
| ----- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1    | Teilweise, funktionaler Fehler        | Echter Inbound verdrahtet; Fehler-Offset falsch, Attrappen-Test und injizierbare Basis fehlen; eigener DB-Pfad, feste Update-Liste und wiederholte Duplikatwarnung bleiben.       |
| F2    | Teilweise                             | Gateway/Node-Server-Schalter und Tabellentests vorhanden; Node-Scheduler umgeht die Regel. Rust-Logs melden bei `off` irreführend `owner=node`.                                   |
| F3    | Offen                                 | Kein Turn-Dispatch, keine Completion, kein Retry, keine Swarm-Paritätsfamilie.                                                                                                    |
| F4    | Im Code umgesetzt                     | Dev-Start setzt Proxy-Modus; Next-Upgrade-Pfad vorhanden. Browser-HMR nicht erneut geprüft.                                                                                       |
| F5    | Umgesetzt                             | Origin-Vergleich und negative Redirect-Tests vorhanden; Rust-Gate grün.                                                                                                           |
| F6    | Teilweise                             | `decode`-Test vorhanden, aber stiller Erfolg ohne Fixture, keine eingecheckten `getToken`-/CSRF-Gegenprüfungen; unkontrolliertes Schreiben der Fixture. Manuelle Gegenprobe grün. |
| F7    | Teilweise                             | Echtes `createCSRFToken`, aber eigener stiller Fallback; kein Handler-/Set-Cookie-Fixture mit `%7C`. Rust akzeptiert `%7C` im realen Login.                                       |
| F8    | Offen                                 | Nur Rust-Anfragen; kein TS-Vergleich, keine vollständigen Erfolgs-/Sperr-/Logout-Fälle.                                                                                           |
| F9    | Offen                                 | CI-Schritt vorhanden, Verifier prüft weiter nur Präfixe. Negativprobe fälschlich grün.                                                                                            |
| F10   | Im Code umgesetzt                     | `build` und `build:export` getrennt; Gateway-Dockerfile nutzt Export, Root-Dockerfile normalen Build. Beide Frontend-Builds nicht erneut ausgeführt.                              |
| F11   | Teilweise                             | Root-Weiche vor Modusprüfung; Rust-HTTP-Test grün. Login-Weiche hängt weiterhin an `REQUIRE_AUTH`; vollständige Testmatrix fehlt.                                                 |
| F12   | Code umgesetzt, Tests unvollständig   | Leere/gesperrte Versuche zählen nicht zusätzlich. HTTP-Sperrprobe besteht; genaue Zählerprüfungen fehlen.                                                                         |
| F13   | Code umgesetzt, Test fehlt            | POST und `without_url()` an beiden Poller-HTTP-Fehlergrenzen vorhanden. Kein Token-Leak-Regressionstest.                                                                          |
| F14   | Offen                                 | Keine Kompressionsfeatures/-Layer und keine vorkomprimierten Exporte im Gateway-Pfad.                                                                                             |
| F15   | Teilweise                             | ETag/304 im HTTP-Test bestätigt; eigenes Ganzdatei-Lesen, keine Range-Auslieferung und kein `ServeDir`.                                                                           |
| F16   | Teilweise                             | Verzeichnis gecacht; `UiMode::from_env` und bei automatischem Modus `exists()` weiter pro Request.                                                                                |
| F17   | Umgesetzt                             | CSRF liefert Cache-Control, Pragma und Expires; Cache-Control auch per HTTP bestätigt.                                                                                            |
| F18   | Code umgesetzt, Regressionstest fehlt | Gemeinsame Cookie-Helfer und konfigurierte URL maßgeblich. Manipuliertes `x-forwarded-proto` ändert im HTTP-Test Name/Secure nicht.                                               |
| F19   | Umgesetzt                             | Node-Kurzschluss auf `/__node/health` verschoben; `/api/health` geht an die Anwendung.                                                                                            |
| F20   | Im Code umgesetzt                     | Ungefragtes Entfernen der Rust-Config-DB entfernt; Restore über Config-API im normalen Ablauf vorhanden. Vollständige Config-Parität nicht erneut ausgeführt.                     |
| F21   | Teilweise                             | Host-Export wird gemountet, aber ein vorhandener alter Export verhindert den Neubau.                                                                                              |
| F22   | Umgesetzt                             | pnpm 10.30.1 gepinnt; NODE_ENV nach Installation gesetzt.                                                                                                                         |
| F23   | Offen                                 | Test in `static_ui.rs:334` verändert weiterhin die Prozessumgebung.                                                                                                               |
| F24   | Teilweise                             | Formate, Fehlerantworten, JSON-Flag und IP-Auswertung korrigiert. Ungültige Session-Chunks werden nicht gelöscht; HTTP-Reproduktion bestätigt.                                    |
| F25   | Teilweise                             | Schalter dokumentiert und Warnungen ergänzt; widersprechende Abschluss-/Coverage-Aussagen bleiben.                                                                                |

Damit: **7 Punkte im Code umgesetzt, 13 teilweise und 5 offen**. Auch bei den
umgesetzten Punkten gelten die ausdrücklich genannten Prüfgrenzen.

A4 verwendet `spawn_blocking`; der geforderte Laufzeittest für aktive/verwaiste
Verzeichnisse und `max_removals` fehlt im Gateway-Modul. Cleanup wird zudem sowohl
im Gateway als auch im Rust-Scheduler gestartet, obwohl der Plan den Scheduler
als Ausführungsort nennt. A5, E7 und der neue Benchmark bleiben offen.

## Ausgeführte Prüfungen

Alle Checks liefen in vorhandenen Containern/Toolchain-Images. Rust-Tests liefen
auf einer isolierten Quellkopie; Testdaten lagen ausschließlich im jeweiligen
Wegwerfcontainer. Vorhandene App-Daten und Dienste wurden nicht verändert.

| Prüfung                                                                                                             | Ergebnis                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cargo fmt --all -- --check`                                                                                        | Bestanden.                                                                                                                                         |
| `cargo test --workspace --locked --offline --features betaclaw-gateway/test-support`                                | 3.514 bestanden: 2.986 Core, 509 Gateway, 8 HTTP, 1 Gemini-Fixture, 10 NextAuth.                                                                   |
| `cargo clippy --workspace --all-targets --features betaclaw-gateway/test-support --locked --offline -- -D warnings` | Bestanden.                                                                                                                                         |
| `cargo build --workspace --locked --offline`                                                                        | Bestanden; gebautes Gateway für die HTTP-Prüfungen gestartet.                                                                                      |
| `tsc --noEmit --incremental false`                                                                                  | Bestanden.                                                                                                                                         |
| `oxlint . --threads=1`                                                                                              | 0 Fehler, 0 Warnungen.                                                                                                                             |
| Vitest: `job-owner.test.ts`, `nextauth-reverse-parity.test.ts`                                                      | 7 Tests bestanden.                                                                                                                                 |
| Echter Rust-HTTP-Login mit synthetischem Testkonto                                                                  | Login, Session, 10 falsche Passwörter und anschließende Sperre, Logout bestanden.                                                                  |
| Rust-Token an echtes `next-auth/jwt`                                                                                | `decode` und `getToken` akzeptieren den aktuellen Rust-Token.                                                                                      |
| Rust-CSRF an echtes NextAuth                                                                                        | `createCSRFToken` bestätigt Cookie/Body; Rust-Login akzeptiert `%7C`.                                                                              |
| Cookie-/Cache-Header, ETag/304                                                                                      | Gezielte HTTP-Prüfungen bestanden.                                                                                                                 |
| Negativproben statische UI                                                                                          | Abweichungen bei Range, fehlender API, Login-Weiche und ungültigen Cookie-Chunks bestätigt.                                                        |
| Routen-Verifier                                                                                                     | Bestehender Baum meldet 113/113; erfundene Route ebenfalls fälschlich als abgedeckt akzeptiert.                                                    |
| Fixture-Generator zweimal in Temp-Verzeichnis                                                                       | Unterschiedliche Ausgaben; Byte-Freshness-Check nicht reproduzierbar.                                                                              |
| Release-Smoke-Compose                                                                                               | Syntax gültig; aufgelöste Dienste zeigen inkompatible Kombination aus Node-Image und Rust-Scheduler-Kommando. Vollständiger Smoke nicht gestartet. |
| Vorhandenes lokales Gateway-Image                                                                                   | Fehlende Python-/Playwright-Laufzeiten bestätigt; Image nicht neu gebaut.                                                                          |

Nicht ausgeführt: vollständige TS-Suite, gesamte Routen-Parität,
Browser-E2E/HMR, beide Frontend-Builds, neuer Release-Image-Build,
Produktions-Smoke, Live-Telegram-/Provider-/PostgreSQL-Abnahme und Benchmark.
Diese Prüfung beweist keine vollständige Backend-Parität oder Produktionsfreigabe.
