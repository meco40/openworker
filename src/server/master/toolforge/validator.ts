export function validateToolForgeSpec(spec: string): { valid: boolean; reason?: string } {
  const trimmed = String(spec || '').trim();
  if (!trimmed) return { valid: false, reason: 'empty_spec' };
  if (!trimmed.includes('{') || !trimmed.includes('}')) {
    return { valid: false, reason: 'spec_must_be_json_like' };
  }
  return { valid: true };
}
