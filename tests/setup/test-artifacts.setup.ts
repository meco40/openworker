import fs from 'node:fs';
import { testArtifactsPath } from '../helpers/testArtifacts';

const DEFAULT_ENV_PATHS: Array<{ key: string; segments: string[] }> = [
  { key: 'MESSAGES_DB_PATH', segments: ['db', 'messages.test.db'] },
  { key: 'PERSONAS_DB_PATH', segments: ['db', 'personas.test.db'] },
  { key: 'STATS_DB_PATH', segments: ['db', 'stats.test.db'] },
  { key: 'AUTH_DB_PATH', segments: ['db', 'auth.test.db'] },
  { key: 'MODEL_HUB_DB_PATH', segments: ['db', 'model-hub.test.db'] },
  { key: 'SKILLS_DB_PATH', segments: ['db', 'skills.test.db'] },
  { key: 'CLAWHUB_DB_PATH', segments: ['db', 'clawhub.test.db'] },
  { key: 'LOGS_DB_PATH', segments: ['db', 'logs.test.db'] },
  { key: 'AUTOMATION_DB_PATH', segments: ['db', 'automation.test.db'] },
  { key: 'PROACTIVE_DB_PATH', segments: ['db', 'proactive.test.db'] },
  { key: 'MEMORY_DB_PATH', segments: ['db', 'memory.test.db'] },
  { key: 'KNOWLEDGE_DB_PATH', segments: ['db', 'knowledge.test.db'] },
  { key: 'MASTER_DB_PATH', segments: ['db', 'master.test.db'] },
  { key: 'OPENCLAW_CONFIG_PATH', segments: ['db', 'gateway-config.test.json'] },
  { key: 'PERSONAS_ROOT_PATH', segments: ['personas'] },
  { key: 'CHAT_ATTACHMENTS_DIR', segments: ['uploads', 'chat'] },
  { key: 'TASK_WORKSPACES_ROOT', segments: ['workspaces'] },
];

for (const entry of DEFAULT_ENV_PATHS) {
  const existing = String(process.env[entry.key] || '').trim();
  if (existing.length > 0) {
    continue;
  }

  const nextPath = testArtifactsPath(...entry.segments);
  process.env[entry.key] = nextPath;

  const shouldCreateDirectory = !entry.key.endsWith('_DB_PATH') && !entry.key.endsWith('_PATH');
  if (shouldCreateDirectory) {
    fs.mkdirSync(nextPath, { recursive: true });
  } else if (entry.key === 'PERSONAS_ROOT_PATH' || entry.key === 'CHAT_ATTACHMENTS_DIR') {
    fs.mkdirSync(nextPath, { recursive: true });
  } else {
    fs.mkdirSync(testArtifactsPath('db'), { recursive: true });
  }
}
