interface BuildSystemInstructionInput {
  baseInstruction: string;
  personaFiles: Record<string, string> | null;
  clawHubPromptBlock: string;
}

export function buildSystemInstruction(input: BuildSystemInstructionInput): string {
  let instruction = input.baseInstruction;

  if (input.personaFiles) {
    const parts: string[] = [];
    for (const name of ['SOUL.md', 'AGENTS.md', 'USER.md'] as const) {
      const content = input.personaFiles[name];
      if (content?.trim()) {
        parts.push(content.trim());
      }
    }
    if (parts.length > 0) {
      instruction = parts.join('\n\n---\n\n');
    }
  }

  const clawHubBlock = input.clawHubPromptBlock.trim();
  if (clawHubBlock) {
    instruction = `${instruction}\n\n---\n\n${clawHubBlock}`;
  }

  return instruction.slice(0, 6000);
}
