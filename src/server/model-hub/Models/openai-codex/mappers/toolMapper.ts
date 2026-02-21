import { toNonEmptyString, toStringOrNull } from '../utils/typeGuards';

export function mapCodexFunctionTool(rawTool: unknown): Record<string, unknown> | null {
  if (!rawTool || typeof rawTool !== 'object' || Array.isArray(rawTool)) return null;

  const typedRawTool = rawTool as {
    type?: unknown;
    name?: unknown;
    description?: unknown;
    parameters?: unknown;
    strict?: unknown;
    function?: {
      name?: unknown;
      description?: unknown;
      parameters?: unknown;
      strict?: unknown;
    };
  };

  if (typedRawTool.type !== 'function') return null;

  const directName = toNonEmptyString(typedRawTool.name);
  const nestedName = toNonEmptyString(typedRawTool.function?.name);
  const name = directName || nestedName;
  if (!name) return null;

  const description =
    toStringOrNull(typedRawTool.description) ??
    toStringOrNull(typedRawTool.function?.description) ??
    undefined;
  const parameters =
    (typedRawTool.parameters &&
    typeof typedRawTool.parameters === 'object' &&
    !Array.isArray(typedRawTool.parameters)
      ? typedRawTool.parameters
      : undefined) ??
    (typedRawTool.function?.parameters &&
    typeof typedRawTool.function.parameters === 'object' &&
    !Array.isArray(typedRawTool.function.parameters)
      ? typedRawTool.function.parameters
      : undefined);
  const strict =
    typeof typedRawTool.strict === 'boolean'
      ? typedRawTool.strict
      : typeof typedRawTool.function?.strict === 'boolean'
        ? typedRawTool.function.strict
        : undefined;

  const mapped: Record<string, unknown> = {
    type: 'function',
    name,
  };
  if (description !== undefined) mapped.description = description;
  if (parameters !== undefined) mapped.parameters = parameters;
  if (strict !== undefined) mapped.strict = strict;
  return mapped;
}

export function mapCodexTools(tools: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(tools) || tools.length === 0) return [];
  return tools
    .map((tool) => mapCodexFunctionTool(tool))
    .filter((tool): tool is Record<string, unknown> => tool !== null);
}
