# Security System

**Stand:** 2026-02-17

## 1. Funktionserläuterung

Das Security-System umfasst Security-Checks, Channel-Webhook-Signaturen, Command-Permissions mit Risk-Levels und Credential-Store für sichere Konfiguration.

### Kernkonzepte

- **Security Checks**: Firewall, Encryption, Audit, Isolation
- **Webhook Security**: Signatur-Verifikation
- **Command Permissions**: Risk-Level-basierte Genehmigung
- **Credential Store**: Sichere Speicherung von Secrets

---

## 2. Workflow-Diagramme

### 2.1 Security Check Flow

```mermaid
flowchart TD
    A[System Start] --> B[Run Security Checks]
    B --> C[Firewall Check]
    B --> D[Encryption Check]
    B --> E[Audit Check]
    B --> F[Isolation Check]

    C --> G{Status}
    D --> G
    E --> G
    F --> G

    G -->|All OK| H[Status: Secure]
    G -->|Warning| I[Status: Warning]
    G -->|Critical| J[Status: Critical]
```

### 2.2 Webhook Verification Flow

```mermaid
sequenceDiagram
    participant Ext as External
    participant WH as Webhook
    participant VA as VerifyAdapter
    participant S as Service

    Ext->>WH: POST with signature
    WH->>VA: verify(data, signature)

    alt Valid
        VA-->>WH: true
        WH->>S: processMessage()
        S-->>WH: success
        WH-->>Ext: 200 OK
    else Invalid
        VA-->>WH: false
        WH-->>Ext: 403 Forbidden
    end
```

### 2.3 Command Approval Flow

```mermaid
flowchart LR
    A[Command Request] --> B{Check Risk Level}
    B -->|Low| C[Auto Approve]
    B -->|Medium| D[Check Rules]
    B -->|High| E[Require Approval]

    D -->|Allowed| C
    D -->|Blocked| E

    E --> F{User Decision}
    F -->|Approve| G[Execute Once]
    F -->|Always| H[Add to Allowlist]
    F -->|Deny| I[Reject]

    C --> J[Execute]
    G --> J
    H --> J
```

---

## 3. Technische Architektur

### 3.1 Komponenten

```
src/server/security/
└── status.ts               # Security-Status

src/server/channels/
├── credentials/
│   └── credentialStore.ts  # Credential-Management
└── webhookAuth.ts          # Webhook-Auth
```

### 3.2 Security Checks

| Check      | Aspekt             | Status              |
| ---------- | ------------------ | ------------------- |
| Firewall   | High-Risk Commands | ok/warning/critical |
| Encryption | HTTPS/WebCrypto    | ok/warning/critical |
| Audit      | Audit-Logging      | ok/warning          |
| Isolation  | Task-Isolation     | ok/warning/critical |

---

## 4. API-Referenz

```
GET /api/security/status      # Security-Status
```

---

## 5. Umgebungsvariablen

| Variable                | Beschreibung       |
| ----------------------- | ------------------ |
| TELEGRAM_WEBHOOK_SECRET | Telegram Secret    |
| DISCORD_PUBLIC_KEY      | Discord Public Key |
| WHATSAPP_WEBHOOK_SECRET | WhatsApp Secret    |
| IMESSAGE_WEBHOOK_SECRET | iMessage Secret    |
| SLACK_WEBHOOK_SECRET    | Slack Secret       |

---

## 6. Siehe auch

- docs/OMNICHANNEL_GATEWAY_SYSTEM.md
- docs/CORE_HANDBOOK.md
