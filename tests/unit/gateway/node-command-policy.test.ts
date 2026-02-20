import { describe, expect, it } from 'vitest';
import {
  commandFingerprint,
  evaluateNodeCommandPolicy,
  normalizeCommand,
} from '@/server/gateway/node-command-policy';

describe('node command policy', () => {
  it('allows safe commands', () => {
    const result = evaluateNodeCommandPolicy('echo hello');
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('blocks dangerous commands', () => {
    const result = evaluateNodeCommandPolicy('rm -rf /tmp/test');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('blocked');
  });

  it('normalizes command and keeps stable fingerprint', () => {
    const one = normalizeCommand('echo   hello');
    const two = normalizeCommand(' echo hello ');
    expect(one).toBe(two);
    expect(commandFingerprint(one)).toBe(commandFingerprint(two));
  });
});
