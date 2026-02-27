import type { SkillManifest } from '@/shared/toolSchema';
import { executeSkillApi } from '@/skills/runtime-client';

const manifest: SkillManifest = {
  id: 'apply-patch',
  name: 'Apply Patch (Compat)',
  description: 'Demo-compat alias for unified diff patch application.',
  version: '1.0.0',
  category: 'Compatibility',
  functionName: 'apply_patch',
  tool: {
    name: 'apply_patch',
    description: 'Apply patch text in *** Begin Patch format.',
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Patch input in Begin/End Patch format.' },
      },
      required: ['input'],
    },
  },
};

const applyPatchSkill = {
  ...manifest,
  execute: async (args: Record<string, unknown>) => executeSkillApi('apply_patch', args),
};

export default applyPatchSkill;
