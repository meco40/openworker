import type { SkillManifest } from '@/shared/toolSchema';
import { executeSkillApi } from '@/skills/runtime-client';

const manifest: SkillManifest = {
  id: 'playwright-cli',
  name: 'Playwright CLI',
  description: 'Run Playwright via CLI for browser tests, tracing, and debugging.',
  version: '1.0.0',
  category: 'Automation',
  functionName: 'playwright_cli',
  tool: {
    name: 'playwright_cli',
    description:
      'Execute Playwright CLI commands (CLI-first), e.g. test runs, trace/report viewing, and codegen.',
    parameters: {
      type: 'object',
      properties: {
        args: {
          type: 'array',
          description:
            'CLI tokens passed after "playwright" (for example ["test","--project=chromium"]).',
          items: { type: 'string', description: 'One CLI token.' },
        },
        command: {
          type: 'string',
          description:
            'Alternative to args: full argument string after "playwright" (for example "test --headed").',
        },
      },
      required: [],
    },
  },
};

const playwrightCliSkill = {
  ...manifest,
  execute: async (args: Record<string, unknown>) => executeSkillApi('playwright_cli', args),
};

export default playwrightCliSkill;
