/** `/api/skills/execute` parity (S11): route errors and skill activation. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, rustRequest, bestEffortRemoveDir } from '../harness.mjs';

export const name = 'skills';

const cases = [
  ['null body', null],
  ['missing name', {}],
  ['inactive built-in', { name: 'github_query' }],
  ['active handler validation', { name: 'python_execute', args: {} }],
  ['invalid JSON arguments', { name: 'python_execute', args: 'not-json' }],
];

async function typescriptSide() {
  const dir = mkdtempSync(join(tmpdir(), 'betaclaw-parity-skills-'));
  const names = [
    'NODE_ENV',
    'REQUIRE_AUTH',
    'SKILLS_DB_PATH',
    'PRINCIPAL_USER_ID',
    'BETACLAW_EXEC_APPROVALS_REQUIRED',
  ];
  const previous = new Map(names.map((key) => [key, process.env[key]]));
  process.env.NODE_ENV = 'development';
  process.env.REQUIRE_AUTH = 'false';
  process.env.SKILLS_DB_PATH = join(dir, 'skills.db');
  process.env.PRINCIPAL_USER_ID = 'parity-skills-user';
  process.env.BETACLAW_EXEC_APPROVALS_REQUIRED = 'false';

  let repository;
  try {
    const { POST } = await import('../../../../app/api/skills/execute/route.ts');
    const { getSkillRepository } = await import('../../../../src/server/skills/skillRepository.ts');
    repository = await getSkillRepository();
    const replies = [];
    for (const [, body] of cases) {
      const response = await POST(
        new Request('http://localhost/api/skills/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
      replies.push({ status: response.status, body: await response.json() });
    }
    return replies;
  } finally {
    repository?.close();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    bestEffortRemoveDir(dir);
  }
}

async function rustSide() {
  const replies = [];
  for (const [, body] of cases) {
    const response = await rustRequest('POST', '/api/skills/execute', { body });
    replies.push({ status: response.status, body: response.json });
  }
  return replies;
}

export async function run() {
  const [ts, rust] = await Promise.all([typescriptSide(), rustSide()]);
  for (let index = 0; index < cases.length; index += 1) {
    check(cases[index][0], rust[index], ts[index]);
  }
}
