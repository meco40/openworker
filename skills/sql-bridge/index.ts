import type { SkillManifest } from '@/shared/toolSchema';
import { executeSkillApi } from '../runtime-client';

const manifest: SkillManifest = {
  id: 'sql-bridge',
  name: 'SQL Bridge',
  description: 'Sicherer Read/Write Zugriff auf SQL-Datenbanken.',
  version: '2.0.1',
  category: 'Data',
  functionName: 'db_query',
  tool: {
    name: 'db_query',
    description: 'Execute a read-only SQL query against the connected database.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Valid SQL SELECT statement.' },
      },
      required: ['query'],
    },
  },
};

const sqlBridgeSkill = {
  ...manifest,
  execute: async (args: Record<string, unknown>) => executeSkillApi('db_query', args),
};

export default sqlBridgeSkill;
