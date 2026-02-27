export function buildIntegrationProposalTemplate(input: {
  capability: string;
  reason: string;
  apiReference: string;
  authModel: string;
  scopes: string[];
  rateLimit: string;
  fallbackPlan: string;
}): string {
  return [
    `Capability: ${input.capability}`,
    `Reason: ${input.reason}`,
    `Official API: ${input.apiReference}`,
    `Auth Model: ${input.authModel}`,
    `Scopes: ${input.scopes.join(', ')}`,
    `Rate Limits: ${input.rateLimit}`,
    `Fallback: ${input.fallbackPlan}`,
  ].join('\n');
}
