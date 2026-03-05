# Engineering Operating Model (Harness v2)

## Ziel

Dieses Modell legt fest, wie Mensch und Agent gemeinsam liefern:
kleine PRs, harte Sicherheits-Gates, asynchrone Qualitäts-Nachläufe und klare Eskalation.

## Rollen

1. Agent:

- implementiert innerhalb definierter Domänenverträge,
- liefert reproduzierbare Verifikation,
- dokumentiert Risiken, Rollback und Async-Follow-ups.

2. Mensch:

- entscheidet bei Architektur-, Security- und Datenmodelländerungen,
- priorisiert Risiken und Escalations,
- validiert Trade-offs bei grossen oder weitreichenden Änderungen.

## Gate-Model

1. Blocking Gates (Merge-blockierend):

- `typecheck`
- `lint`
- Unit/Integration
- `e2e:smoke`

2. Async Gates (nicht merge-blockierend):

- Coverage
- Browser E2E
- Live E2E
- Flaky-Detection

Regel: Async-Fehler erzeugen innerhalb von 24h einen Follow-up-Task mit Owner.

## Triage-Rhythmus

1. Täglich 15 Minuten:

- Async-Fehler sichten
- Owner + ETA setzen
- wiederkehrende Ausfälle priorisieren

2. Wöchentlich:

- Durchsatz- und Stabilitätsmetriken reviewen
- Top-3 Reibungspunkte mit klaren Gegenmassnahmen planen
