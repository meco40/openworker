export type GatewayMethodScope = 'gateway.call' | 'gateway.chat' | 'channels' | 'sessions';

const SCOPE_PATTERNS: Record<GatewayMethodScope, RegExp[]> = {
  'gateway.call': [
    /^health$/,
    /^presence\./,
    /^channels\./,
    /^inbox\.list$/,
    /^sessions\./,
    /^chat\.history$/,
    /^chat\.abort$/,
    /^chat\.approval\.respond$/,
    /^chat\.conversations\.list$/,
    /^logs\./,
  ],
  'gateway.chat': [
    /^chat\.stream$/,
    /^chat\.abort$/,
    /^chat\.approval\.respond$/,
    /^chat\.history$/,
    /^sessions\.reset$/,
  ],
  channels: [/^channels\./, /^inbox\.list$/],
  sessions: [/^sessions\./, /^chat\.history$/, /^chat\.conversations\.list$/],
};

export function isMethodAllowed(scope: GatewayMethodScope, method: string): boolean {
  const normalized = method.trim();
  if (!normalized) return false;
  return SCOPE_PATTERNS[scope].some((pattern) => pattern.test(normalized));
}
