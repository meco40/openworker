/**
 * Normalise arbitrary input into a plain key-value object.
 *
 * AI providers may deliver function-call arguments as a JSON string, a
 * pre-parsed object, or `null`/`undefined`.  This helper guarantees a
 * `Record<string, unknown>` regardless of the input shape.
 *
 * Replaces the previously duplicated logic in
 *   - skills/execute.ts  (normalizeArgs)
 *   - src/server/skills/executeSkill.ts  (normalizeSkillArgs)
 */
export function normalizeArgs(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === 'object' && parsed ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' ? (value as Record<string, unknown>) : {};
}
