export type AggregationStatus = 'accepted' | 'needs_rework' | 'rejected';

export interface DelegationResult {
  summary?: string;
  output?: string;
  confidence?: number;
}

export function aggregateDelegationResult(result: DelegationResult): {
  status: AggregationStatus;
  mergedOutput: string;
} {
  const confidence = result.confidence ?? 0;
  if (!result.output || result.output.trim().length === 0) {
    return { status: 'rejected', mergedOutput: '' };
  }
  if (confidence < 0.5) {
    return { status: 'needs_rework', mergedOutput: result.output };
  }
  return { status: 'accepted', mergedOutput: result.output };
}
