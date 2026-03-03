import { describe, expect, it } from 'vitest';
import type { CommandPermission } from '@/shared/domain/types';
import { buildSecurityStatusSnapshot } from '@/server/security/status';

const BASE_RULES: CommandPermission[] = [
  { id: 'c1', command: 'ls', description: 'List', category: 'Files', risk: 'Low', enabled: true },
  {
    id: 'c7',
    command: 'rm -rf',
    description: 'Danger',
    category: 'System',
    risk: 'High',
    enabled: false,
  },
];

describe('security status snapshot', () => {
  describe('firewall check', () => {
    it('marks firewall critical when high-risk command is enabled', () => {
      const checks = buildSecurityStatusSnapshot({
        commands: [{ ...BASE_RULES[1], enabled: true }],
        appUrl: 'https://gateway.example',
        dbExists: true,
        secureCrypto: true,
      });

      const firewall = checks.checks.find((check) => check.id === 'firewall');
      expect(firewall?.status).toBe('critical');
      expect(firewall?.detail).toContain('High-Risk-Command');
    });

    it('marks firewall ok when high-risk commands are disabled', () => {
      const checks = buildSecurityStatusSnapshot({
        commands: BASE_RULES,
        appUrl: 'https://gateway.example',
        dbExists: true,
        secureCrypto: true,
      });

      const firewall = checks.checks.find((check) => check.id === 'firewall');
      expect(firewall?.status).toBe('ok');
    });
  });

  describe('encryption check', () => {
    it('warns when transport is not https', () => {
      const checks = buildSecurityStatusSnapshot({
        commands: BASE_RULES,
        appUrl: 'http://localhost:3000',
        dbExists: true,
        secureCrypto: true,
      });

      const encryption = checks.checks.find((check) => check.id === 'encryption');
      expect(encryption?.status).toBe('warning');
      expect(encryption?.detail).toContain('nicht HTTPS');
    });

    it('marks critical when WebCrypto is unavailable', () => {
      const checks = buildSecurityStatusSnapshot({
        commands: BASE_RULES,
        appUrl: 'https://gateway.example',
        dbExists: true,
        secureCrypto: false,
      });

      const encryption = checks.checks.find((check) => check.id === 'encryption');
      expect(encryption?.status).toBe('critical');
      expect(encryption?.detail).toContain('WebCrypto');
    });

    it('marks ok when https and WebCrypto available', () => {
      const checks = buildSecurityStatusSnapshot({
        commands: BASE_RULES,
        appUrl: 'https://gateway.example',
        dbExists: true,
        secureCrypto: true,
      });

      const encryption = checks.checks.find((check) => check.id === 'encryption');
      expect(encryption?.status).toBe('ok');
      expect(encryption?.detail).toContain('HTTPS aktiv');
    });
  });

  describe('audit check', () => {
    it('warns when audit database does not exist', () => {
      const checks = buildSecurityStatusSnapshot({
        commands: BASE_RULES,
        appUrl: 'https://gateway.example',
        dbExists: false,
        secureCrypto: true,
      });

      const audit = checks.checks.find((check) => check.id === 'audit');
      expect(audit?.status).toBe('warning');
      expect(audit?.detail).toContain('nicht gefunden');
    });

    it('marks ok when audit database exists', () => {
      const checks = buildSecurityStatusSnapshot({
        commands: BASE_RULES,
        appUrl: 'https://gateway.example',
        dbExists: true,
        secureCrypto: true,
      });

      const audit = checks.checks.find((check) => check.id === 'audit');
      expect(audit?.status).toBe('ok');
      expect(audit?.detail).toContain('verfügbar');
    });
  });

  describe('isolation check', () => {
    it('marks critical when rm -rf command is enabled', () => {
      const checks = buildSecurityStatusSnapshot({
        commands: [
          {
            id: 'c1',
            command: 'rm -rf /',
            description: 'Danger',
            category: 'System',
            risk: 'High',
            enabled: true,
          },
        ],
        appUrl: 'https://gateway.example',
        dbExists: true,
        secureCrypto: true,
      });

      const isolation = checks.checks.find((check) => check.id === 'isolation');
      expect(isolation?.status).toBe('critical');
    });

    it('marks critical when del /f /s /q command is enabled (Windows)', () => {
      const checks = buildSecurityStatusSnapshot({
        commands: [
          {
            id: 'c1',
            command: 'del /f /s /q *',
            description: 'Danger',
            category: 'System',
            risk: 'Low',
            enabled: true,
          },
        ],
        appUrl: 'https://gateway.example',
        dbExists: true,
        secureCrypto: true,
      });

      const isolation = checks.checks.find((check) => check.id === 'isolation');
      expect(isolation?.status).toBe('critical');
    });

    it('marks critical when powershell -enc command is enabled', () => {
      const checks = buildSecurityStatusSnapshot({
        commands: [
          {
            id: 'c1',
            command: 'powershell -enc abc123',
            description: 'Danger',
            category: 'System',
            risk: 'Low',
            enabled: true,
          },
        ],
        appUrl: 'https://gateway.example',
        dbExists: true,
        secureCrypto: true,
      });

      const isolation = checks.checks.find((check) => check.id === 'isolation');
      expect(isolation?.status).toBe('critical');
    });

    it('marks critical when format command is enabled', () => {
      const checks = buildSecurityStatusSnapshot({
        commands: [
          {
            id: 'c1',
            command: 'format c:',
            description: 'Danger',
            category: 'System',
            risk: 'Low',
            enabled: true,
          },
        ],
        appUrl: 'https://gateway.example',
        dbExists: true,
        secureCrypto: true,
      });

      const isolation = checks.checks.find((check) => check.id === 'isolation');
      expect(isolation?.status).toBe('critical');
    });

    it('marks warning when no high-risk rules are blocked', () => {
      const checks = buildSecurityStatusSnapshot({
        commands: [
          {
            id: 'c1',
            command: 'ls',
            description: 'List',
            category: 'Files',
            risk: 'Low',
            enabled: true,
          },
        ],
        appUrl: 'https://gateway.example',
        dbExists: true,
        secureCrypto: true,
      });

      const isolation = checks.checks.find((check) => check.id === 'isolation');
      expect(isolation?.status).toBe('warning');
      expect(isolation?.detail).toContain('Keine High-Risk-Regel');
    });

    it('marks ok when high-risk rules are blocked', () => {
      const checks = buildSecurityStatusSnapshot({
        commands: [
          {
            id: 'c1',
            command: 'rm -rf',
            description: 'Danger',
            category: 'System',
            risk: 'High',
            enabled: false,
          },
          {
            id: 'c2',
            command: 'format',
            description: 'Danger',
            category: 'System',
            risk: 'High',
            enabled: false,
          },
        ],
        appUrl: 'https://gateway.example',
        dbExists: true,
        secureCrypto: true,
      });

      const isolation = checks.checks.find((check) => check.id === 'isolation');
      expect(isolation?.status).toBe('ok');
      expect(isolation?.detail).toContain('isoliert');
    });
  });

  describe('channel security diagnostics', () => {
    it('includes all expected channels', () => {
      const checks = buildSecurityStatusSnapshot({
        commands: BASE_RULES,
        appUrl: 'https://gateway.example',
        dbExists: true,
        secureCrypto: true,
      });

      const channelNames = checks.channels.map((ch) => ch.channel);
      expect(channelNames).toContain('telegram');
      expect(channelNames).toContain('discord');
      expect(channelNames).toContain('whatsapp');
      expect(channelNames).toContain('imessage');
      expect(channelNames).toContain('slack');
    });

    it('reports signed verification for telegram and discord', () => {
      const checks = buildSecurityStatusSnapshot({
        commands: BASE_RULES,
        appUrl: 'https://gateway.example',
        dbExists: true,
        secureCrypto: true,
      });

      const telegram = checks.channels.find((ch) => ch.channel === 'telegram');
      const discord = checks.channels.find((ch) => ch.channel === 'discord');

      expect(telegram?.verification).toBe('signed');
      expect(discord?.verification).toBe('signed');
    });

    it('reports shared_secret verification for whatsapp, imessage, and slack', () => {
      const checks = buildSecurityStatusSnapshot({
        commands: BASE_RULES,
        appUrl: 'https://gateway.example',
        dbExists: true,
        secureCrypto: true,
      });

      const whatsapp = checks.channels.find((ch) => ch.channel === 'whatsapp');
      const imessage = checks.channels.find((ch) => ch.channel === 'imessage');
      const slack = checks.channels.find((ch) => ch.channel === 'slack');

      expect(whatsapp?.verification).toBe('shared_secret');
      expect(imessage?.verification).toBe('shared_secret');
      expect(slack?.verification).toBe('shared_secret');
    });

    it('warns when verification secret is missing', () => {
      // Clear all env vars for this test
      const originalEnv = { ...process.env };
      delete process.env.TELEGRAM_WEBHOOK_SECRET;
      delete process.env.DISCORD_PUBLIC_KEY;
      delete process.env.WHATSAPP_WEBHOOK_SECRET;
      delete process.env.IMESSAGE_WEBHOOK_SECRET;
      delete process.env.SLACK_WEBHOOK_SECRET;

      const checks = buildSecurityStatusSnapshot({
        commands: BASE_RULES,
        appUrl: 'https://gateway.example',
        dbExists: true,
        secureCrypto: true,
      });

      for (const channel of checks.channels) {
        if (!channel.secretConfigured) {
          expect(channel.status).toBe('warning');
          expect(channel.detail).toContain('missing');
        }
      }

      // Restore env
      process.env = originalEnv;
    });
  });

  describe('summary counts', () => {
    it('calculates correct summary counts', () => {
      const checks = buildSecurityStatusSnapshot({
        commands: BASE_RULES,
        appUrl: 'http://localhost:3000', // warning for encryption
        dbExists: false, // warning for audit
        secureCrypto: true,
      });

      // firewall: ok (high-risk disabled)
      // encryption: warning (not https)
      // audit: warning (db not found)
      // isolation: ok (one high-risk rule blocked: rm -rf)
      expect(checks.summary.ok).toBe(2); // firewall + isolation
      expect(checks.summary.warning).toBeGreaterThanOrEqual(2); // encryption + audit
      expect(checks.summary.critical).toBe(0);
    });

    it('counts critical issues correctly', () => {
      const checks = buildSecurityStatusSnapshot({
        commands: [{ ...BASE_RULES[1], enabled: true }], // high-risk enabled
        appUrl: 'https://gateway.example',
        dbExists: true,
        secureCrypto: false, // WebCrypto unavailable
      });

      // firewall: critical (high-risk enabled)
      // encryption: critical (no WebCrypto)
      expect(checks.summary.critical).toBeGreaterThanOrEqual(2);
    });

    it('all checks ok with secure configuration', () => {
      const checks = buildSecurityStatusSnapshot({
        commands: [
          {
            id: 'c1',
            command: 'rm -rf',
            description: 'Danger',
            category: 'System',
            risk: 'High',
            enabled: false,
          },
        ],
        appUrl: 'https://gateway.example',
        dbExists: true,
        secureCrypto: true,
      });

      expect(checks.summary.ok).toBe(4);
      expect(checks.summary.warning).toBe(0);
      expect(checks.summary.critical).toBe(0);
    });
  });

  describe('generatedAt timestamp', () => {
    it('includes a valid ISO timestamp', () => {
      const checks = buildSecurityStatusSnapshot({
        commands: BASE_RULES,
      });

      expect(checks.generatedAt).toBeDefined();
      const date = new Date(checks.generatedAt);
      expect(date).toBeInstanceOf(Date);
      expect(date.getTime()).not.toBeNaN();
    });
  });
});
