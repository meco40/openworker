import { getSkillRepository } from '@/server/skills/skillRepository';

export async function assertSkillActive(functionName: string): Promise<void> {
  const normalized = functionName.trim();
  const candidates = new Set([normalized, normalized.replace(/\./g, '_')]);
  const repository = await getSkillRepository();
  const skill = repository.listSkills().find((row) => {
    const toolName =
      row.toolDefinition && typeof row.toolDefinition === 'object'
        ? String((row.toolDefinition as { name?: unknown }).name || '')
        : '';
    return candidates.has(row.functionName) || candidates.has(row.id) || candidates.has(toolName);
  });

  if (!skill || !skill.installed) {
    throw new Error(`Skill is not active: ${functionName}`);
  }
}
