import { describe, expect, it } from 'vitest';
import { toGeminiTool, toOpenAITool, toClaudeTool, convertTools } from '@/shared/toolConverters';
import type {
  ToolDefinition,
  BuiltInToolDefinition,
  SkillToolDefinition,
} from '@/shared/toolSchema';

const SAMPLE_TOOL: ToolDefinition = {
  name: 'browser_snapshot',
  description: 'Fetch and inspect a web page.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Target URL to inspect.' },
      format: { type: 'string', description: 'png or jpeg', enum: ['png', 'jpeg'] },
      quality: { type: 'number', description: '0-100' },
    },
    required: ['url'],
  },
};

const SEARCH_TOOL: BuiltInToolDefinition = {
  builtIn: true,
  providerConfig: {
    gemini: { googleSearch: {} },
  },
};

describe('toGeminiTool', () => {
  it('wraps in functionDeclarations with uppercase types', () => {
    const result = toGeminiTool(SAMPLE_TOOL);
    expect(result).toHaveProperty('functionDeclarations');
    expect(result.functionDeclarations).toHaveLength(1);

    const fn = result.functionDeclarations[0];
    expect(fn.name).toBe('browser_snapshot');
    expect(fn.description).toBe('Fetch and inspect a web page.');
    expect(fn.parameters.type).toBe('OBJECT');
    expect(fn.parameters.properties.url.type).toBe('STRING');
    expect(fn.parameters.properties.format.type).toBe('STRING');
    expect(fn.parameters.properties.format.enum).toEqual(['png', 'jpeg']);
    expect(fn.parameters.properties.quality.type).toBe('NUMBER');
    expect(fn.parameters.required).toEqual(['url']);
  });
});

describe('toOpenAITool', () => {
  it('wraps in { type: "function", function: {...} }', () => {
    const result = toOpenAITool(SAMPLE_TOOL);
    expect(result.type).toBe('function');
    expect(result.function.name).toBe('browser_snapshot');
    expect(result.function.description).toBe('Fetch and inspect a web page.');
    expect(result.function.parameters.type).toBe('object');
    expect(result.function.parameters.properties.url.type).toBe('string');
    expect(result.function.parameters.required).toEqual(['url']);
  });
});

describe('toClaudeTool', () => {
  it('wraps in { name, description, input_schema }', () => {
    const result = toClaudeTool(SAMPLE_TOOL);
    expect(result.name).toBe('browser_snapshot');
    expect(result.description).toBe('Fetch and inspect a web page.');
    expect(result.input_schema.type).toBe('object');
    expect(result.input_schema.properties.url.type).toBe('string');
    expect(result.input_schema.required).toEqual(['url']);
  });
});

describe('convertTools', () => {
  const defs: SkillToolDefinition[] = [SAMPLE_TOOL, SEARCH_TOOL];

  it('converts for gemini and includes built-in', () => {
    const tools = convertTools(defs, 'gemini');
    expect(tools).toHaveLength(2);

    // First: functionDeclarations wrapper
    const firstTool = tools[0] as { functionDeclarations: unknown[] };
    expect(firstTool.functionDeclarations).toBeDefined();

    // Second: googleSearch built-in pass-thru
    expect(tools[1]).toEqual({ googleSearch: {} });
  });

  it('converts for openai and skips unsupported built-ins', () => {
    const tools = convertTools(defs, 'openai');
    // search has no openai config, so only 1 tool
    expect(tools).toHaveLength(1);
    const firstTool = tools[0] as { type: string };
    expect(firstTool.type).toBe('function');
  });

  it('converts for claude', () => {
    const tools = convertTools(defs, 'claude');
    expect(tools).toHaveLength(1);
    const firstTool = tools[0] as { name: string; input_schema: unknown };
    expect(firstTool.name).toBe('browser_snapshot');
    expect(firstTool.input_schema).toBeDefined();
  });

  it('throws for unknown provider', () => {
    expect(() => convertTools(defs, 'unknown')).toThrow('No tool converter');
  });
});
