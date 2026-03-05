# Agent Engineering Index

## Metadata

- Purpose: Zentrales Einstiegspunkt-Dokument fuer Harness-Engineering, Agent-Legibility und Delivery-Standards.
- Scope: Merge-Modell, Agent-Harness, Domänenverträge, Governance und Betriebsmodell.
- Source of Truth: Diese Seite verweist auf die verbindlichen Agent-Engineering-Dokumente fuer Mission Control + Chat.
- Last Reviewed: 2026-03-04

---

## Verbindliche Referenzen

- `docs/contracts/MISSION_CONTROL_AGENT_CONTRACT.md`
- `docs/contracts/CHAT_AGENT_CONTRACT.md`
- `docs/ENGINEERING_OPERATING_MODEL.md`
- `docs/runbooks/AGENT_VERIFY_HARNESS.md`
- `docs/TECH_DEBT_REGISTER.md`

## Governance-Regeln

1. Domänenänderungen in Mission Control oder Chat erfordern Review gegen den zugehörigen Domänenvertrag.
2. `Last Reviewed` in den Contract-Dokumenten darf maximal 30 Tage alt sein.
3. Blocking Gates sind in `.github/workflows/ci.yml` verbindlich, Async Gates in `.github/workflows/async-quality.yml`.
