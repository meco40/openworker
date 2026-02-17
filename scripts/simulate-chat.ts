/**
 * Stress-test Simulation: User sends a message to persona Lea via the full pipeline.
 *
 * This script simulates the exact same flow as a real Telegram/WebChat message:
 * 1. Loads Lea's persona system prompt (SOUL.md + AGENTS.md + USER.md)
 * 2. Builds recall context (Knowledge Layer + Mem0 + Chat FTS5)
 * 3. Assembles the full message array as the LLM would see it
 * 4. Calls the Model Hub to generate a response
 * 5. Prints the full context and response for inspection
 *
 * Usage:
 *   npx tsx scripts/simulate-chat.ts "Welches Top hattest du an?"
 *   npx tsx scripts/simulate-chat.ts --persona Lea "Wie heißt mein Bruder?"
 *   npx tsx scripts/simulate-chat.ts --dry-run "Test query"   # show context only, no LLM call
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require('@next/env') as {
  loadEnvConfig: (dir: string, dev?: boolean) => unknown;
};
loadEnvConfig(process.cwd());

import BetterSqlite3 from 'better-sqlite3';
import fs from 'node:fs';
import { getKnowledgeRetrievalService } from '../src/server/knowledge/runtime';
import { resolveKnowledgeConfig } from '../src/server/knowledge/config';
import { getMemoryService } from '../src/server/memory/runtime';
import { getModelHubService, getModelHubEncryptionKey } from '../src/server/model-hub/runtime';
import { LEGACY_LOCAL_USER_ID } from '../src/server/auth/constants';

// ── Types ────────────────────────────────────────────────────

interface GatewayMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface CliOptions {
  dryRun: boolean;
  personaName: string;
  userMessage: string;
  historyCount: number;
}

// ── CLI Parsing ──────────────────────────────────────────────

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    dryRun: false,
    personaName: 'Lea',
    userMessage: '',
    historyCount: 20,
  };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--persona') {
      options.personaName = String(argv[i + 1] || '').trim();
      i++;
    } else if (arg === '--history') {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n > 0) options.historyCount = Math.floor(n);
      i++;
    } else {
      positional.push(arg);
    }
  }
  options.userMessage = positional.join(' ').trim();
  return options;
}

// ── Persona Loader ───────────────────────────────────────────

interface PersonaInfo {
  id: string;
  name: string;
  systemPrompt: string | null;
}

function loadPersona(name: string): PersonaInfo {
  const dbPath = process.env.PERSONAS_DB_PATH || '.local/personas.db';
  if (!fs.existsSync(dbPath)) throw new Error(`Personas DB not found: ${dbPath}`);

  const db = new BetterSqlite3(dbPath, { readonly: true });
  try {
    const row = db
      .prepare('SELECT id, name FROM personas WHERE LOWER(name) = LOWER(?)')
      .get(name) as { id: string; name: string } | undefined;
    if (!row) throw new Error(`Persona "${name}" not found in DB`);

    // Load instruction files
    const files = ['SOUL.md', 'AGENTS.md', 'USER.md'];
    const parts: string[] = [];
    for (const file of files) {
      const fileRow = db
        .prepare('SELECT content FROM persona_files WHERE persona_id = ? AND filename = ?')
        .get(row.id, file) as { content: string } | undefined;
      if (fileRow?.content) {
        parts.push(`--- ${file} ---\n${fileRow.content}`);
      }
    }
    return {
      id: row.id,
      name: row.name,
      systemPrompt: parts.length > 0 ? parts.join('\n\n') : null,
    };
  } finally {
    db.close();
  }
}

// ── Chat History Loader ──────────────────────────────────────

function loadRecentHistory(conversationId: string, limit: number): GatewayMessage[] {
  const dbPath = process.env.MESSAGES_DB_PATH || '.local/messages.db';
  const db = new BetterSqlite3(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT role, content FROM messages
         WHERE conversation_id = ?
         ORDER BY seq DESC LIMIT ?`,
      )
      .all(conversationId, limit) as Array<{ role: string; content: string }>;

    return rows.reverse().map((r) => ({
      role: mapHistoryRole(r.role),
      content: r.content,
    }));
  } finally {
    db.close();
  }
}

function mapHistoryRole(role: string): GatewayMessage['role'] {
  if (role === 'agent' || role === 'assistant') return 'assistant';
  if (role === 'system') return 'system';
  return 'user';
}

function findConversationForPersona(personaId: string): string | null {
  const dbPath = process.env.MESSAGES_DB_PATH || '.local/messages.db';
  const db = new BetterSqlite3(dbPath, { readonly: true });
  try {
    const row = db
      .prepare('SELECT id FROM conversations WHERE persona_id = ? ORDER BY updated_at DESC LIMIT 1')
      .get(personaId) as { id: string } | undefined;
    return row?.id ?? null;
  } finally {
    db.close();
  }
}

// ── Recall Context Builder ───────────────────────────────────

async function buildRecallContext(
  userId: string,
  personaId: string,
  conversationId: string,
  query: string,
): Promise<{ knowledge: string | null; memory: string | null }> {
  const config = resolveKnowledgeConfig();

  // Knowledge Layer
  let knowledge: string | null = null;
  if (config.layerEnabled && config.retrievalEnabled) {
    try {
      const service = getKnowledgeRetrievalService();
      const result = await service.retrieve({
        userId,
        personaId,
        conversationId,
        query,
      });
      knowledge = result.context || null;
    } catch (err) {
      console.warn('[sim] Knowledge retrieval failed:', err);
    }
  }

  // Mem0 Semantic Memory
  let memory: string | null = null;
  try {
    const memService = getMemoryService();
    const recalled = await memService.recallDetailed(personaId, query, 10, userId);
    if (recalled.context) {
      memory = recalled.context;
    }
  } catch (err) {
    console.warn('[sim] Memory recall failed:', err);
  }

  return { knowledge, memory };
}

// ── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (!options.userMessage) {
    console.error('Usage: npx tsx scripts/simulate-chat.ts "Dein Text hier"');
    process.exit(1);
  }

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  CHAT SIMULATION — Stress Test`);
  console.log(`${'═'.repeat(70)}`);

  // ── Load persona ───────────────────────────────────────────
  const persona = loadPersona(options.personaName);
  const conversationId = findConversationForPersona(persona.id);
  const userId = LEGACY_LOCAL_USER_ID;

  console.log(`\n  Persona:        ${persona.name} (${persona.id})`);
  console.log(`  Conversation:   ${conversationId || 'N/A'}`);
  console.log(`  User ID:        ${userId}`);
  console.log(`  User Message:   "${options.userMessage}"`);
  console.log(
    `  System Prompt:  ${persona.systemPrompt ? persona.systemPrompt.length + ' chars' : 'none'}`,
  );

  // ── Build recall context ───────────────────────────────────
  console.log(`\n${'─'.repeat(70)}`);
  console.log('  RECALL CONTEXT');
  console.log(`${'─'.repeat(70)}`);

  const recall = await buildRecallContext(
    userId,
    persona.id,
    conversationId || '',
    options.userMessage,
  );

  if (recall.knowledge) {
    console.log(`\n  [Knowledge Layer] (${recall.knowledge.length} chars):`);
    console.log(indent(recall.knowledge, '    '));
  } else {
    console.log('\n  [Knowledge Layer] — empty');
  }

  if (recall.memory) {
    console.log(`\n  [Mem0 Memory] (${recall.memory.length} chars):`);
    console.log(indent(recall.memory, '    '));
  } else {
    console.log('\n  [Mem0 Memory] — empty');
  }

  // ── Build message array ────────────────────────────────────
  const messages: GatewayMessage[] = [];

  // 1. Recall context as system message
  const contextParts: string[] = [];
  if (recall.knowledge) contextParts.push(`[Knowledge]\n${recall.knowledge}`);
  if (recall.memory) contextParts.push(`[Memory]\n${recall.memory}`);

  if (contextParts.length > 0) {
    messages.push({
      role: 'system',
      content: [
        'Relevant memory context (use this to ground your answers):',
        contextParts.join('\n\n'),
        '',
        'Interpretation rules:',
        '- Memories tagged "[Subject: user]" describe the user, not the assistant/persona.',
        '- Memories tagged "[Subject: assistant]" describe you (the persona).',
        '- Memories tagged "[Subject: assistant, Self-Reference]" contain statements you made about yourself.',
        '- When the user asks "Did you...?" and a memory says "I...", the answer is YES.',
        '- Never claim user preferences, habits, or facts as your own.',
      ].join('\n'),
    });
  }

  // 2. Persona system prompt
  if (persona.systemPrompt) {
    messages.push({ role: 'system', content: persona.systemPrompt });
  }

  // 3. Recent chat history
  if (conversationId) {
    const history = loadRecentHistory(conversationId, options.historyCount);
    messages.push(...history);
    console.log(`\n  [Chat History] ${history.length} messages loaded`);
  }

  // 4. Current user message
  messages.push({ role: 'user', content: options.userMessage });

  console.log(`\n  Total messages to LLM: ${messages.length}`);
  console.log(`  Total chars: ${messages.reduce((s, m) => s + m.content.length, 0)}`);

  if (options.dryRun) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log('  DRY RUN — Full message array:');
    console.log(`${'─'.repeat(70)}`);
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const preview = m.content.length > 200 ? m.content.slice(0, 200) + '...' : m.content;
      console.log(`\n  [${i}] role=${m.role} (${m.content.length} chars)`);
      console.log(indent(preview, '      '));
    }
    process.exit(0);
  }

  // ── Call LLM ───────────────────────────────────────────────
  console.log(`\n${'─'.repeat(70)}`);
  console.log('  LLM RESPONSE');
  console.log(`${'─'.repeat(70)}`);

  const hubService = getModelHubService();
  const encryptionKey = getModelHubEncryptionKey();

  const startTime = Date.now();
  const result = await hubService.dispatchWithFallback('p1', encryptionKey, {
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    auditContext: { kind: 'chat', conversationId: conversationId || 'sim' },
  });
  const elapsed = Date.now() - startTime;

  if (result.ok) {
    console.log(`\n  Provider: ${result.provider}`);
    console.log(`  Model:    ${result.model}`);
    console.log(`  Latency:  ${elapsed}ms`);
    if (result.usage) {
      console.log(
        `  Tokens:   in=${(result.usage as Record<string, number>).promptTokens || '?'} out=${(result.usage as Record<string, number>).completionTokens || '?'}`,
      );
    }
    console.log(`\n  ${'─'.repeat(60)}`);
    console.log(`  Lea's Antwort:`);
    console.log(`  ${'─'.repeat(60)}`);
    console.log(`\n${indent(result.text || '(empty)', '  ')}`);
  } else {
    console.error(`\n  ✗ LLM call failed: ${result.error}`);
    console.error(`    Provider: ${result.provider}, Model: ${result.model}`);
  }

  console.log(`\n${'═'.repeat(70)}\n`);
  process.exit(0);
}

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => prefix + line)
    .join('\n');
}

main().catch((error) => {
  console.error('[simulate-chat] Fatal:', error);
  process.exit(1);
});
