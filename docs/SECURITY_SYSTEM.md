# Security System

**Stand:** 2026-02-13

## Überblick

Das Security-System umfasst:
- **Security-Checks** (Firewall, Encryption, Audit, Isolation)
- **Channel-Webhook-Signaturen**
- **Command-Permissions** mit Risk-Levels
- **Credential-Store** für sichere Konfiguration

## Architektur

```
src/server/security/
└── status.ts               # Security-Status-Logik

src/server/channels/
└── credentials.ts         # Credential-Store
```

## Security-Checks

| Check | Aspekt | Status |
|-------|--------|--------|
| `firewall` | Aktive Firewall für High-Risk-Commands | ok/warning/critical |
| `encryption` | E2E-Verschlüsselung und HTTPS | ok/warning/critical |
| `audit` | Audit-Logging aktiv | ok/warning |
| `isolation` | Task-Isolation für gefährliche Kommandos | ok/warning/critical |

### Check-Details

#### Firewall
- Prüft Anzahl aktiver High-Risk-Commands
- **Critical**: High-Risk-Commands aktiv
- **Ok**: Alle High-Risk-Commands blockiert

#### Encryption
- **Critical**: WebCrypto nicht verfügbar
- **Warning**: Kein HTTPS konfiguriert
- **Ok**: HTTPS aktiv

#### Audit
- Prüft Existenz der Audit-Datenbank
- **Warning**: DB nicht gefunden

#### Isolation
- Prüft auf gefährliche Shell-Kommandos (`rm -rf`, `del /f /q`)
- **Critical**: Gefährliche Kommandos aktiviert

## Channel-Security

Jeder Channel hat eigene Security-Anforderungen:

| Channel | Verification | Secret-Env-Variable |
|---------|--------------|-------------------|
| Telegram | Signed | `TELEGRAM_WEBHOOK_SECRET` |
| Discord | Signed | `DISCORD_PUBLIC_KEY` |
| WhatsApp | Shared Secret | `WHATSAPP_WEBHOOK_SECRET` |
| iMessage | Shared Secret | `IMESSAGE_WEBHOOK_SECRET` |
| Slack | Shared Secret | `SLACK_WEBHOOK_SECRET` |

### Webhook-Signatur

```typescript
// Telegram
const crypto = require('crypto');
const isValid = crypto
  .createHmac('sha256', TELEGRAM_WEBHOOK_SECRET)
  .update(data)
  .digest() === signature;
```

## Command-Permissions

Commands werden nach Risk-Level eingestuft:

| Risk-Level | Beispiele | Standard |
|------------|-----------|----------|
| `Low` | read, list, search | ✅ Erlaubt |
| `Medium` | write, create | ⚠️ Genehmigung |
| `High` | delete, execute, shell | ❌ Blockiert |

### Risk-Level-Konfiguration

```typescript
// constants.ts
export const SECURITY_RULES: CommandPermission[] = [
  {
    command: 'rm -rf',
    risk: 'High',
    enabled: false,
  },
  {
    command: 'del /f /q',
    risk: 'High', 
    enabled: false,
  },
  // ...
];
```

## Credential-Store

Sichere Speicherung von API-Keys und Secrets:

```typescript
// credentials.ts
class CredentialStore {
  private store = new Map<string, Map<string, string>>();
  
  setCredential(channel: string, key: string, value: string): void {
    if (!this.store.has(channel)) {
      this.store.set(channel, new Map());
    }
    this.store.get(channel)!.set(key, value);
  }
  
  getCredential(channel: string, key: string): string | undefined {
    return this.store.get(channel)?.get(key);
  }
}
```

## API-Oberfläche

### GET /api/security/status

Security-Status abrufen.

**Response:**
```json
{
  "ok": true,
  "checks": [
    {
      "id": "firewall",
      "label": "Active Firewall",
      "status": "ok",
      "detail": "5 Regel(n) blockiert."
    }
  ],
  "channels": [
    {
      "channel": "telegram",
      "verification": "signed",
      "secretConfigured": true,
      "status": "ok"
    }
  ],
  "summary": {
    "ok": 3,
    "warning": 1,
    "critical": 0
  },
  "generatedAt": "2026-02-13T12:00:00.000Z"
}
```

## Umgebungsvariablen

| Variable | Beschreibung |
|----------|--------------|
| `TELEGRAM_WEBHOOK_SECRET` | Telegram Webhook Secret |
| `DISCORD_PUBLIC_KEY` | Discord Public Key |
| `WHATSAPP_WEBHOOK_SECRET` | WhatsApp Webhook Secret |
| `IMESSAGE_BRIDGE_URL` | iMessage Bridge URL |
| `SLACK_WEBHOOK_SECRET` | Slack Webhook Secret |
| `APP_URL` | Öffentliche URL (für HTTPS-Check) |
| `MESSAGES_DB_PATH` | Pfad zur DB (für Audit-Check) |

## Verifikation

```bash
npm run test -- tests/unit/security
npm run test -- tests/integration/security
npm run lint
npm run typecheck
```

## Siehe auch

- [docs/CORE_HANDBOOK.md](CORE_HANDBOOK.md)
- [docs/OMNICHANNEL_GATEWAY_OPERATIONS.md](OMNICHANNEL_GATEWAY_OPERATIONS.md)
