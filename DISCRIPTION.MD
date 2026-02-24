# OpenClaw WebApp - Einfache Beschreibung

## Was ist diese WebApp?

OpenClaw ist eine WebApp fuer KI-Chat, Automatisierung und Betrieb.
Du kannst mehrere Messenger verbinden, mit Personas arbeiten, Projekte steuern und KI-Modelle verwalten.

Die App ist wie ein zentrales Control Center fuer:

- Chat mit KI
- Messenger-Anbindung
- Skill-Tools
- Memory und Knowledge
- Ops, Sicherheit und Konfiguration

## Alle Funktionen (uebersichtlich)

### 1. Control Plane

- Zeigt Systemstatus (Uptime, Sessions, Tokens).
- Zeigt geplante Aufgaben (Scheduler/Cron).
- Zeigt Event- und Lern-Stream.
- Zeigt Personality-Matrix (Uebersicht ueber Fokus/Entwicklung).

### 2. AI Model Hub

- Verwalten von KI-Providern und Accounts.
- Verbinden per API-Key, OAuth oder ohne Key (lokal, je nach Provider).
- Live-Modelle eines Accounts laden.
- Chat-Pipeline verwalten:
- Modell hinzufuegen, entfernen, priorisieren (reorder), aktiv/offline schalten.
- Embedding-Pipeline verwalten:
- Eigene Embedding-Modelle hinzufuegen, entfernen, priorisieren, aktiv/offline schalten.
- Verbindungstest:
- Einzeltest pro Account und Sammeltest fuer alle Accounts.

### 3. Messenger Coupling

- Kanaele koppeln und trennen (Pairing/Disconnect).
- Unterstuetzte Bridge-UI-Kanaele:
- WhatsApp, Telegram, Discord, iMessage, Slack.
- Telegram Pairing-Code bestaetigen.
- Telegram Polling-Fallback.
- WhatsApp Allowlist (allowFrom) verwalten.
- Pro Kanal Testnachrichten simulieren.
- Aktivitaets-Log fuer Pairing und Fehler.

### 4. Multi-Channel Inbox (Chat)

- Konversationen anzeigen, erstellen, wechseln, loeschen.
- Nach Kanal filtern und nach Konversation suchen.
- Nachrichten senden und Streaming-Antworten sehen.
- Dateianhang senden (inkl. Drag & Drop).
- Laufende Generierung abbrechen.
- Tool-Freigaben direkt im Chat bestaetigen oder ablehnen.

### 5. Skill Registry

- Installierte Skills anzeigen.
- Skills aktivieren/deaktivieren.
- Externe Skills installieren (z. B. GitHub, npm, manuell).
- Skill-Details anzeigen.
- Skill Runtime-Konfiguration (Secrets/Text) setzen oder loeschen.
- ClawHub-Suche, Install, Update, Uninstall und Enable/Disable.

### 6. Agent Personas

- Personas erstellen, aus Templates anlegen, bearbeiten, duplizieren, loeschen.
- Persona-Metadaten pflegen (Name, Emoji, Vibe).
- Persona-Dateien bearbeiten:
- `SOUL.md`, `AGENTS.md`, `USER.md`, `TOOLS.md`.
- Bevorzugtes Modell pro Persona setzen.
- Memory-Persona-Typ setzen.
- Aktive Persona waehlen.

### 7. Memory

- Persona-spezifische Memory-Eintraege anzeigen.
- Suchen, filtern (Typ), paginieren.
- Eintraege bearbeiten und loeschen.
- Historie pro Eintrag ansehen und aeltere Version wiederherstellen.
- Bulk-Aktionen:
- Mehrere Eintraege gleichzeitig aendern oder loeschen.
- Gesamtes Persona-Memory loeschen.

### 8. Knowledge

- Persona waehlen.
- Knowledge Graph (Entity-Graph) visualisieren.
- Graph neu laden und Details ansehen.

### 9. Cron

- Cron-Regeln erstellen, bearbeiten, aktivieren/deaktivieren, loeschen.
- Cron-Regeln sofort starten (Run now).
- Lauf-Historie ansehen (queued/running/succeeded/failed/dead_letter/skipped).
- Metriken sehen (active, queued, running, dead letter, lease age).
- Flow Builder pro Regel oeffnen.

### 10. Ops: Instances

- Live-Verbindungen sehen (global + pro User).
- Verbindungstelemetrie mit Refresh.

### 11. Ops: Sessions

- Sessions suchen und filtern.
- Session erstellen, umbenennen und loeschen.
- Optionen wie Limit, Aktivitaetsfenster, Include-Flags.

### 12. Ops: Nodes

- Health/Doctor/Automation-Diagnosen.
- Exec-Approvals verwalten (approve, revoke, clear).
- Kanal-Kontrollen ausfuehren (connect/disconnect, secret rotation je nach Kanal).
- Persona je Kanal zuweisen.
- Telegram Pending Pairing ablehnen.
- Channel Bindings tabellarisch anzeigen.

### 13. Ops: Agents

- Persona-Snapshots und Agent-Status anzeigen.
- Refresh fuer aktuelle Laufzeitdaten.

### 14. System Logs

- Live-Logs mit Filtern (Level, Source, Kategorie, Suche).
- Auto-Scroll, Verlaufstiefe und Buffer einstellen.
- Aeltere Logs nachladen.
- Logs exportieren und leeren.
- Diagnosepanel (Health + Doctor) anzeigen und aktualisieren.

### 15. Usage Stats

- Uebersicht zu Requests, Tokens und Modellen.
- Zeitraumfilter (heute, Woche, Monat, custom).
- Tab "Logs" mit Prompt-Logs.
- Tab "Sessions" mit Session-Statistiken und Kanalverteilung.

### 16. Security Panel

- Security-Checks (z. B. firewall/encryption/audit/isolation) anzeigen.
- Status zusammenfassen (OK, Warning, Critical).
- Policy Explain laden und anzeigen.
- Whitelist-Ansicht fuer Command-Regeln (Allow/Blocked umschalten).

### 17. Gateway Config

- Konfiguration laden und bearbeiten.
- Tabs:
- Overview, Network, Runtime, UI, Advanced (Raw JSON).
- Validierung, Diff-Vorschau, Konflikt-Hinweise.
- Aenderungen uebernehmen oder zuruecksetzen.

### 18. Operator Profile

- Profil bearbeiten (Display Name, Kontakt).
- Lokale Limits setzen (z. B. Workspace-Slots, Daily Token Budget).
- Nutzungsanzeige im Profil.

### 19. Conversation Debugger

- Konversationen laden und filtern.
- Turns je Konversation ansehen.
- Detailansicht pro Turn.
- Replay ab bestimmtem Turn starten.

### 20. Task Monitor

- Prozessliste anzeigen (Status, CPU, RAM, Uptime).
- Einzelne Prozesse stoppen (SIGKILL in UI).
- Uebersicht zu Memory/Thread-Auslastung.

## Chat-Befehle (im Chat nutzbar)

- Session:
- `/new`, `/reset`
- Persona:
- `/persona`, `/persona list`, `/persona <name>`, `/persona off`
- Projekt:
- `/project`
- `/project status`
- `/project new <name>`
- `/project list`
- `/project use <id|slug|index>`
- `/project delete <id|slug|index>`
- `/project clear`
- Cron:
- `/cron list`
- `/cron add "<cron>" --tz "<TZ>" --prompt "<Text>"`
- `/cron every "10m|1h|1d" --prompt "<Text>"`
- `/cron pause <id>`
- `/cron resume <id>`
- `/cron remove <id>`
- `/cron run <id>`
- Shell:
- `/shell <command>`, `/bash <command>`, `!<command>`
- Subagents:
- `/subagents list`
- `/subagents spawn <agentId> <task> [--model <model>]`
- `/subagents kill <id|#|all>`
- `/subagents steer <id|#> <message>`
- `/subagents info <id|#>`
- `/subagents log <id|#>`
- `/subagents help`
- Kurzformen:
- `/kill <id|#|all>`, `/steer <id|#> <message>`
- Approvals:
- `/approve <token>`, `/deny <token>`
- Memory Quick Save:
- `Speichere ab: <text>`

## Unterstuetzte KI-Provider

Aktuell sind diese Provider im Model Hub enthalten:

- Google Gemini
- OpenAI
- OpenAI Codex
- Anthropic
- OpenRouter
- Ollama (local)
- LM Studio (local)
- xAI
- Mistral
- Cohere
- Z.AI
- Kimi Code
- ByteDance ModelArk
- GitHub Copilot / Models

## Kurzfazit

Die WebApp deckt den kompletten Ablauf ab:
Chat, Modellverwaltung, Messenger, Skills, Memory/Knowledge, Automatisierung, Debugging, Sicherheit und Ops.
