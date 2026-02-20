# Demo OpenClaw vs. unsere WebApp: Vergleich und umgesetzte Punkte

Stand: 2026-02-20

## 1) Zusammenfassung des vorherigen Vergleichs

Im vorherigen Review wurde der Bereich `demo/openclaw` gegen unsere bestehende Channel-Integration verglichen. Fokus war: Was bringt schnell mehr Stabilitaet, Sicherheit und Betriebsfaehigkeit.

Priorisierte Punkte aus dem Vergleich:

1. Account-Auswahl im Pairing-UI (Account-Selector), damit Multi-Account im Frontend sauber nutzbar ist.
2. Robuste Multi-Account-Verarbeitung fuer WhatsApp (Inbound + Outbound), inkl. klarer Account-Zuordnung und besserer Validierung.
3. Weitere Verbesserungen am Pairing/Operations-Fluss (nicht als erstes priorisiert umgesetzt).
4. Channel Health Monitor mit automatischen Health-Checks und Self-Healing bei Bridge-Problemen.

Bewertung aus dem Vergleich:

- Punkt 2 und Punkt 4 liefern den hoechsten direkten Nutzen fuer Produktion (Zuverlaessigkeit + weniger manuelle Eingriffe).
- Punkt 1 ist wichtig fuer Bedienbarkeit und wurde im Anschluss ebenfalls umgesetzt.

Hinweis: Aeltere, groessere OpenClaw-Vergleiche liegen bereits in:

- `docs/archive/analysis/OPENCLAW_FUNKTIONEN_ANALYSE_WEBAPP.md`
- `docs/openai-agents-sdk-vs-openclaw-tiefenanalyse.md`

## 2) Umgesetzte Aenderungen

## Punkt 2: Multi-Account + robuste WhatsApp-Verarbeitung

### Backend/Domain

- Account-spezifische Credentials/Status/Allowlist eingefuehrt:
  - `src/server/channels/pairing/bridgeAccounts.ts`
  - `src/server/channels/credentials/credentialStore.ts` (`deleteCredential`)
- Pair/Unpair account-faehig gemacht:
  - `src/server/channels/pairing/bridge.ts`
  - `src/server/channels/pairing/index.ts`
  - `src/server/channels/pairing/unpair.ts`
  - `app/api/channels/pair/route.ts`
  - `src/server/gateway/methods/channels.ts`
  - `app/api/channels/state/route.ts`

### WhatsApp Inbound/Outbound

- Webhook robust gemacht (Account-Resolution, Secret-Check, Allowlist, Dedupe, Attachment-Handling):
  - `app/api/channels/whatsapp/webhook/route.ts`
- Normalisierung verbessert (Fallback fuer Text/ID):
  - `src/server/channels/inbound/normalizers.ts`
- Outbound account-aware gemacht (`x-openclaw-account-id`, scoped chat IDs):
  - `src/server/channels/outbound/whatsapp.ts`
  - `src/server/channels/outbound/router.ts`

## Punkt 4: Channel Health Monitor

- Periodischer Health-Check fuer WhatsApp/iMessage Bridge.
- Fehlerzaehler + Schwellwert + Cooldown.
- Automatischer Repair-Versuch (Webhook-Refresh) und Status-Update pro Account.

Dateien:

- `src/server/channels/healthMonitor.ts`
- `src/server/channels/messages/runtime.ts` (Start im Runtime-Bootstrap)

## Ergaenzend umgesetzt (im Anschluss)

### Punkt 1: Account-Selector im UI

- Account-Auswahl im Pairing-UI eingebaut (WhatsApp/iMessage).
- State-Handling fuer Auswahl + neuer Account.
- Pair/Unpair sendet `accountId`.

Datei:

- `messenger/ChannelPairing.tsx`

### Admin-API fuer `allow_from`

- API zum Lesen/Schreiben der WhatsApp-Allowlist pro Account.
- Auth-Pruefung und Normalisierung enthalten.

Datei:

- `app/api/channels/whatsapp/accounts/route.ts`

## 3) Tests und Verifikation

Neu/erweitert:

- `tests/unit/channels/bridge-accounts.test.ts`
- `tests/unit/channels/whatsapp-outbound.test.ts`
- `tests/unit/channels/health-monitor.test.ts`
- `tests/unit/channels/whatsapp-webhook-route.test.ts`
- `tests/integration/channels/whatsapp-accounts-route.test.ts`
- `tests/channels-pair-route.test.ts`
- `tests/unit/gateway/channels-methods.test.ts`

Durchgefuehrte Checks:

- `npm run typecheck` erfolgreich.
- Mehrere gezielte Unit/Integration-Tests fuer die neuen Channel-Flows erfolgreich.

## 4) Ergebnis in einem Satz

Die WebApp hat jetzt den zentralen Mehrwert aus dem Vergleich in den kritischen Bereichen umgesetzt: robuste Multi-Account-Channel-Verarbeitung, Health-Monitoring mit Self-Heal, sowie UI/API-Bausteine fuer saubere Account-Bedienung.
