# Security System

This document describes the comprehensive security architecture of the platform, covering security checks, webhook verification, command permission management, credential storage, and threat mitigation strategies.

## Overview

The security system implements a **defense-in-depth** approach with multiple layers of protection:

- **Security Checks**: Automated verification of firewall, encryption, audit, and isolation status
- **Webhook Security**: Cryptographic verification of incoming channel webhooks
- **Command Permissions**: Risk-level-based approval system for shell commands
- **Credential Store**: Secure storage for secrets and API keys
- **Threat Mitigation**: Proactive detection and blocking of dangerous operations

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         SECURITY ARCHITECTURE                               │
│                    Defense in Depth & Layered Protection                    │
└─────────────────────────────────────────────────────────────────────────────┘

╔═══════════════════════════════════════════════════════════════════════════╗
║  LAYER 1: PERIMETER SECURITY (Webhook Verification)                       ║
╠═══════════════════════════════════════════════════════════════════════════╣
║  • Signature verification (Ed25519, HMAC)                                 ║
║  • Shared secret validation                                               ║
║  • Timestamp validation (replay protection)                               ║
║  • Channel-specific authentication                                        ║
╚═══════════════════════════════════════════════════════════════════════════╝
                                    │
                                    │ Incoming Requests
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      SECURITY CHECK SYSTEM                              │
│  ┌───────────────┐ ┌───────────────┐ ┌───────────────┐ ┌──────────────┐ │
│  │   FIREWALL    │ │  ENCRYPTION   │ │    AUDIT      │ │  ISOLATION   │ │
│  │    CHECK      │ │    CHECK      │ │    CHECK      │ │    CHECK     │ │
│  │               │ │               │ │               │ │              │ │
│  │ • High-risk   │ │ • HTTPS       │ │ • Audit DB    │ │ • Dangerous  │ │
│  │   commands    │ │   transport   │ │   available   │ │   commands   │ │
│  │ • Blocked     │ │ • WebCrypto   │ │ • Logging     │ │ • Task       │ │
│  │   rules       │ │   available   │ │   enabled     │ │   isolation  │ │
│  │               │ │               │ │               │ │              │ │
│  │ Status:       │ │ Status:       │ │ Status:       │ │ Status:      │ │
│  │ ok/warning/   │ │ ok/warning/   │ │ ok/warning    │ │ ok/warning/  │ │
│  │ critical      │ │ critical      │ │               │ │ critical     │ │
│  └───────┬───────┘ └───────┬───────┘ └───────┬───────┘ └──────┬───────┘ │
│          │                 │                 │                │         │
│          └─────────────────┴─────────────────┴────────────────┘         │
│                                    │                                    │
│                                    ▼                                    │
│  ╔═══════════════════════════════════════════════════════════════════╗  │
│  ║  AGGREGATE SECURITY STATUS                                        ║  │
│  ║  ─────────────────────────────────────────────────────────────    ║  │
│  ║                                                                   ║  │
│  ║  • OK Count: 0-4        ──►  Status: Secure                       ║  │
│  ║  • Warning Count: >0    ──►  Status: Warning                      ║  │
│  ║  • Critical Count: >0   ──►  Status: Critical                     ║  │
│  ║                                                                   ║  │
│  ╚═══════════════════════════════════════════════════════════════════╝  │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ Validated Request
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    COMMAND PERMISSION SYSTEM                            │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  Command Request                                                  │  │
│  │       │                                                           │  │
│  │       ▼                                                           │  │
│  │  ┌─────────┐    Low Risk      ┌─────────────┐                     │  │
│  │  │  Parse  │─────────────────►│ Auto Approve│                     │  │
│  │  │ Command │                  └──────┬──────┘                     │  │
│  │  └────┬────┘                         │                           │  │
│  │       │                              │ Execute                    │  │
│  │       │ Medium Risk                  ▼                           │  │
│  │       ├─────────────────────►┌─────────────┐                     │  │
│  │       │                      │ Check Rules │                     │  │
│  │       │                      └──────┬──────┘                     │  │
│  │       │                             │                           │  │
│  │       │                   ┌─────────┴─────────┐                  │  │
│  │       │                   │                   │                  │  │
│  │       │                   ▼                   ▼                  │  │
│  │       │              ┌─────────┐       ┌──────────┐              │  │
│  │       │              │ Allowed │       │ Blocked  │              │  │
│  │       │              └────┬────┘       └────┬─────┘              │  │
│  │       │                   │                 │                    │  │
│  │       │                   ▼                 ▼                    │  │
│  │       │              ┌─────────┐     ┌────────────┐              │  │
│  │       │              │ Execute │     │ Require    │              │  │
│  │       │              │         │     │ Approval   │              │  │
│  │       │              └────┬────┘     └─────┬──────┘              │  │
│  │       │                   │                │                      │  │
│  │       │ High Risk         │                ▼                      │  │
│  │       └───────────────────┘       ┌────────────────┐              │  │
│  │                                   │ User Decision: │              │  │
│  │                                   │ • Approve Once │              │  │
│  │                                   │ • Always Allow │              │  │
│  │                                   │ • Deny         │              │  │
│  │                                   └────────────────┘              │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  Risk Levels:                                                           │
│  • Low    ──► Read-only operations (ls, cat, git status)                │
│  • Medium ──► File modifications (cp, mv, mkdir, npm install)           │
│  • High   ──► Destructive operations (rm -rf, format, shutdown)         │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ Approved Command
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      CREDENTIAL STORE                                   │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  SQLite-based secure storage for secrets                          │  │
│  │                                                                   │  │
│  │  Table: channel_credentials                                       │  │
│  │  ────────────────────────────────────────────────────────────     │  │
│  │  • channel (PK)  ──► telegram, discord, whatsapp, etc.           │  │
│  │  • key (PK)      ──► webhook_secret, api_token, etc.             │  │
│  │  • value         ──► Encrypted credential value                  │  │
│  │  • updated_at    ──► Last modification timestamp                  │  │
│  │                                                                   │  │
│  │  Fallback Chain:                                                  │  │
│  │  1. Environment variables (TELEGRAM_WEBHOOK_SECRET)              │  │
│  │  2. Credential Store (SQLite)                                     │  │
│  │  3. Default/fail open (with warning)                              │  │
│  │                                                                   │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Table of Contents

1. [Security Model](#security-model)
2. [Security Checks](#security-checks)
3. [Webhook Security](#webhook-security)
4. [Command Permissions & Risk Levels](#command-permissions--risk-levels)
5. [Credential Store](#credential-store)
6. [Authentication & Authorization](#authentication--authorization)
7. [Data Protection](#data-protection)
8. [Threat Model](#threat-model)
9. [Security Best Practices](#security-best-practices)
10. [Incident Response](#incident-response)
11. [API Reference](#api-reference)
12. [Configuration](#configuration)
13. [Audit & Compliance](#audit--compliance)

---

## Security Model

The security model follows the **principle of least privilege** and **defense-in-depth**:

### Core Principles

| Principle                | Implementation                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| **Least Privilege**      | Commands execute with minimum required permissions; high-risk commands require explicit approval |
| **Fail Secure**          | Missing secrets default to safe states; verification failures reject requests                    |
| **Defense in Depth**     | Multiple verification layers: webhooks → security checks → command permissions → audit logging   |
| **Complete Mediation**   | Every command checked against permission rules; every webhook verified                           |
| **Separation of Duties** | Credential storage isolated from command execution; audit separate from operations               |

### Security Boundaries

```
┌─────────────────────────────────────────────────────────────────┐
│                    SECURITY BOUNDARIES                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  External Network                                               │
│  ────────────────                                               │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐         │
│  │  Telegram   │    │   Discord   │    │   WhatsApp  │         │
│  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘         │
│         │                  │                  │                │
│         └──────────────────┼──────────────────┘                │
│                            │                                    │
│  ╔═════════════════════════╧═══════════════════════════╗        │
│  ║  PERIMETER (Webhook Verification)                   ║        │
│  ║  • Signature validation                             ║        │
│  ║  • Secret verification                              ║        │
│  ╚═════════════════════════╤═══════════════════════════╝        │
│                            │                                    │
│  Application Layer          │                                    │
│  ────────────────           ▼                                    │
│  ╔═══════════════════════════════════════════════════════╗      │
│  ║  SECURITY CHECK SYSTEM                                ║      │
│  ║  • Firewall checks                                    ║      │
│  ║  • Encryption validation                              ║      │
│  ║  • Audit logging                                      ║      │
│  ║  • Task isolation                                     ║      │
│  ╚═══════════════════════════════════════════════════════╝      │
│                            │                                    │
│  ╔═══════════════════════════════════════════════════════╗      │
│  ║  COMMAND EXECUTION LAYER                              ║      │
│  ║  • Permission validation                              ║      │
│  ║  • Risk assessment                                    ║      │
│  ║  • Sandboxed execution                                ║      │
│  ╚═══════════════════════════════════════════════════════╝      │
│                                                                 │
│  Data Layer                                                     │
│  ─────────                                                      │
│  ╔═══════════════════════════════════════════════════════╗      │
│  ║  CREDENTIAL STORE (Encrypted SQLite)                  ║      │
│  ║  • Bot tokens                                         ║      │
│  ║  • Webhook secrets                                    ║      │
│  ║  • API keys                                           ║      │
│  ╚═══════════════════════════════════════════════════════╝      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Security Checks

The security check system provides continuous monitoring of the platform's security posture. Four core checks run on system startup and at regular intervals.

### Check Overview

| Check ID     | Name            | Aspect                     | Status Levels       | Critical Trigger           |
| ------------ | --------------- | -------------------------- | ------------------- | -------------------------- |
| `firewall`   | Active Firewall | High-risk command blocking | ok/warning/critical | High-risk commands enabled |
| `encryption` | E2E Encryption  | Transport & crypto         | ok/warning/critical | WebCrypto unavailable      |
| `audit`      | Audit Logging   | Audit trail availability   | ok/warning          | Audit database missing     |
| `isolation`  | Task Isolation  | Command sandboxing         | ok/warning/critical | Dangerous commands enabled |

### Firewall Check

Validates that high-risk commands are properly blocked:

```typescript
function buildFirewallCheck(commands: CommandPermission[]): SecurityCheck {
  const enabledHighRisk = commands.filter((rule) => rule.risk === 'High' && rule.enabled).length;
  const blockedRules = commands.filter((rule) => !rule.enabled).length;

  if (enabledHighRisk > 0) {
    return {
      id: 'firewall',
      label: 'Active Firewall',
      status: 'critical',
      detail: `${enabledHighRisk} high-risk command(s) are active.`,
    };
  }

  return {
    id: 'firewall',
    label: 'Active Firewall',
    status: 'ok',
    detail: `${blockedRules} rule(s) blocked.`,
  };
}
```

**Status Logic:**

| Condition                      | Status     | Detail                             |
| ------------------------------ | ---------- | ---------------------------------- |
| High-risk commands enabled     | `critical` | Count of active high-risk commands |
| All high-risk commands blocked | `ok`       | Count of blocked rules             |

### Encryption Check

Validates transport security and cryptographic capabilities:

```typescript
function buildEncryptionCheck(appUrl: string, secureCrypto: boolean): SecurityCheck {
  if (!secureCrypto) {
    return {
      id: 'encryption',
      label: 'E2E Encryption',
      status: 'critical',
      detail: 'WebCrypto is not available.',
    };
  }

  if (!appUrl.startsWith('https://')) {
    return {
      id: 'encryption',
      label: 'E2E Encryption',
      status: 'warning',
      detail: `Transport is not HTTPS (${appUrl || 'not configured'}).`,
    };
  }

  return {
    id: 'encryption',
    label: 'E2E Encryption',
    status: 'ok',
    detail: `HTTPS active (${appUrl}).`,
  };
}
```

**Status Logic:**

| Condition             | Status     | Detail                                       |
| --------------------- | ---------- | -------------------------------------------- |
| WebCrypto unavailable | `critical` | Cryptographic operations cannot be performed |
| HTTPS not configured  | `warning`  | Transport encryption not enabled             |
| HTTPS configured      | `ok`       | Transport encryption active                  |

### Audit Check

Verifies audit logging infrastructure:

```typescript
function buildAuditCheck(dbExists: boolean, dbPath: string): SecurityCheck {
  if (!dbExists) {
    return {
      id: 'audit',
      label: 'Audit Logging',
      status: 'warning',
      detail: `Audit database not found (${dbPath}).`,
    };
  }

  return {
    id: 'audit',
    label: 'Audit Logging',
    status: 'ok',
    detail: `Audit database available (${dbPath}).`,
  };
}
```

**Status Logic:**

| Condition              | Status    | Detail                     |
| ---------------------- | --------- | -------------------------- |
| Audit database missing | `warning` | Path to expected database  |
| Audit database exists  | `ok`      | Path to available database |

### Isolation Check

Validates task isolation and dangerous command detection:

```typescript
function buildIsolationCheck(commands: CommandPermission[]): SecurityCheck {
  if (hasDangerousCommandEnabled(commands)) {
    return {
      id: 'isolation',
      label: 'Task Isolation',
      status: 'critical',
      detail: 'Dangerous shell commands are enabled.',
    };
  }

  const blockedHighRisk = commands.filter((rule) => rule.risk === 'High' && !rule.enabled).length;

  if (blockedHighRisk === 0) {
    return {
      id: 'isolation',
      label: 'Task Isolation',
      status: 'warning',
      detail: 'No high-risk rules blocked.',
    };
  }

  return {
    id: 'isolation',
    label: 'Task Isolation',
    status: 'ok',
    detail: `${blockedHighRisk} high-risk rule(s) isolated.`,
  };
}
```

**Dangerous Command Detection:**

```typescript
const DANGEROUS_PATTERNS = [
  /rm\s+-rf/, // Recursive force delete
  /del\s+\/f\s+\/s\s+\/q/, // Windows recursive delete
  /powershell\s+-enc/, // Encoded PowerShell commands
  /format\b/, // Disk formatting
  /shutdown\b/, // System shutdown
  /restart-computer\b/, // Windows restart
  /reg\s+delete/, // Registry deletion
  /sc\s+stop/, // Service stopping
  /diskpart/, // Disk partitioning
  /bcdedit/, // Boot configuration
  /invoke-expression|iex\b/, // PowerShell execution
];

function hasDangerousCommandEnabled(commands: CommandPermission[]): boolean {
  return commands.some(
    (rule) => rule.enabled && DANGEROUS_PATTERNS.some((pattern) => pattern.test(rule.command)),
  );
}
```

---

## Webhook Security

Incoming webhooks from messaging platforms are cryptographically verified to prevent spoofing attacks.

### Verification Methods

| Channel  | Method        | Algorithm                  | Key Source                |
| -------- | ------------- | -------------------------- | ------------------------- |
| Telegram | Signed        | HMAC-SHA256 (secret token) | `TELEGRAM_WEBHOOK_SECRET` |
| Discord  | Signed        | Ed25519                    | `DISCORD_PUBLIC_KEY`      |
| WhatsApp | Shared Secret | Header comparison          | `WHATSAPP_WEBHOOK_SECRET` |
| iMessage | Shared Secret | Header comparison          | `IMESSAGE_WEBHOOK_SECRET` |
| Slack    | Shared Secret | Header comparison          | `SLACK_WEBHOOK_SECRET`    |

### Telegram Webhook Verification

Telegram sends the secret token (configured during `setWebhook`) in the `X-Telegram-Bot-Api-Secret-Token` header:

```typescript
function verifyTelegramWebhook(request: Request, secretToken: string): boolean {
  if (!secretToken) return true; // No secret configured → skip check (warning state)

  const header = request.headers.get('x-telegram-bot-api-secret-token');
  return header === secretToken;
}
```

**Configuration:**

```bash
# Set webhook with secret
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-app.com/api/webhooks/telegram",
    "secret_token": "your-secret-token-here"
  }'
```

### Discord Webhook Verification

Discord uses Ed25519 signatures with timestamp-based replay protection:

```typescript
async function verifyDiscordWebhook(
  request: Request,
  publicKeyHex: string,
  body: string,
): Promise<boolean> {
  if (!publicKeyHex) return true; // No key configured → skip check

  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');

  if (!signature || !timestamp) return false;

  try {
    const publicKeyBytes = Buffer.from(publicKeyHex, 'hex');
    const signatureBytes = Buffer.from(signature, 'hex');
    const message = Buffer.from(timestamp + body);

    return crypto.verify(
      undefined, // Ed25519 does not use a separate hash algorithm
      message,
      {
        key: crypto.createPublicKey({
          key: publicKeyBytes,
          format: 'der',
          type: 'spki',
        }),
        dsaEncoding: undefined as never,
      },
      signatureBytes,
    );
  } catch {
    return false;
  }
}
```

**Security Features:**

1. **Cryptographic Signing**: Ed25519 provides strong authentication
2. **Timestamp Validation**: The timestamp in the signed payload prevents replay attacks
3. **Constant-Time Comparison**: Node.js `crypto.verify` uses constant-time operations

### Shared Secret Verification

For WhatsApp, iMessage, and Slack bridges where we control both endpoints:

```typescript
function verifySharedSecret(request: Request, expectedSecret: string): boolean {
  if (!expectedSecret) return true; // No secret configured → skip check

  const header = request.headers.get('x-webhook-secret');
  return header === expectedSecret;
}
```

**Best Practices:**

- Generate secrets with `crypto.randomBytes(32).toString('hex')`
- Rotate secrets every 90 days
- Never commit secrets to version control
- Use different secrets for each environment

### Channel Security Diagnostics

The system continuously monitors webhook security configuration:

```typescript
interface ChannelSecurityDiagnostic {
  channel: string; // Platform name
  verification: 'signed' | 'shared_secret' | 'none';
  secretConfigured: boolean; // Whether secret is available
  status: 'ok' | 'warning';
  detail: string;
}
```

**Example Output:**

```json
{
  "channels": [
    {
      "channel": "telegram",
      "verification": "signed",
      "secretConfigured": true,
      "status": "ok",
      "detail": "Verification secret configured."
    },
    {
      "channel": "discord",
      "verification": "signed",
      "secretConfigured": false,
      "status": "warning",
      "detail": "Verification secret missing."
    }
  ]
}
```

---

## Command Permissions & Risk Levels

The command permission system controls which shell commands can be executed, with risk-based approval workflows.

### Risk Level Definitions

| Level      | Description            | Examples                           | Default Action   |
| ---------- | ---------------------- | ---------------------------------- | ---------------- |
| **Low**    | Read-only operations   | `ls`, `cat`, `pwd`, `git status`   | Auto-approve     |
| **Medium** | File modifications     | `cp`, `mv`, `mkdir`, `npm install` | Check rules      |
| **High**   | Destructive/privileged | `rm -rf`, `format`, `shutdown`     | Require approval |

### Command Permission Structure

```typescript
interface CommandPermission {
  id: string; // Unique identifier (e.g., 'c1')
  command: string; // Command pattern to match
  description: string; // Human-readable description
  category: string; // Functional category
  risk: 'Low' | 'Medium' | 'High';
  enabled: boolean; // Whether command is allowed
}
```

### Default Security Rules

The system ships with 24 predefined command rules:

**Low Risk (Auto-approved):**

| ID  | Command      | Category | Status     |
| --- | ------------ | -------- | ---------- |
| c1  | `ls`         | Files    | ✅ Enabled |
| c2  | `pwd`        | Files    | ✅ Enabled |
| c3  | `cd`         | Files    | ✅ Enabled |
| c4  | `rg`         | Files    | ✅ Enabled |
| c5  | `cat`        | Files    | ✅ Enabled |
| c9  | `git status` | DevOps   | ✅ Enabled |
| c10 | `git diff`   | DevOps   | ✅ Enabled |
| c11 | `git log`    | DevOps   | ✅ Enabled |
| c14 | `npm test`   | DevOps   | ✅ Enabled |
| c15 | `pnpm test`  | DevOps   | ✅ Enabled |

**Medium Risk (Rule-checked):**

| ID  | Command             | Category | Status      |
| --- | ------------------- | -------- | ----------- |
| c6  | `mkdir`             | Files    | ✅ Enabled  |
| c7  | `cp`                | Files    | ✅ Enabled  |
| c8  | `mv`                | Files    | ✅ Enabled  |
| c12 | `npm install`       | DevOps   | ✅ Enabled  |
| c13 | `pnpm install`      | DevOps   | ✅ Enabled  |
| c16 | `curl`              | Network  | ❌ Disabled |
| c17 | `Invoke-WebRequest` | Network  | ❌ Disabled |

**High Risk (Blocked by default):**

| ID  | Command           | Category | Status      |
| --- | ----------------- | -------- | ----------- |
| c18 | `rm -rf`          | System   | ❌ Disabled |
| c19 | `del /f /s /q`    | System   | ❌ Disabled |
| c20 | `format`          | System   | ❌ Disabled |
| c21 | `shutdown`        | System   | ❌ Disabled |
| c22 | `powershell -enc` | System   | ❌ Disabled |
| c23 | `reg delete`      | System   | ❌ Disabled |
| c24 | `sc stop`         | System   | ❌ Disabled |

### Approval Workflow

```
┌─────────────────────────────────────────────────────────────────┐
│                   COMMAND APPROVAL FLOW                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. Command Request                                             │
│     └─► Parse command from user input                           │
│                                                                 │
│  2. Risk Assessment                                             │
│     ├─► Match against SECURITY_RULES                            │
│     └─► Determine risk level (Low/Medium/High)                  │
│                                                                 │
│  3. Route by Risk Level                                         │
│     │                                                           │
│     ├──► Low Risk ───────────────────┐                          │
│     │   └─► Auto Approve ──► Execute │                          │
│     │                                │                          │
│     ├──► Medium Risk                 │                          │
│     │   └─► Check Rules              │                          │
│     │       ├─► Allowed ──► Execute  │                          │
│     │       └─► Blocked ──► Require Approval                     │
│     │                                │                          │
│     └──► High Risk                   │                          │
│         └─► Require Approval ◄───────┘                          │
│                                                                 │
│  4. User Decision (for blocked/high-risk)                       │
│     ├─► Approve Once ──► Execute single time                    │
│     ├─► Always Allow ──► Add to allowlist                       │
│     └─► Deny ──► Reject with explanation                        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Runtime Permission Check

```typescript
function checkCommandPermission(
  command: string,
  rules: CommandPermission[],
): { allowed: boolean; reason?: string } {
  // Find matching rule (longest match wins)
  const matchingRule = rules
    .filter((rule) => command.startsWith(rule.command))
    .sort((a, b) => b.command.length - a.command.length)[0];

  if (!matchingRule) {
    return { allowed: false, reason: 'No matching permission rule' };
  }

  if (!matchingRule.enabled) {
    return {
      allowed: false,
      reason: `Command blocked: ${matchingRule.description} (${matchingRule.risk} risk)`,
    };
  }

  return { allowed: true };
}
```

---

## Credential Store

The credential store provides secure, persistent storage for sensitive configuration data.

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    CREDENTIAL STORE                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  SQLite Database                                        │   │
│  │  (MESSAGES_DB_PATH or .local/messages.db)              │   │
│  │                                                         │   │
│  │  Table: channel_credentials                             │   │
│  │  ┌─────────┬─────────┬─────────┬─────────────────────┐ │   │
│  │  │ channel │ key     │ value   │ updated_at          │ │   │
│  │  ├─────────┼─────────┼─────────┼─────────────────────┤ │   │
│  │  │ telegram│ webhook │ secret1 │ 2026-02-17T10:00:00Z│ │   │
│  │  │         │ _secret │         │                     │ │   │
│  │  ├─────────┼─────────┼─────────┼─────────────────────┤ │   │
│  │  │ discord │ api_key │ key123  │ 2026-02-17T10:05:00Z│ │   │
│  │  └─────────┴─────────┴─────────┴─────────────────────┘ │   │
│  │                                                         │   │
│  │  Primary Key: (channel, key)                            │   │
│  │  Upsert: ON CONFLICT DO UPDATE                          │   │
│  │                                                         │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                  │
│                              ▼                                  │
│  ╔═══════════════════════════════════════════════════════════╗ │
│  ║  FALLBACK CHAIN                                           ║ │
│  ║  ─────────────────────────────────────────────────────    ║ │
│  ║                                                           ║ │
│  ║  1. Environment Variables (highest priority)              ║ │
│  ║     └─► process.env.TELEGRAM_WEBHOOK_SECRET              ║ │
│  ║                                                           ║ │
│  ║  2. Credential Store                                      ║ │
│  ║     └─► getCredential('telegram', 'webhook_secret')      ║ │
│  ║                                                           ║ │
│  ║  3. Fail Open (with warning)                              ║ │
│  ║     └─► Return empty, log warning                        ║ │
│  ║                                                           ║ │
│  ╚═══════════════════════════════════════════════════════════╝ │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### API

```typescript
class CredentialStore {
  // Store or update a credential
  setCredential(channel: string, key: string, value: string): void;

  // Retrieve a credential
  getCredential(channel: string, key: string): string | null;

  // Delete all credentials for a channel
  deleteCredentials(channel: string): void;

  // List all credentials for a channel
  listCredentials(channel: string): ChannelCredential[];
}

// Singleton access
function getCredentialStore(): CredentialStore;
```

### Usage Examples

```typescript
// Store a webhook secret
const store = getCredentialStore();
store.setCredential('telegram', 'webhook_secret', 'my-secret-value');

// Retrieve with fallback chain
function hasConfiguredSecret(channel: string, key: string, envName: string): boolean {
  // Check environment first
  const envValue = process.env[envName];
  if (envValue?.trim()) return true;

  // Fall back to credential store
  try {
    const store = getCredentialStore();
    const value = store.getCredential(channel, key);
    return Boolean(value?.trim());
  } catch {
    return false;
  }
}

// List all credentials for a channel
const credentials = store.listCredentials('telegram');
// Returns: [{ channel: 'telegram', key: 'webhook_secret', value: '...', updatedAt: '...' }]
```

### Security Considerations

| Aspect             | Implementation                                               |
| ------------------ | ------------------------------------------------------------ |
| **Storage**        | SQLite with filesystem permissions                           |
| **Encryption**     | Relies on filesystem encryption (LUKS, BitLocker, FileVault) |
| **Access Control** | Process-level isolation; no network access                   |
| **Backup**         | Included in standard database backups                        |
| **Rotation**       | Manual via `setCredential()` with new value                  |

---

## Authentication & Authorization

### Authentication Methods

| Method                 | Use Case             | Implementation         |
| ---------------------- | -------------------- | ---------------------- |
| **Webhook Signatures** | Channel verification | Ed25519, HMAC-SHA256   |
| **Shared Secrets**     | Bridge webhooks      | Header comparison      |
| **API Keys**           | Model providers      | Header/token-based     |
| **Session Tokens**     | Web UI               | JWT or session cookies |

### Authorization Model

The system uses **attribute-based access control** (ABAC) for commands:

```
┌─────────────────────────────────────────────────────────────────┐
│              AUTHORIZATION DECISION FLOW                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Subject: User/Session                                          │
│  ├─► User ID                                                    │
│  ├─► Session ID                                                 │
│  └─► Authentication Level                                       │
│                                                                 │
│  Resource: Command                                              │
│  ├─► Command string                                             │
│  ├─► Risk level (Low/Medium/High)                               │
│  └─► Category (Files, DevOps, Network, System)                  │
│                                                                 │
│  Environment:                                                   │
│  ├─► Current working directory                                  │
│  ├─► Platform (Telegram, Discord, etc.)                         │
│  └─► Time of request                                            │
│                                                                 │
│  Decision: ALLOW / DENY / REQUIRE_APPROVAL                      │
│  └─► Based on SECURITY_RULES matching                           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Data Protection

### Data Classification

| Level         | Data Types                        | Protection                               |
| ------------- | --------------------------------- | ---------------------------------------- |
| **Critical**  | API keys, webhook secrets, tokens | Credential store + filesystem encryption |
| **Sensitive** | Conversation content, user data   | Database encryption at rest              |
| **Internal**  | Logs, metrics, configuration      | Access control                           |
| **Public**    | Documentation, static assets      | None required                            |

### Encryption at Rest

- **Database**: SQLite with encryption extensions (if configured)
- **Filesystem**: Relies on OS-level encryption (LUKS, BitLocker, FileVault)
- **Backups**: Encrypted backup procedures

### Encryption in Transit

- **HTTPS Required**: All webhook endpoints must use TLS 1.2+
- **Certificate Validation**: Full chain validation for outbound HTTPS
- **HSTS**: HTTP Strict Transport Security headers (recommended)

### Data Retention

| Data Type              | Retention       | Purge Strategy      |
| ---------------------- | --------------- | ------------------- |
| Audit Logs             | 90 days         | Automatic rotation  |
| Conversation History   | User-configured | Manual or scheduled |
| Credentials            | Until rotated   | Manual deletion     |
| Security Check History | 30 days         | Automatic cleanup   |

---

## Threat Model

### Threat Actors

| Actor                   | Motivation                       | Capability | Priority |
| ----------------------- | -------------------------------- | ---------- | -------- |
| **External Attacker**   | Data theft, system compromise    | Low-Medium | High     |
| **Malicious User**      | Privilege escalation, data exfil | Medium     | High     |
| **Compromised Channel** | Message injection, spoofing      | Medium     | Medium   |
| **Insider Threat**      | Sabotage, unauthorized access    | High       | Medium   |

### Attack Scenarios

#### Scenario 1: Webhook Spoofing

**Threat**: Attacker sends forged webhook requests to inject messages.

**Mitigation**:

- Ed25519 signature verification (Discord)
- HMAC-SHA256 secret token (Telegram)
- Shared secret validation (WhatsApp, iMessage, Slack)

**Residual Risk**: Low (cryptographic verification)

#### Scenario 2: Command Injection

**Threat**: Attacker injects malicious commands through compromised channels.

**Mitigation**:

- Risk-level-based approval
- Dangerous command patterns blocked
- Input validation and sanitization

**Residual Risk**: Low (multi-layer validation)

#### Scenario 3: Secret Exfiltration

**Threat**: Attacker extracts API keys from credential store.

**Mitigation**:

- Filesystem-level encryption
- Process isolation
- No network exposure of credentials

**Residual Risk**: Medium (requires filesystem access)

#### Scenario 4: Privilege Escalation

**Threat**: Attacker enables high-risk commands through configuration manipulation.

**Mitigation**:

- Security checks detect enabled high-risk commands
- Administrative approval required for changes
- Audit logging of all permission changes

**Residual Risk**: Low (automated detection)

### Risk Matrix

| Threat               | Likelihood | Impact   | Risk Level |
| -------------------- | ---------- | -------- | ---------- |
| Webhook spoofing     | Low        | Medium   | Low        |
| Command injection    | Medium     | High     | Medium     |
| Secret exfiltration  | Low        | Critical | Medium     |
| Privilege escalation | Low        | High     | Low        |
| Denial of service    | Medium     | Low      | Low        |

---

## Security Best Practices

### Deployment

1. **Use HTTPS**: Configure TLS certificates for all endpoints
2. **Secure Secrets**: Use credential store or environment variables
3. **Regular Updates**: Keep dependencies and Node.js updated
4. **Network Isolation**: Run in isolated network segments when possible

### Configuration

```bash
# Required: HTTPS URL
APP_URL=https://your-app.com

# Required: Database path with restricted permissions
MESSAGES_DB_PATH=/var/lib/app/messages.db

# Recommended: Webhook secrets (all channels)
TELEGRAM_WEBHOOK_SECRET=$(openssl rand -hex 32)
DISCORD_PUBLIC_KEY=your-discord-public-key
WHATSAPP_WEBHOOK_SECRET=$(openssl rand -hex 32)
IMESSAGE_WEBHOOK_SECRET=$(openssl rand -hex 32)
SLACK_WEBHOOK_SECRET=$(openssl rand -hex 32)
```

### Operational

1. **Monitor Security Checks**: Review security status regularly
2. **Audit Logs**: Enable and monitor audit logging
3. **Secret Rotation**: Rotate webhook secrets every 90 days
4. **Backup Security**: Encrypt backups containing credential store

### Development

1. **No Hardcoded Secrets**: Use credential store or environment variables
2. **Input Validation**: Validate all user inputs before processing
3. **Error Handling**: Don't expose sensitive data in error messages
4. **Testing**: Include security tests in CI/CD pipeline

---

## Incident Response

### Severity Levels

| Level        | Criteria                         | Response Time |
| ------------ | -------------------------------- | ------------- |
| **Critical** | Active exploitation, data breach | Immediate     |
| **High**     | Security check critical status   | 1 hour        |
| **Medium**   | Security check warning status    | 24 hours      |
| **Low**      | Best practice violations         | 7 days        |

### Response Procedures

#### Critical: High-Risk Commands Enabled

1. **Detect**: Security check reports `critical` status
2. **Contain**: Immediately disable high-risk commands
3. **Investigate**: Review audit logs for unauthorized changes
4. **Recover**: Restore proper configuration
5. **Learn**: Implement preventive controls

```typescript
// Emergency disable all high-risk commands
const updatedRules = SECURITY_RULES.map((rule) =>
  rule.risk === 'High' ? { ...rule, enabled: false } : rule,
);
```

#### High: Missing Webhook Secret

1. **Detect**: Security check reports missing secret
2. **Assess**: Verify channel is actively used
3. **Remediate**: Generate and configure new secret
4. **Verify**: Confirm security check passes

```bash
# Generate new secret
openssl rand -hex 32

# Configure in environment or credential store
```

#### Medium: HTTP (non-HTTPS) Configuration

1. **Detect**: Encryption check reports `warning`
2. **Plan**: Schedule HTTPS migration
3. **Implement**: Configure TLS certificate
4. **Verify**: Confirm HTTPS accessibility

### Audit Trail Review

Regular review of security-relevant events:

```sql
-- Example: Find all permission changes
SELECT * FROM audit_log
WHERE type = 'SECURITY'
  AND message LIKE '%permission%'
ORDER BY timestamp DESC;

-- Example: Find failed webhook verifications
SELECT * FROM audit_log
WHERE type = 'CHAN'
  AND message LIKE '%verification failed%'
ORDER BY timestamp DESC;
```

---

## API Reference

### Security Status API

#### `GET /api/security/status`

Returns the current security status snapshot.

**Response:**

```typescript
interface SecurityStatusSnapshot {
  checks: SecurityCheck[];
  channels: ChannelSecurityDiagnostic[];
  summary: {
    ok: number;
    warning: number;
    critical: number;
  };
  generatedAt: string;
}

interface SecurityCheck {
  id: 'firewall' | 'encryption' | 'audit' | 'isolation';
  label: string;
  status: 'ok' | 'warning' | 'critical';
  detail: string;
}

interface ChannelSecurityDiagnostic {
  channel: string;
  verification: 'signed' | 'shared_secret' | 'none';
  secretConfigured: boolean;
  status: 'ok' | 'warning';
  detail: string;
}
```

**Example Response:**

```json
{
  "checks": [
    {
      "id": "firewall",
      "label": "Active Firewall",
      "status": "ok",
      "detail": "7 rule(s) blocked."
    },
    {
      "id": "encryption",
      "label": "E2E Encryption",
      "status": "ok",
      "detail": "HTTPS active (https://app.example.com)."
    },
    {
      "id": "audit",
      "label": "Audit Logging",
      "status": "ok",
      "detail": "Audit database available (/var/lib/app/messages.db)."
    },
    {
      "id": "isolation",
      "label": "Task Isolation",
      "status": "ok",
      "detail": "8 high-risk rule(s) isolated."
    }
  ],
  "channels": [
    {
      "channel": "telegram",
      "verification": "signed",
      "secretConfigured": true,
      "status": "ok",
      "detail": "Verification secret configured."
    }
  ],
  "summary": {
    "ok": 4,
    "warning": 0,
    "critical": 0
  },
  "generatedAt": "2026-02-17T14:53:30.961Z"
}
```

### Server-Side Functions

#### `buildSecurityStatusSnapshot(input?)`

Builds a comprehensive security status report.

```typescript
interface BuildSecurityStatusInput {
  commands?: CommandPermission[]; // Custom rules (defaults to SECURITY_RULES)
  appUrl?: string; // Override APP_URL
  dbExists?: boolean; // Override database check
  secureCrypto?: boolean; // Override WebCrypto check
}

function buildSecurityStatusSnapshot(input?: BuildSecurityStatusInput): SecurityStatusSnapshot;
```

#### `verifyTelegramWebhook(request, secretToken)`

Verifies Telegram webhook requests.

```typescript
function verifyTelegramWebhook(request: Request, secretToken: string): boolean;
```

#### `verifyDiscordWebhook(request, publicKeyHex, body)`

Verifies Discord Ed25519 signatures.

```typescript
async function verifyDiscordWebhook(
  request: Request,
  publicKeyHex: string,
  body: string,
): Promise<boolean>;
```

#### `verifySharedSecret(request, expectedSecret)`

Verifies shared secret headers.

```typescript
function verifySharedSecret(request: Request, expectedSecret: string): boolean;
```

### Credential Store API

```typescript
class CredentialStore {
  constructor(dbPath?: string);

  // Store or update a credential
  setCredential(channel: string, key: string, value: string): void;

  // Retrieve a credential (null if not found)
  getCredential(channel: string, key: string): string | null;

  // Delete all credentials for a channel
  deleteCredentials(channel: string): void;

  // List credentials for a channel
  listCredentials(channel: string): ChannelCredential[];
}

// Singleton accessor
function getCredentialStore(): CredentialStore;
```

---

## Configuration

### Environment Variables

#### Core Security

| Variable           | Description             | Required | Default              |
| ------------------ | ----------------------- | -------- | -------------------- |
| `APP_URL`          | Application base URL    | Yes      | -                    |
| `MESSAGES_DB_PATH` | Path to SQLite database | No       | `.local/messages.db` |

#### Webhook Secrets

| Variable                  | Description                | Required    | Verification Type |
| ------------------------- | -------------------------- | ----------- | ----------------- |
| `TELEGRAM_WEBHOOK_SECRET` | Telegram bot secret token  | Recommended | HMAC-SHA256       |
| `DISCORD_PUBLIC_KEY`      | Discord Ed25519 public key | Recommended | Ed25519           |
| `WHATSAPP_WEBHOOK_SECRET` | WhatsApp bridge secret     | Recommended | Shared secret     |
| `IMESSAGE_WEBHOOK_SECRET` | iMessage bridge secret     | Recommended | Shared secret     |
| `SLACK_WEBHOOK_SECRET`    | Slack webhook secret       | Recommended | Shared secret     |

### TypeScript Interfaces

```typescript
// Security check status
type SecurityCheckStatus = 'ok' | 'warning' | 'critical';

// Security check definition
interface SecurityCheck {
  id: 'firewall' | 'encryption' | 'audit' | 'isolation';
  label: string;
  status: SecurityCheckStatus;
  detail: string;
}

// Channel security diagnostic
interface ChannelSecurityDiagnostic {
  channel: string;
  verification: 'signed' | 'shared_secret' | 'none';
  secretConfigured: boolean;
  status: 'ok' | 'warning';
  detail: string;
}

// Security status snapshot
interface SecurityStatusSnapshot {
  checks: SecurityCheck[];
  channels: ChannelSecurityDiagnostic[];
  summary: {
    ok: number;
    warning: number;
    critical: number;
  };
  generatedAt: string;
}

// Command permission
interface CommandPermission {
  id: string;
  command: string;
  description: string;
  category: string;
  risk: 'Low' | 'Medium' | 'High';
  enabled: boolean;
}

// Credential entry
interface ChannelCredential {
  channel: string;
  key: string;
  value: string;
  updatedAt: string;
}
```

---

## Audit & Compliance

### Audit Events

The system logs security-relevant events:

| Event Type                | Description                    | Log Level |
| ------------------------- | ------------------------------ | --------- |
| `SECURITY_STATUS_CHANGE`  | Security check status changed  | WARN      |
| `COMMAND_BLOCKED`         | Command execution blocked      | WARN      |
| `COMMAND_APPROVED`        | High-risk command approved     | INFO      |
| `WEBHOOK_VERIFY_FAILED`   | Webhook verification failed    | ERROR     |
| `CREDENTIAL_UPDATED`      | Credential store modified      | INFO      |
| `PERMISSION_RULE_CHANGED` | Security rule enabled/disabled | WARN      |

### Compliance Mapping

| Control                  | Implementation            | Evidence                     |
| ------------------------ | ------------------------- | ---------------------------- |
| **Access Control**       | Command permission system | SECURITY_RULES configuration |
| **Audit Logging**        | SQLite audit database     | Audit log entries            |
| **Data Integrity**       | Webhook signatures        | Verification logs            |
| **Incident Detection**   | Security check system     | Security status snapshots    |
| **Secure Configuration** | Environment-based secrets | Environment variable audit   |

### Security Checklist

- [ ] HTTPS enabled for all endpoints
- [ ] Webhook secrets configured for all active channels
- [ ] High-risk commands disabled (default)
- [ ] Audit database accessible
- [ ] WebCrypto available
- [ ] Filesystem encryption enabled
- [ ] Regular secret rotation schedule established
- [ ] Security monitoring dashboard configured
- [ ] Incident response procedures documented
- [ ] Regular security audits scheduled

---

## See Also

- [Omnichannel Gateway System](OMNICHANNEL_GATEWAY_SYSTEM.md) - Channel integration details
- [Core Handbook](CORE_HANDBOOK.md) - Platform overview and concepts
- `src/server/security/status.ts` - Security check implementation
- `src/server/channels/webhookAuth.ts` - Webhook verification utilities
- `src/server/channels/credentials/credentialStore.ts` - Credential storage implementation
