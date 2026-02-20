import type { SkillRuntimeConfigStatus } from '@/skills/runtime-config-client';

interface SkillConfigHints {
  requiredHint: string | null;
  optionalHint: string | null;
}

export function buildSkillConfigHints(
  skillId: string,
  runtimeConfigs: SkillRuntimeConfigStatus[],
): SkillConfigHints {
  const configs = runtimeConfigs.filter((config) => config.skillId === skillId);
  if (configs.length === 0) {
    return { requiredHint: null, optionalHint: null };
  }

  const required = configs.filter((config) => config.required).map((config) => config.label);
  const optional = configs.filter((config) => !config.required).map((config) => config.label);

  return {
    requiredHint: required.length > 0 ? `Requires setup: ${required.join(', ')}` : null,
    optionalHint: optional.length > 0 ? `Optional setup: ${optional.join(', ')}` : null,
  };
}
