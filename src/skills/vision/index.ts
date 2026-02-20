import type { SkillManifest } from '@/shared/toolSchema';
import { executeSkillApi } from '@/skills/runtime-client';

const manifest: SkillManifest = {
  id: 'vision',
  name: 'Live Vision',
  description: 'Echtzeit-Analyse von Kamera-Feeds und Screen-Streams.',
  version: '2.4.0',
  category: 'Media',
  functionName: 'vision_analyze',
  tool: {
    name: 'vision_analyze',
    description: 'Analyze image input (URL or base64) for objects, text and scene context.',
    parameters: {
      type: 'object',
      properties: {
        focus: { type: 'string', description: 'Area of interest or specific object to look for.' },
        imageUrl: { type: 'string', description: 'Public image URL to analyze.' },
        imageBase64: {
          type: 'string',
          description: 'Base64 encoded image payload (without data URL prefix).',
        },
        mimeType: { type: 'string', description: 'Mime type for base64 payload, e.g. image/png.' },
      },
    },
  },
};

const visionSkill = {
  ...manifest,
  execute: async (args: Record<string, unknown>) => executeSkillApi('vision_analyze', args),
};

export default visionSkill;
