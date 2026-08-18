/**
 * Shared guard for memory content that can later be injected into an AI prompt.
 *
 * The guard normalizes common obfuscation before matching and is complemented
 * by explicit untrusted-data boundaries at prompt construction time.
 */

export interface PoisoningCheckResult {
  isSafe: boolean;
  reason: string | null;
  riskLevel: 'safe' | 'suspicious' | 'blocked';
}

const BLOCKED_PATTERNS: RegExp[] = [
  /\b(?:system|assistant|developer|admin|root)\s*:/i,
  /\b(?:vergiss|ignoriere|übergehe|uebergehe)\s+(?:alle|bisherige|vorherige|diese)\b/i,
  /\b(?:ignore|disregard|forget|override|bypass)\b.{0,80}\b(?:instructions?|rules?|polic(?:y|ies)|prompts?|memories)\b/i,
  /\b(?:du bist|you are)\s+(?:jetzt|ab sofort|now|from now on)\b/i,
  /\b(?:passwort|password|token|secret|api[_ -]?key|credential)\b.{0,80}\b(?:send|show|reveal|exfil|export|ausgeben|anzeigen)\b/i,
  /\b(?:admin[- ]?(?:passwort|password)|(?:passwort|password)\s+ist)\b/i,
];

const SUSPICIOUS_PATTERNS: RegExp[] = [
  /\b(?:base64|eval|exec|decode|entschlüss|entschluess)\s*[:(]/i,
  /```[\s\S]{400,}```/,
  /\bhttps?:\/\/\S{180,}/i,
  /(?:<system>|<\/system>|\[system\]|\[developer\])/i,
];

function normalizeContent(content: string): string {
  return content
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/&(?:lt|gt|quot|apos|amp);/gi, (entity) => {
      const values: Record<string, string> = {
        '&lt;': '<',
        '&gt;': '>',
        '&quot;': '"',
        '&apos;': "'",
        '&amp;': '&',
      };
      return values[entity.toLowerCase()] || entity;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeBoundedCandidates(normalized: string): string[] {
  const candidates = [normalized];
  try {
    const percentDecoded = decodeURIComponent(normalized);
    if (percentDecoded !== normalized) candidates.push(percentDecoded);
  } catch {
    // Invalid percent encoding is not itself proof of poisoning.
  }

  const base64Candidates = normalized.match(/\b[A-Za-z0-9+/]{32,}={0,2}\b/g) || [];
  for (const candidate of base64Candidates.slice(0, 3)) {
    try {
      const decoded = Buffer.from(candidate, 'base64').toString('utf8');
      if (decoded && decoded !== candidate && decoded.length <= 10_000) candidates.push(decoded);
    } catch {
      // Invalid base64 is not itself proof of poisoning.
    }
  }
  return candidates;
}

export function normalizeMemoryContent(content: string): string {
  return normalizeContent(String(content || ''));
}

export function checkMemoryPoisoning(content: string): PoisoningCheckResult {
  const candidates = decodeBoundedCandidates(normalizeContent(content));
  for (const candidate of candidates) {
    if (BLOCKED_PATTERNS.some((pattern) => pattern.test(candidate))) {
      return {
        isSafe: false,
        reason: 'Blocked: memory instruction-injection pattern detected',
        riskLevel: 'blocked',
      };
    }
  }
  if (
    candidates.some((candidate) => SUSPICIOUS_PATTERNS.some((pattern) => pattern.test(candidate)))
  ) {
    return {
      isSafe: true,
      reason: 'Suspicious memory content flagged for audit',
      riskLevel: 'suspicious',
    };
  }
  return { isSafe: true, reason: null, riskLevel: 'safe' };
}
