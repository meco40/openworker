# BetaClaw-Konfiguration

Das Projekt verwendet ausschließlich BetaClaw als Namen. Technische Schreibweisen sind `betaclaw`, `betaClaw` und `BETACLAW`. Es gibt keine Alias-Namen oder Kompatibilitäts-Fallbacks.

- API-Pfade: `/api/betaclaw` und `/api/agents/[id]/betaclaw`.
- Session-Tabelle und Feld: `betaclaw_sessions`, `betaclaw_session_id`.
- Umgebungsvariablen: `BETACLAW_*`.
- Browser-Speicher: `betaclaw-active-persona`, `betaclaw.coupledChannels.v1`.
- Gateway-Datei: `~/.betaclaw/betaclaw.json`.
- Benutzer-Skills: `~/.config/betaclaw/skills`.
- Dienste und Container: `betaclaw-*`.

Externe Clients und bestehende Installationen müssen diese Namen verwenden. Die lokale Session-Tabelle wurde nach privater Sicherung umbenannt; sie enthält keine Sitzungsdatensätze. Die lokale Connector-Secrets-Tabelle enthält keine Secrets.

Bestehende Browser-Einstellungen unter abweichenden Schlüsseln werden nicht automatisch übernommen. Die lokalen Graphiti-Projektionen sind bereits transaktional auf die neuen Gruppenkennungen und UUID-Referenzen umgestellt. Andere Installationen mit verschlüsselten Connector-Zugangsdaten benötigen eine kontrollierte Schlüsselumstellung, bevor sie die neue Ableitung verwenden.

Die fünf lokalen Dienstcontainer und ihre aktiven Netzwerk-Aliase verwenden ebenfalls die neuen Namen. Externe Produktionsdienste wurden nicht umgestellt. Historische Git-Commits, externe Repositories und generierte alte Test-/Build-Berichte wurden nicht umgeschrieben.

## Verifizierter lokaler Datenbestand

Die verbleibenden 218 Textfelder in vier SQLite-Dateien sind umbenannt. Alle 304 Graphiti-Knoten und 431 Beziehungen sind erhalten; UUID-Referenzen passen weiterhin zu den tatsächlichen Endpunkten. Alle 158 Episoden sind über die API unter den neuen Gruppenkennungen abrufbar. Wiederholte Scans über SQLite, Neo4j und beide PostgreSQL-Datenbanken melden keine alten Bezeichner. Private Wiederherstellungssicherungen sind vor den Änderungen erstellt und nicht für die Veröffentlichung vorgesehen.
