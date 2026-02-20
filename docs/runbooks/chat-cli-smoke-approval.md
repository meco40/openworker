# Chat CLI Approval Smoke Test

Validiert lokal den kompletten Flow:

1. User sendet Chat-Nachricht via Gateway `chat.stream`
2. Agent fordert bei `shell_execute` Approval an (`approval_required`)
3. Approval wird via `chat.approval.respond` gesendet
4. Agent liefert die finale Antwort nach Tool-Ausfuehrung

## Voraussetzungen

- Server laeuft (`npm run dev` oder `npm run start`)
- `shell_execute` Skill ist installiert
- Fuer echten Approval-Flow:
  - `OPENCLAW_EXEC_APPROVALS_REQUIRED=true`

## Quick Start

```bash
npm run smoke:chat-cli-approval -- --message "Nutze shell_execute und fuehre den Befehl echo smoke-test aus."
```

Deterministisch ohne Modell-Tool-Auswahl:

```bash
npm run smoke:chat-cli-approval -- --message "/shell echo smoke-test"
```

## Optionen

- `--url <ws-url>` (default: `ws://127.0.0.1:${PORT|3000}/ws`)
- `--conversation <id>` (optional; ohne Angabe wird `sessions.reset` genutzt)
- `--persona <id>` (optional)
- `--message "<text>"` oder Nachricht als trailing text
- `--decision approve_once|approve_always|deny|skip` (default: `approve_once`)
- `--wait-ms <n>` Poll-Intervall fuer finale Antwort (default: `1200`)

## Beispiele

```bash
# Approval einmalig
npm run smoke:chat-cli-approval -- --decision approve_once --message "Nutze shell_execute und fuehre echo smoke-1 aus."

# Approval dauerhaft
npm run smoke:chat-cli-approval -- --decision approve_always --message "Nutze shell_execute und fuehre echo smoke-2 aus."

# Nur Token/Prompt pruefen, nichts bestaetigen
npm run smoke:chat-cli-approval -- --decision skip --message "Nutze shell_execute und fuehre echo smoke-3 aus."
```

## Erwartetes Ergebnis

- Streaming-Ausgabe erscheint direkt im Terminal
- Script erkennt `approval_required`
- Bei `approve_once`/`approve_always` wird `chat.approval.respond` erfolgreich ausgefuehrt
- Finale Agent-Antwort (nach Tool-Run) wird ausgegeben
