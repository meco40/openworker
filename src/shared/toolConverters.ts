/**
 * Convert provider-agnostic ToolDefinitions into provider-specific formats.
 *
 * Supported providers:
 *   - gemini  → Google GenAI FunctionDeclaration
 *   - openai  → OpenAI function-calling tool
 *   - claude  → Anthropic / MCP tool
 */

import type { SkillToolDefinition, ToolDefinition, ToolParameterProperty } from './toolSchema';
import { isBuiltIn } from './toolSchema';

// ── Gemini ───────────────────────────────────────────────────────

interface GeminiProperty {
  type: string;
  description: string;
  enum?: string[];
}

function mapTypeToGemini(type: string): string {
  const map: Record<string, string> = {
    string: 'STRING',
    number: 'NUMBER',
    boolean: 'BOOLEAN',
    array: 'ARRAY',
    object: 'OBJECT',
  };
  return map[type] ?? 'STRING';
}

function toGeminiProperties(
  props: Record<string, ToolParameterProperty>,
): Record<string, GeminiProperty> {
  const out: Record<string, GeminiProperty> = {};
  for (const [key, prop] of Object.entries(props)) {
    out[key] = {
      type: mapTypeToGemini(prop.type),
      description: prop.description,
      ...(prop.enum ? { enum: prop.enum } : {}),
    };
  }
  return out;
}

export function toGeminiTool(def: ToolDefinition) {
  return {
    functionDeclarations: [
      {
        name: def.name,
        description: def.description,
        parameters: {
          type: 'OBJECT',
          properties: toGeminiProperties(def.parameters.properties),
          required: def.parameters.required ?? [],
        },
      },
    ],
  };
}

// ── OpenAI ───────────────────────────────────────────────────────

export function toOpenAITool(def: ToolDefinition) {
  return {
    type: 'function' as const,
    function: {
      name: def.name,
      description: def.description,
      parameters: {
        type: 'object',
        properties: def.parameters.properties,
        required: def.parameters.required ?? [],
      },
    },
  };
}

// ── Claude / MCP ─────────────────────────────────────────────────

export function toClaudeTool(def: ToolDefinition) {
  return {
    name: def.name,
    description: def.description,
    input_schema: {
      type: 'object',
      properties: def.parameters.properties,
      required: def.parameters.required ?? [],
    },
  };
}

// ── Universal dispatcher ─────────────────────────────────────────

type ProviderConverter = (def: ToolDefinition) => unknown;

const CONVERTERS: Record<string, ProviderConverter> = {
  gemini: toGeminiTool,
  openai: toOpenAITool,
  claude: toClaudeTool,
};

/**
 * Convert an array of SkillToolDefinitions into the provider-specific
 * tool format.  Built-in tools are passed through using their
 * provider-specific config (if available for the requested provider).
 */
export function convertTools(defs: SkillToolDefinition[], provider: string): unknown[] {
  const converter = CONVERTERS[provider];
  if (!converter) {
    throw new Error(`No tool converter registered for provider "${provider}".`);
  }

  const tools: unknown[] = [];

  for (const def of defs) {
    if (isBuiltIn(def)) {
      // Built-in features are provider-specific (e.g. googleSearch for Gemini).
      const config = def.providerConfig[provider];
      if (config) {
        tools.push(config);
      }
      continue;
    }
    tools.push(converter(def));
  }

  return tools;
}
