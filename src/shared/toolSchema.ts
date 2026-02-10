/**
 * Provider-agnostic tool/skill definition — standard JSON Schema.
 *
 * Every AI provider (Gemini, OpenAI, Claude/MCP) uses JSON Schema as the
 * common denominator for function-calling tool definitions.  We define ONE
 * canonical format here and convert per-provider at dispatch time via the
 * converters in `toolConverters.ts`.
 */

// ── Parameter types ──────────────────────────────────────────────

export interface ToolParameterProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  enum?: string[];
  items?: ToolParameterProperty;
}

export interface ToolParameters {
  type: 'object';
  properties: Record<string, ToolParameterProperty>;
  required?: string[];
}

// ── Tool definitions ─────────────────────────────────────────────

/** A regular function-calling tool (browser_snapshot, file_read, …). */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameters;
}

/**
 * A built-in provider feature that is NOT a standard function declaration
 * (e.g. Google Search Grounding).  The `providerConfig` map holds the
 * provider-specific payload keyed by provider id.
 */
export interface BuiltInToolDefinition {
  builtIn: true;
  providerConfig: Record<string, unknown>;
}

export type SkillToolDefinition = ToolDefinition | BuiltInToolDefinition;

export function isBuiltIn(def: SkillToolDefinition): def is BuiltInToolDefinition {
  return 'builtIn' in def && def.builtIn === true;
}

// ── Skill manifest ───────────────────────────────────────────────

/**
 * Standard skill manifest — used by both built-in AND external skills.
 * External skills ship this as `skill.json` in their repo/package root.
 */
export interface SkillManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  category: string;
  /** The function name the AI model uses to invoke this skill. */
  functionName: string;
  /** Tool definition (JSON Schema) or built-in provider feature. */
  tool: SkillToolDefinition;
  /**
   * For external skills: relative path to the handler module
   * (resolved from the skill's install directory).
   */
  handler?: string;
}
