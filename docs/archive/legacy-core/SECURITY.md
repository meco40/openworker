# Sicherheitskonzept

Sicherheit hat im OpenClaw Gateway oberste Priorität, da autonome Agenten potenziell sensible Systembefehle ausführen können.

## 1. Kommando-Whitelist

Alle vom Agenten angeforderten Terminal-Befehle werden gegen eine Whitelist in `constants.ts` geprüft.

- **Low Risk**: (z.B. `ls`, `pwd`) - Werden automatisch genehmigt.
- **Medium Risk**: (z.B. `mkdir`, `npm install`) - Erfordern Monitoring.
- **High Risk**: (z.B. `rm -rf`) - Sind standardmäßig deaktiviert und erfordern manuelles Override.

## 2. Sandbox-Isolierung

Jeder Worker-Node operiert in einem isolierten logischen Workspace. Der Zugriff auf das Host-Dateisystem ist auf das Verzeichnis `~/.openclaw/workspaces/` beschränkt.

## 3. Remote Exposure

Die Fernsteuerung via "Exposure Manager" nutzt verschlüsselte Tunnel (Tailscale Funnel oder SSH-Reverse-Tunnels), um eine sichere Verbindung ohne offene Ports am Router zu ermöglichen.
