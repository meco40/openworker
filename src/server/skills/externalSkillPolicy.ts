export function areExternalSkillsEnabled(): boolean {
  return process.env.EXTERNAL_SKILLS_ENABLED === 'true';
}

export function assertExternalSkillsEnabled(): void {
  if (!areExternalSkillsEnabled()) {
    throw new Error(
      'External skills are disabled. Set EXTERNAL_SKILLS_ENABLED=true only after reviewing and isolating the skill source.',
    );
  }
}
