/**
 * Debug script: runs a single ingestion window with full error tracing.
 */
import {
  getKnowledgeIngestionCursor,
  getKnowledgeIngestionService,
} from '@/server/knowledge/runtime';

async function main() {
  const cursor = getKnowledgeIngestionCursor();
  const windows = cursor.getPendingWindows(200);
  const leaWindows = windows.filter((w) => w.personaId === '48979798-6783-4ae2-895b-1d0222b2af26');

  console.log(`Found ${leaWindows.length} windows`);
  if (leaWindows.length === 0) {
    console.log('No windows to process');
    process.exit(0);
  }

  const service = getKnowledgeIngestionService();
  const w = leaWindows[0];
  console.log(
    `Processing window: seq=${w.fromSeqExclusive + 1}..${w.toSeqInclusive} (${w.messages.length} msgs)`,
  );

  try {
    await service.ingestConversationWindow({
      conversationId: w.conversationId,
      userId: w.userId,
      personaId: w.personaId,
      messages: w.messages,
    });
    cursor.markWindowProcessed(w);
    console.log('✓ Window completed');
  } catch (error) {
    console.error('✗ Window FAILED:');
    console.error(error);
    if (error instanceof Error) {
      console.error('Stack:', error.stack);
    }
  }
}

process.on('uncaughtException', (error) => {
  console.error('UNCAUGHT EXCEPTION:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
  process.exit(1);
});

main().catch((error) => {
  console.error('Main catch:', error);
  process.exit(1);
});
