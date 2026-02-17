/**
 * Memory Poisoning Guard — prevents prompt injection and credential leaks
 * from being stored as memory facts.
 */

export interface PoisoningCheckResult {
  isSafe: boolean;
  reason: string | null;
  riskLevel: 'safe' | 'suspicious' | 'blocked';
}

const INJECTION_PATTERNS: RegExp[] = [
  /\b(?:system|admin|root)\s*:\s/i,
  /\b(?:vergiss|ignoriere)\s+(?:alle|bisherige|vorherige)\b/i,
  /\b(?:passwort|password|token|secret|api[_-]?key)\b/i,
  /\bignore\b.{0,30}\binstructions\b/i,
  /\bdu bist (?:jetzt|ab sofort)\b/i,
];

const SUSPICIOUS_PATTERNS: RegExp[] = [
  /\b(?:base64|eval|exec)\s*\(/i,
  /```[\s\S]{500,}```/,
  /\bhttps?:\/\/\S{200,}/i,
];

/**
 * Checks content for poisoning/injection attempts before memory storage.
 *
 * - 'blocked': Content must NOT be stored (injection attempt).
 * - 'suspicious': Content can be stored but should be flagged for audit.
 * - 'safe': Normal content.
 */
export function checkMemoryPoisoning(content: string): PoisoningCheckResult {
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(content)) {
      return { isSafe: false, reason: 'Blocked: injection pattern detected', riskLevel: 'blocked' };
    }
  }

  for (const pattern of SUSPICIOUS_PATTERNS) {
    if (pattern.test(content)) {
      return { isSafe: true, reason: 'Suspicious content flagged', riskLevel: 'suspicious' };
    }
  }

  return { isSafe: true, reason: null, riskLevel: 'safe' };
}
