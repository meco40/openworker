import fs from 'node:fs';
import path from 'node:path';
import { SECURITY_RULES } from '../../../constants';
import type { CommandPermission } from '../../../types';
import { getCredentialStore } from '../channels/credentials';

export type SecurityCheckStatus = 'ok' | 'warning' | 'critical';

export interface SecurityCheck {
  id: 'firewall' | 'encryption' | 'audit' | 'isolation';
  label: string;
  status: SecurityCheckStatus;
  detail: string;
}

export interface SecurityStatusSnapshot {
  checks: SecurityCheck[];
  channels: ChannelSecurityDiagnostic[];
  summary: {
    ok: number;
    warning: number;
    critical: number;
  };
  generatedAt: string;
}

export interface ChannelSecurityDiagnostic {
  channel: string;
  verification: 'signed' | 'shared_secret' | 'none';
  secretConfigured: boolean;
  status: 'ok' | 'warning';
  detail: string;
}

interface BuildSecurityStatusInput {
  commands?: CommandPermission[];
  appUrl?: string;
  dbExists?: boolean;
  secureCrypto?: boolean;
}

function resolveMessagesDbPath(rawPath = process.env.MESSAGES_DB_PATH || '.local/messages.db'): string {
  return path.resolve(rawPath);
}

function hasDangerousCommandEnabled(commands: CommandPermission[]): boolean {
  return commands.some(
    (rule) =>
      rule.enabled &&
      /rm\s+-rf|del\s+\/f\s+\/q|powershell\s+-enc/i.test(rule.command),
  );
}

function buildFirewallCheck(commands: CommandPermission[]): SecurityCheck {
  const enabledHighRisk = commands.filter((rule) => rule.risk === 'High' && rule.enabled).length;
  const blockedRules = commands.filter((rule) => !rule.enabled).length;

  if (enabledHighRisk > 0) {
    return {
      id: 'firewall',
      label: 'Active Firewall',
      status: 'critical',
      detail: `${enabledHighRisk} High-Risk-Command(s) sind aktiv.`,
    };
  }

  return {
    id: 'firewall',
    label: 'Active Firewall',
    status: 'ok',
    detail: `${blockedRules} Regel(n) blockiert.`,
  };
}

function buildEncryptionCheck(appUrl: string, secureCrypto: boolean): SecurityCheck {
  if (!secureCrypto) {
    return {
      id: 'encryption',
      label: 'E2E Encryption',
      status: 'critical',
      detail: 'WebCrypto ist nicht verfügbar.',
    };
  }

  if (!appUrl.startsWith('https://')) {
    return {
      id: 'encryption',
      label: 'E2E Encryption',
      status: 'warning',
      detail: `Transport ist nicht HTTPS (${appUrl || 'nicht konfiguriert'}).`,
    };
  }

  return {
    id: 'encryption',
    label: 'E2E Encryption',
    status: 'ok',
    detail: `HTTPS aktiv (${appUrl}).`,
  };
}

function buildAuditCheck(dbExists: boolean, dbPath: string): SecurityCheck {
  if (!dbExists) {
    return {
      id: 'audit',
      label: 'Audit Logging',
      status: 'warning',
      detail: `Audit-DB nicht gefunden (${dbPath}).`,
    };
  }

  return {
    id: 'audit',
    label: 'Audit Logging',
    status: 'ok',
    detail: `Audit-DB verfügbar (${dbPath}).`,
  };
}

function buildIsolationCheck(commands: CommandPermission[]): SecurityCheck {
  if (hasDangerousCommandEnabled(commands)) {
    return {
      id: 'isolation',
      label: 'Task Isolation',
      status: 'critical',
      detail: 'Gefährliche Shell-Kommandos sind aktiviert.',
    };
  }

  const blockedHighRisk = commands.filter(
    (rule) => rule.risk === 'High' && !rule.enabled,
  ).length;
  if (blockedHighRisk === 0) {
    return {
      id: 'isolation',
      label: 'Task Isolation',
      status: 'warning',
      detail: 'Keine High-Risk-Regel blockiert.',
    };
  }

  return {
    id: 'isolation',
    label: 'Task Isolation',
    status: 'ok',
    detail: `${blockedHighRisk} High-Risk-Regel(n) isoliert.`,
  };
}

function hasConfiguredSecret(channel: string, key: string, envName: string): boolean {
  const envValue = process.env[envName];
  if (envValue && envValue.trim()) {
    return true;
  }

  try {
    const store = getCredentialStore();
    const value = store.getCredential(channel, key);
    return Boolean(value && value.trim());
  } catch {
    return false;
  }
}

function buildChannelSecurityDiagnostics(): ChannelSecurityDiagnostic[] {
  const channels: Array<{
    channel: string;
    verification: ChannelSecurityDiagnostic['verification'];
    secretConfigured: boolean;
  }> = [
    {
      channel: 'telegram',
      verification: 'signed',
      secretConfigured: hasConfiguredSecret('telegram', 'webhook_secret', 'TELEGRAM_WEBHOOK_SECRET'),
    },
    {
      channel: 'discord',
      verification: 'signed',
      secretConfigured: Boolean(process.env.DISCORD_PUBLIC_KEY?.trim()),
    },
    {
      channel: 'whatsapp',
      verification: 'shared_secret',
      secretConfigured: Boolean(process.env.WHATSAPP_WEBHOOK_SECRET?.trim()),
    },
    {
      channel: 'imessage',
      verification: 'shared_secret',
      secretConfigured: Boolean(process.env.IMESSAGE_WEBHOOK_SECRET?.trim()),
    },
    {
      channel: 'slack',
      verification: 'shared_secret',
      secretConfigured: Boolean(process.env.SLACK_WEBHOOK_SECRET?.trim()),
    },
  ];

  return channels.map((entry) => ({
    channel: entry.channel,
    verification: entry.verification,
    secretConfigured: entry.secretConfigured,
    status: entry.secretConfigured ? 'ok' : 'warning',
    detail: entry.secretConfigured
      ? 'Verification secret configured.'
      : 'Verification secret missing.',
  }));
}

export function buildSecurityStatusSnapshot(
  input: BuildSecurityStatusInput = {},
): SecurityStatusSnapshot {
  const commands = input.commands ?? SECURITY_RULES;
  const appUrl = input.appUrl ?? process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? '';
  const dbPath = resolveMessagesDbPath();
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is derived from controlled app config
  const dbExists = input.dbExists ?? fs.existsSync(dbPath);
  const secureCrypto = input.secureCrypto ?? Boolean(globalThis.crypto?.subtle);

  const checks: SecurityCheck[] = [
    buildFirewallCheck(commands),
    buildEncryptionCheck(appUrl, secureCrypto),
    buildAuditCheck(dbExists, dbPath),
    buildIsolationCheck(commands),
  ];

  const summary = {
    ok: checks.filter((check) => check.status === 'ok').length,
    warning: checks.filter((check) => check.status === 'warning').length,
    critical: checks.filter((check) => check.status === 'critical').length,
  };

  return {
    checks,
    channels: buildChannelSecurityDiagnostics(),
    summary,
    generatedAt: new Date().toISOString(),
  };
}

