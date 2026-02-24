# Project Workspace E2E Checklist (WebUI + Telegram)

## Ziel

Validieren, dass Conversation-scope Projektverwaltung, Guard-Approval und Workspace-CWD über WebUI und Telegram konsistent funktionieren.

## Voraussetzungen

- Gateway läuft lokal.
- Ein User mit aktiver Persona ist verfügbar.
- Telegram Channel Binding ist verbunden.
- Optional: `OPENCLAW_EXEC_APPROVALS_REQUIRED=true` für `/shell`-Approval-Checks.

## Test A: Projekt anlegen in WebUI und im gleichen Conversation-Kontext nutzen

1. In WebUI eine bestehende Conversation öffnen.
2. Persona aktivieren (falls nicht bereits aktiv).
3. `/project new Notes` senden.
4. Erwartung:
   - Antwort bestätigt neues Projekt.
   - `/project status` zeigt das neue Projekt als aktiv.
5. Eine Build/Code-Anfrage senden (z. B. "Erstelle eine Next.js Notes App").
6. Erwartung:
   - Kein Project-Guard-Block.
   - Anfrage läuft normal weiter.

## Test B: Kein aktives Projekt -> Guard in WebUI

1. In derselben Conversation `/project clear` senden.
2. Build/Code-Anfrage senden.
3. Erwartung:
   - Antwort mit Guard-Warnung.
   - Metadata enthält `status=approval_required` und Token.
4. In WebUI "Approve once" klicken.
5. Gleiche Build/Code-Anfrage erneut senden.
6. Erwartung:
   - Anfrage wird jetzt ausgeführt (kein erneuter Guard).
7. `/project new Scratch` senden.
8. Build/Code-Anfrage erneut senden.
9. Erwartung:
   - Läuft im aktiven Projekt.
   - Frühere "ohne Projekt"-Freigabe ist effektiv zurückgesetzt.

## Test C: Telegram Text-Approval (`/approve`, `/deny`)

1. In Telegram dieselbe Conversation verwenden (oder per `/project use <id|slug|index>` verbinden).
2. `/project clear` senden.
3. Build/Code-Anfrage senden.
4. Erwartung:
   - Guard-Warnung mit Token.
5. `/deny <token>` senden.
6. Erwartung:
   - Ablehnungsbestätigung.
   - Nächste Build/Code-Anfrage wird erneut geblockt.
7. `/approve <token>` senden (mit neuem oder gültigem Token).
8. Erwartung:
   - Freigabe-Bestätigung.
   - Nächste Build/Code-Anfrage läuft.

## Test D: Conversation-Scoped Verhalten bei Channel-Wechsel

1. In WebUI Conversation X mit aktivem Projekt `notes` verwenden.
2. In Telegram separate Conversation Y (ohne aktives Projekt) verwenden.
3. In X Build/Code-Anfrage senden.
4. In Y Build/Code-Anfrage senden.
5. Erwartung:
   - X läuft ohne Guard (aktives Projekt vorhanden).
   - Y zeigt Guard (kein aktives Projekt in Y).

## Test E: Workspace-CWD für Toolläufe

1. In Conversation mit aktivem Projekt `/shell pwd` (oder Windows: `/shell Get-Location`) senden.
2. Erwartung:
   - Ausgabe zeigt Projekt-Workspace-Pfad.
3. KI-Tool-Aufruf provozieren (z. B. "Liste Dateien im aktuellen Ordner und fasse zusammen").
4. Erwartung:
   - Toollauf erfolgt im gleichen Projekt-Workspace.
5. Optional Approval-Replay:
   - Shell-Approval triggern.
   - Approval geben.
   - Verifizieren, dass Replay ebenfalls im Projekt-Workspace läuft.

## Abnahmekriterien

- `/project`-Status bleibt pro Conversation getrennt.
- Guard erscheint nur bei Build/Code-Intent ohne aktives Projekt und ohne vorhandene Guard-Freigabe.
- `/approve`/`/deny` funktionieren in textbasierten Channels.
- Nach Projektwechsel/-setzung ist Guard-Bypass-ohne-Projekt zurückgesetzt.
- Toolausführung nutzt in allen Pfaden den aktiven Projekt-Workspace-CWD.
