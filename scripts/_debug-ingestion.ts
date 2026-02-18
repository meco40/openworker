/**
 * Minimal debug script — ingest ONE window and print full stack trace on error.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { loadEnvConfig } = require('@next/env') as {
  loadEnvConfig: (dir: string, dev?: boolean) => unknown;
};
loadEnvConfig(process.cwd());

import {
  getKnowledgeIngestionService,
  getKnowledgeIngestionCursor,
} from '../src/server/knowledge/runtime';

async function main(): Promise<void> {
  console.log('[debug] Creating service...');
  const cursor = getKnowledgeIngestionCursor();
  const service = getKnowledgeIngestionService();
  console.log('[debug] Service created OK');

  const windows = cursor.getPendingWindows(1);
  console.log(`[debug] Found ${windows.length} windows`);
  if (windows.length === 0) {
    console.log('[debug] No pending windows');
    return;
  }

  const w = windows[0];
  console.log(
    `[debug] First window: seq=${w.fromSeqExclusive + 1}..${w.toSeqInclusive}, msgs=${w.messages.length}`,
  );
  console.log('[debug] Calling ingestConversationWindow...');

  try {
    await service.ingestConversationWindow({
      conversationId: w.conversationId,
      userId: w.userId,
      personaId: w.personaId,
      messages: w.messages,
    });
    console.log('[debug] SUCCESS');
  } catch (error: unknown) {
    console.error('[debug] FAILED:', (error as Error).message);
    console.error('[debug] STACK:', (error as Error).stack);
  }
}

main().catch((err) => {
  console.error('[debug] FATAL:', err);
  process.exit(1);
});
