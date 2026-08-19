export const CONSOLIDATION_POLICY_VERSION = '1';

export interface ConsolidationPolicyInput {
  summary: string;
  sourceObservationIds: string[];
}

export function validateConsolidationPolicy(input: ConsolidationPolicyInput): string[] {
  const errors: string[] = [];
  const summary = input.summary.trim();
  const sources = new Set(input.sourceObservationIds.map((id) => id.trim()).filter(Boolean));
  if (!summary) errors.push('summary must not be empty');
  if (summary.length > 12_000) errors.push('summary exceeds 12000 characters');
  if (sources.size === 0) errors.push('at least one source observation is required');
  if (sources.size > 100) errors.push('at most 100 source observations are allowed');
  return errors;
}

export function normalizedSourceObservationIds(ids: string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))].sort();
}
