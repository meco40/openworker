import { Type, FunctionDeclaration } from '@google/genai';

export const visionTool: FunctionDeclaration = {
  name: 'vision_analyze',
  description: 'Analyze image input (URL or base64) for objects, text and scene context.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      focus: { type: Type.STRING, description: 'Area of interest' },
      imageUrl: { type: Type.STRING, description: 'Public image URL to analyze.' },
      imageBase64: {
        type: Type.STRING,
        description: 'Base64 encoded image payload (without data URL prefix).',
      },
      mimeType: { type: Type.STRING, description: 'Mime type for base64 payload.' },
    },
  },
};
