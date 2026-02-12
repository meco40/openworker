import type { PersonaPermissions } from './types';

export interface ToolExecutionResult {
  ok: boolean;
  output: string;
}

export interface ToolExecutionInput {
  toolName: string;
  permissions: PersonaPermissions | null;
}

export async function executeRoomTool(input: ToolExecutionInput): Promise<ToolExecutionResult> {
  const allowed = Boolean(input.permissions?.tools?.[input.toolName]);
  if (!allowed) {
    return {
      ok: false,
      output: `Tool denied: ${input.toolName}`,
    };
  }

  return {
    ok: true,
    output: `Tool executed: ${input.toolName}`,
  };
}
