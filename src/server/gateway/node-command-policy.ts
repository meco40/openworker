import { createHash } from 'node:crypto';

export interface NodeCommandPolicyResult {
  allowed: boolean;
  reason?: string;
  normalizedCommand: string;
  fingerprint: string;
}

const BLOCKED_SUBSTRINGS = [
  'rm -rf',
  'mkfs',
  'dd if=',
  'shutdown',
  'reboot',
  'format ',
  'reg delete',
  'sc stop',
  'bcdedit',
  'diskpart',
  'powershell -enc',
  'invoke-expression',
  ':(){',
  'cipher /w',
];

const BLOCKED_PATTERNS = [/\bdel\s+\/f\s+\/s\s+\/q\b/i, /\bformat\b/i, /\biex\b/i] as const;

export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

export function commandFingerprint(command: string): string {
  return createHash('sha256').update(normalizeCommand(command)).digest('hex');
}

export function evaluateNodeCommandPolicy(command: string): NodeCommandPolicyResult {
  const normalizedCommand = normalizeCommand(command);
  const lowered = normalizedCommand.toLowerCase();

  if (!normalizedCommand) {
    return {
      allowed: false,
      reason: 'Command is empty.',
      normalizedCommand,
      fingerprint: commandFingerprint(command),
    };
  }

  if (BLOCKED_SUBSTRINGS.some((token) => lowered.includes(token))) {
    return {
      allowed: false,
      reason: 'Command blocked by security policy.',
      normalizedCommand,
      fingerprint: commandFingerprint(command),
    };
  }

  if (BLOCKED_PATTERNS.some((pattern) => pattern.test(normalizedCommand))) {
    return {
      allowed: false,
      reason: 'Command blocked by security policy.',
      normalizedCommand,
      fingerprint: commandFingerprint(command),
    };
  }

  return {
    allowed: true,
    normalizedCommand,
    fingerprint: commandFingerprint(command),
  };
}
