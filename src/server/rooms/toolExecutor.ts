import type { PersonaPermissions } from './types';
import { getSkillRepository } from '../skills/skillRepository';
import { executeSkillFunctionCall } from '../../../skills/execute';
import type { Skill } from '../../../types';

export interface ToolExecutionResult {
  ok: boolean;
  output: string;
}

export interface ToolExecutionInput {
  functionName: string;
  args: Record<string, unknown>;
  permissions: PersonaPermissions | null;
}

/**
 * Execute a real skill function call with permission gating.
 *
 * 1. Check persona-level permission for the tool.
 * 2. Load installed skills from the repository.
 * 3. Delegate to the shared skill executor.
 */
export async function executeRoomTool(input: ToolExecutionInput): Promise<ToolExecutionResult> {
  const allowed = Boolean(input.permissions?.tools?.[input.functionName]);
  if (!allowed) {
    return {
      ok: false,
      output: `Tool denied: ${input.functionName}`,
    };
  }

  try {
    const repo = await getSkillRepository();
    const skillRows = repo.listSkills();
    // Map SkillRow[] to Skill[] (the shape executeSkillFunctionCall expects)
    const skills: Skill[] = skillRows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      category: row.category,
      installed: row.installed,
      version: row.version,
      functionName: row.functionName,
      source: row.source,
      sourceUrl: row.sourceUrl ?? undefined,
    }));

    const result = await executeSkillFunctionCall(input.functionName, input.args, skills);
    const output = typeof result === 'string' ? result : JSON.stringify(result ?? 'No output');
    return { ok: true, output };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Tool execution failed';
    return { ok: false, output: message };
  }
}
