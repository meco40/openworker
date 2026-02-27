import type { SkillManifest } from '@/shared/toolSchema';
import { executeSkillApi } from '@/skills/runtime-client';

const manifest: SkillManifest = {
  id: 'edit',
  name: 'Edit (Compat)',
  description: 'Demo-compat alias for text replacement and line-range edits.',
  version: '1.0.0',
  category: 'Compatibility',
  functionName: 'edit',
  tool: {
    name: 'edit',
    description: 'Edit a file by old/new text replacement or by line range.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path.' },
        oldText: { type: 'string', description: 'Text to find.' },
        newText: { type: 'string', description: 'Replacement text.' },
        replaceAll: { type: 'boolean', description: 'Replace all matches when true.' },
        from: { type: 'number', description: 'Start line for range replace.' },
        to: { type: 'number', description: 'End line for range replace.' },
      },
      required: ['path'],
    },
  },
};

const editSkill = {
  ...manifest,
  execute: async (args: Record<string, unknown>) => executeSkillApi('edit', args),
};

export default editSkill;
