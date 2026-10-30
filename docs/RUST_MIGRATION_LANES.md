# Rust-Migration: Bahnen, Abhängigkeiten und Umsetzungsstand

Begleitdokument zu `docs/RUST_MIGRATION.md` und `.tmp/s8s9s10-plan.md`. Es hält die
**gemessenen** Fakten einer Mehragent-Umsetzung fest, damit sie einen Verlust der
flüchtigen `.tmp`-Arbeitsdateien (sie sind gitignored) überleben.

> Rekonstruiert am 2026-10-11, nachdem eine parallele Session `.tmp/` vollständig
> entfernt hat (`.tmp/s8s9s10-plan.md`, `.tmp/s6s7-plan.md` und der Verifier-Report
> `.tmp/verify-contract-inventory.md` sind verloren). Enthalten ist nur, was im Code,
> in `git log` oder per Kommando nachprüfbar ist.

## 1. Rangfolge (azyklisch)

```text
S6 → S7 → S8 → S10 → S9
```

Belegte Kanten (Datei-Ebene, nicht Slice-Ebene):

| Kante            | Beleg                                                                                                                             | Umfang        |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| S7 → S6          | `src/server/knowledge/ingestion/{messageProcessor,service,factExtractor,taskCompletion}.ts` importieren `@/server/world-model/**` | 4 Dateien     |
| S8 → S6, S7      | Recall-/Inbound-Pfade von `channels/**`                                                                                           | —             |
| S9 → S4, S6, S10 | `masterActionBridge` ×3, `model-hub/runtime` ×1, `automation/runtime` ×1 über `master/cronBridge.ts:3`                            | 4 Konsumenten |
| S10 → S8         | `executeDispatch.ts:16` → `client.call('chat.send')`                                                                              | 1 Aufruf      |

## 2. Bahnen bei laufendem S6

| Bahn | Inhalt                                                                             | Zulässig ab | Fremdkontakt                                    |
| ---- | ---------------------------------------------------------------------------------- | ----------- | ----------------------------------------------- |
| A    | S6-Rest (`world_model/**`)                                                         | läuft       | —                                               |
| B    | S7 **ohne** die 4 Ingestion-Dateien (≈91 Dateien, ≈8k Zeilen)                      | jetzt       | eigener Baum `knowledge/**`                     |
| C    | S9-Portierung ohne `cronBridge.ts` und ohne die 3 `masterActionBridge`-Konsumenten | jetzt       | eigener Baum `master/**`                        |
| D    | S8-Dispatch (braucht S6+S7) → danach S10-Dispatch                                  | nach A+B    | `gateway_methods.rs`, `routes/mod.rs`, `lib.rs` |

Gegenprobe für Bahn B: ein `Select-String -Pattern 'world-model'` über
`src/server/knowledge/retrieval/**` liefert **0 Treffer** — `retrieval/**` ist also
nicht S6-gekoppelt. Nur die vier oben genannten Ingestion-Dateien sind es.

**Guardrails:** (1) S6 zuerst committen/stashen; (2) ein Owner pro geteilter Datei
(`lib.rs`, `Cargo.toml`, `Cargo.lock`, `routes/mod.rs`, `gateway_methods.rs`,
`docs/RUST_MIGRATION.md`); (3) eigene Worktrees mit eigenem `target`-Volume, weil
Cargo das `target`-Verzeichnis sperrt; (4) Runtime-Verdrahtung bleibt seriell.

## 3. Gate-Befehle (korrigiert)

- `cargo fmt --all -- --check`
- `cargo clippy -p betaclaw-core --all-targets -- -D warnings`
- `cargo test -p betaclaw-core`

`--features test-support` existiert **nur** in `betaclaw-gateway`; `betaclaw-core`
hat keine Features. Ein Gate mit `cargo test -p betaclaw-core --features test-support`
schlägt fehl und ist kein Testfehler.

Alle Befehle laufen über das gepinnte Image `rust:1.94-bookworm`:

```text
docker run --rm -v <CHECKOUT>\rust:/app \
  -v betaclaw-cargo-registry:/usr/local/cargo/registry \
  -v <TARGETVOLUME>:/app/target -v betaclaw-rustup:/usr/local/rustup \
  -w /app rust:1.94-bookworm <cargo-befehl>
```

## 4. Stand der Umsetzung

| Bahn          | Basis                              | Stand                                                                                   |
| ------------- | ---------------------------------- | --------------------------------------------------------------------------------------- |
| Snapshot      | `0c2a3254`                         | S4/S5- und S6-WIP eingefroren, `cargo fmt --all` normalisiert                           |
| Gerüst        | `548f1710`                         | `pub mod knowledge` / `pub mod master` plus Modulwurzeln                                |
| B (`lane/s7`) | `7872e122`, `1b84448e`             | P0+P1 portiert (15 Dateien / 5.313 Zeilen), grün; Retrieval-Modulkopf korrigiert        |
| C (`lane/s9`) | `d8475fd2`, `510f8e8f`, `5829fd42` | P0+P1+P2+P3+P4 portiert, grün                                                           |
| Isolation     | —                                  | `.worktrees/s7`, `.worktrees/s9`, eigene Volumes `betaclaw-target-lane-s7` / `-lane-s9` |

## 5. Offene Punkte (Auszug)

- **OP-S9-3:** `master/cronBridge.ts:3` liest `automation/runtime` (S10) — Pfad bleibt
  bis S10 in TypeScript.
- **OP-S9-4:** `masterActionBridge` (S6) wird an 3 Stellen von S9 konsumiert
  (`connectors/gmail/actions.ts:8`, `execution/runtime/toolRunner.ts:10`,
  `app/api/master/gmail/route.ts:8`) — in Bahn C zunächst ausgelassen.
- **OP-S9-5 (erledigt):** Clippy 1.94 verwirft das manuelle
  `impl Default for ProspectiveRuntimeDeps` in
  `world_model/runtime/prospective_runtime.rs` unter `-D warnings`
  (`clippy::derivable_impls`). Fix `#[derive(Default)]`; im Hauptbaum durch die
  parallele Session, in `lane/s7` (`866ad265`) und `lane/s9` (`c9e48438`) durch den Lead.
- **OP-S10-1:** Der Scheduler startet Worker aus S6/S7; `betaclaw-scheduler` kann erst
  vollständig werden, wenn diese Worker in Rust existieren.
- **OP-S10-2:** Die Task-Planungsrouten rufen `chat.send` über den WS-Client; S10 muss
  den In-Process-Aufruf neu verdrahten (kein zweiter WS-Client).

## 6. Mehragentige Umgebung

Parallel existierte ein Worktree `.worktrees/s11-s12` (`lane/s11-s12`) einer anderen
Session. Bahnen B/C berühren nur `knowledge/**` und `master/**` und sind davon
dateidisjunkt. Geteilt bleiben ausschließlich `lib.rs`, `Cargo.toml`, `Cargo.lock`,
`routes/mod.rs`, `gateway_methods.rs` und `docs/RUST_MIGRATION.md`; sie werden
zentral (vom Lead) geändert.

## 7. Verifikationsbefunde (unabhängig, fortzuschreiben)

### `lane/s7` @ `e60f25f6` — Verdict PASS

- Gates: `cargo fmt --all -- --check` exit 0; `cargo clippy -p betaclaw-core
--all-targets -- -D warnings` exit 0; `cargo test -p betaclaw-core`
  1448 passed / 0 failed / 0 ignored.
- S6-Entkopplung bestätigt: 0 Treffer für `world_model` im Rust-Baum
  `knowledge/**`; 0 Treffer für `world-model` in
  `src/server/knowledge/retrieval/**`; in `src/server/knowledge/**` nur die vier
  Ingestion-Dateien.
- Fidelity: Header-Spannen, Sortier-/Numerik-Semantik (`Math.round` über
  `floor(x+0.5)`, `Number.isFinite`, Clamp-Reihenfolge `min(max*3, max(max,dyn))`)
  und die Prompt-/Fehlertexte stimmen mit der Quelle.
- Befunde (Dokumentation, nicht verhaltensrelevant):
  - Off-by-one in den Zeilenspannen von fünf Modulköpfen:
    `answer_safety_policy.rs` (62 statt 63), `recall_scoring.rs` (59 statt 60),
    `token_budget.rs` (49 statt 50), `retrieval/service/ranking/scoring.rs`
    (6 statt 5), `multilingual_aliases.rs` (39 statt 40).
  - `js_round` ist doppelt implementiert (`crate::js` und
    `crate::memory::validators`), beide `floor(x + 0.5)`; die Drift-Gefahr ist im
    Modulkopf nicht vermerkt.
  - `retrieval/formatters/context_formatter.rs` fügt jede Entity-Id ein, die
    TypeScript-Quelle prüft `if (e.id)`. Ohne beobachtbare Wirkung (leere Id).
  - Worktree-Hygiene: 13 `.rs` waren zum Verifikationszeitpunkt untracked und in
    `mod.rs` nicht deklariert.

### `lane/s9` @ `5829fd42` — Verdict PASS

- Gates: `cargo fmt --all -- --check` exit 0; `cargo clippy -p betaclaw-core
--all-targets -- -D warnings` exit 0 (0 Warnungen);
  `cargo test -p betaclaw-core` 1545 passed / 0 failed.
- 16 Fidelity-Stichproben über `approvals/`, `delegation/` und `execution/`;
  Ausnahmen belegt: `tool_runner.rs` fehlt (OP-S9-4), `cron_bridge.rs` fehlt
  (OP-S9-3), die Delegation importiert ausschließlich `crate::master::*` und
  `super::*` (S8-Naht ist `orchestrator::DelegationDispatcherPort`).
- Offener Doku-Punkt: `docs/RUST_MIGRATION.md` führt S9 weiter als „offen" und
  kennt kein `OP-S9-*`, obwohl der Code `OP-S9-4/5/11/12/13/15` zitiert. Die
  Statusmatrix wird beim Merge der Bahnen zentral nachgezogen.
