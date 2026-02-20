import type { GatewayRequest } from '@/server/model-hub/Models/types';

export interface PromptInjectionDetection {
  riskLevel: 'low' | 'medium' | 'high';
  score: number;
  reasons: string[];
}

const SECRET_REPLACEMENT = '[REDACTED]';

const REDACTION_RULES: Array<{ pattern: RegExp; replaceWith: string }> = [
  // Authorization header/token payloads.
  { pattern: /(Bearer\s+)[A-Za-z0-9._-]+/gi, replaceWith: `$1${SECRET_REPLACEMENT}` },
  // Common API key prefixes.
  {
    pattern: /\b(sk-[A-Za-z0-9_-]{8,}|gh[opus]_[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g,
    replaceWith: SECRET_REPLACEMENT,
  },
  // key=value / key: value secrets.
  {
    pattern:
      /\b(api[-_]?key|token|password|secret|authorization)\b\s*[:=]\s*["']?[^"',\s}]+["']?/gi,
    replaceWith: '$1=[REDACTED]',
  },
];

const INJECTION_PATTERNS: Array<{ pattern: RegExp; score: number; reason: string }> = [
  {
    pattern: /ignore\s+(all|any|previous|prior)\s+(instructions|rules|messages)/i,
    score: 35,
    reason: 'Attempt to override prior instructions.',
  },
  {
    pattern: /(reveal|show|print|leak).*(system prompt|developer message|hidden instructions)/i,
    score: 40,
    reason: 'Attempt to exfiltrate protected prompt layers.',
  },
  {
    pattern: /(jailbreak|dan mode|developer mode|god mode)/i,
    score: 35,
    reason: 'Known jailbreak pattern.',
  },
  {
    pattern: /(bypass|disable).*(safety|policy|guardrail)/i,
    score: 30,
    reason: 'Attempt to disable safety guardrails.',
  },
  {
    pattern: /(you are now|act as)\s+(system|developer)/i,
    score: 25,
    reason: 'Role reassignment attempt.',
  },
  {
    pattern: /\brole\s*:\s*system\b/i,
    score: 20,
    reason: 'Potential system role injection.',
  },
];

export function redactSensitiveText(text: string): string {
  let redacted = text;
  for (const rule of REDACTION_RULES) {
    redacted = redacted.replace(rule.pattern, rule.replaceWith);
  }
  return redacted;
}

function redactUnknown(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactSensitiveText(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactUnknown(entry));
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      output[key] = redactUnknown(nested);
    }
    return output;
  }
  return value;
}

export function redactGatewayRequest(request: GatewayRequest): GatewayRequest {
  return redactUnknown(request) as GatewayRequest;
}

export function estimatePromptTokens(request: GatewayRequest): number {
  const contentParts: string[] = [];

  if (request.systemInstruction) {
    contentParts.push(request.systemInstruction);
  }
  for (const message of request.messages) {
    contentParts.push(message.content);
    if (message.attachments?.length) {
      contentParts.push(
        message.attachments
          .map((attachment) => `[attachment:${attachment.name}:${attachment.mimeType}]`)
          .join('\n'),
      );
    }
  }
  if (request.tools) {
    contentParts.push(JSON.stringify(request.tools));
  }

  const text = contentParts.join('\n').trim();
  if (!text) return 0;

  return Math.max(1, Math.ceil(text.length / 4));
}

export function detectPromptInjection(text: string): PromptInjectionDetection {
  const reasons: string[] = [];
  let score = 0;

  for (const rule of INJECTION_PATTERNS) {
    if (!rule.pattern.test(text)) continue;
    score += rule.score;
    reasons.push(rule.reason);
  }

  if (reasons.length === 0) {
    return { riskLevel: 'low', score: 0, reasons: [] };
  }

  const capped = Math.min(100, score);
  const riskLevel = capped >= 70 ? 'high' : capped >= 35 ? 'medium' : 'low';

  return {
    riskLevel,
    score: capped,
    reasons: Array.from(new Set(reasons)),
  };
}
