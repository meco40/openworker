import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stopExternalSkillHost } from '@/server/skills/externalSkillHost';

const listSkillsMock = vi.hoisted(() => vi.fn());

vi.mock('@/server/skills/skillRepository', () => ({
  getSkillRepository: vi.fn(async () => ({
    listSkills: listSkillsMock,
  })),
}));

import { dispatchSkill } from '@/server/skills/executeSkill';

describe('dispatchSkill external handlers', () => {
  const tempDir = path.join(process.cwd(), '.local', 'test');
  let handlerPath = '';

  beforeEach(() => {
    listSkillsMock.mockReset();
    fs.mkdirSync(tempDir, { recursive: true });
    handlerPath = path.join(tempDir, `external-skill-${Date.now()}.mjs`);
    fs.writeFileSync(
      handlerPath,
      [
        'export async function handler(args, context) {',
        '  return {',
        '    echoed: args.value || null,',
        '    conversationId: context?.conversationId || null,',
        '    userId: context?.userId || null,',
        '  };',
        '}',
      ].join('\n'),
      'utf-8',
    );
  });

  afterEach(() => {
    stopExternalSkillHost();
    if (handlerPath && fs.existsSync(handlerPath)) {
      fs.rmSync(handlerPath, { force: true });
    }
  });

  it('loads and executes an installed external handler by function name', async () => {
    const relativeHandlerPath = path.relative(process.cwd(), handlerPath);
    listSkillsMock.mockReturnValue([
      {
        id: 'external-skill',
        name: 'External Skill',
        description: 'External dispatch test skill',
        category: 'Testing',
        version: '1.0.0',
        installed: true,
        functionName: 'external_echo',
        source: 'github',
        sourceUrl: 'https://example.com/skill',
        toolDefinition: {
          name: 'external_echo',
          description: 'Echoes a value',
          parameters: { type: 'object', properties: {} },
        },
        handlerPath: relativeHandlerPath,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);

    const result = (await dispatchSkill(
      'external_echo',
      { value: 'hello-external' },
      { conversationId: 'conv-1', userId: 'user-1' },
    )) as { echoed: string; conversationId: string; userId: string };

    expect(result.echoed).toBe('hello-external');
    expect(result.conversationId).toBe('conv-1');
    expect(result.userId).toBe('user-1');
  });
});
