import { describe, expect, it } from 'vitest';
import { SECURITY_RULES } from '../../../constants';

describe('security rules baseline', () => {
  it('contains blocked high-risk destructive and privileged commands', () => {
    const requiredBlockedHighRisk = [
      'rm -rf',
      'del /f /s /q',
      'format',
      'shutdown',
      'powershell -enc',
      'reg delete',
      'sc stop',
    ];

    for (const command of requiredBlockedHighRisk) {
      const rule = SECURITY_RULES.find((item) => item.command === command);
      expect(rule).toBeDefined();
      expect(rule?.risk).toBe('High');
      expect(rule?.enabled).toBe(false);
    }
  });

  it('contains allowed baseline safe commands for normal workflows', () => {
    const requiredAllowed = ['ls', 'pwd', 'mkdir', 'rg', 'git status', 'npm install'];
    for (const command of requiredAllowed) {
      const rule = SECURITY_RULES.find((item) => item.command === command);
      expect(rule).toBeDefined();
      expect(rule?.enabled).toBe(true);
    }
  });
});
