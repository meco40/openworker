import type { SkillManifest } from '@/shared/toolSchema';
import { executeSkillApi } from '@/skills/runtime-client';

const manifest: SkillManifest = {
  id: 'pdf-generate',
  name: 'PDF Generate',
  description: 'Wandelt HTML oder Markdown in eine PDF-Datei um.',
  version: '1.0.0',
  category: 'Automation',
  functionName: 'pdf_generate',
  tool: {
    name: 'pdf_generate',
    description:
      'Convert HTML or Markdown content into a PDF file saved in the workspace output/ folder. Uses headless Chromium if available, falls back to wkhtmltopdf, or saves as HTML if no converter is installed.',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The HTML or Markdown content to convert to PDF.',
        },
        filename: {
          type: 'string',
          description: 'Output filename without extension (e.g. "report"). Default: "document".',
        },
      },
      required: ['content'],
    },
  },
};

const pdfGenerateSkill = {
  ...manifest,
  execute: async (args: Record<string, unknown>) => executeSkillApi('pdf_generate', args),
};

export default pdfGenerateSkill;
