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
  it('marks firewall critical when high-risk command is enabled', () => {
    const checks = buildSecurityStatusSnapshot({
      commands: [{ ...BASE_RULES[1], enabled: true }],
      appUrl: 'https://gateway.example',
      dbExists: true,
      secureCrypto: true,
    });

    const firewall = checks.checks.find((check) => check.id === 'firewall');
    expect(firewall?.status).toBe('critical');
  });

  it('warns when transport is not https', () => {
    const checks = buildSecurityStatusSnapshot({
      commands: BASE_RULES,
      appUrl: 'http://localhost:3000',
      dbExists: true,
      secureCrypto: true,
    });

    const encryption = checks.checks.find((check) => check.id === 'encryption');
    expect(encryption?.status).toBe('warning');
  });

  it('warns when audit database does not exist', () => {
    const checks = buildSecurityStatusSnapshot({
      commands: BASE_RULES,
      appUrl: 'https://gateway.example',
      dbExists: false,
      secureCrypto: true,
    });

    const audit = checks.checks.find((check) => check.id === 'audit');
    expect(audit?.status).toBe('warning');
  });
});
