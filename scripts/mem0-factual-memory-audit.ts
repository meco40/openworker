#!/usr/bin/env node
/**
 * Mem0 factual-memory audit.
 *
 * A local Mem0 deployment exposes an authenticated admin inventory endpoint
 * for this audit. External providers without that endpoint remain explicitly
 * limited to known application scopes.
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require('@next/env') as {
  loadEnvConfig: (dir: string, dev?: boolean) => unknown;
};
loadEnvConfig(process.cwd());

interface AuditOptions {
  dryRun: boolean;
  scope?: string;
  migrate: boolean;
  limit: number;
  output?: string;
}

interface AuditScope {
  userId: string;
  personaId: string;
  workspaceId: string;
}

interface ScopeAuditResult {
  scope: AuditScope;
  totalMemories: number;
  preferences: number;
  factual: number;
  personalityTraits: number;
  workflowPatterns: number;
  avoidances: number;
  lessons: number;
  uncategorized: number;
  migratedCount: number;
  errors: string[];
  migratedIds: string[];
}

interface ProviderMemory {
  id: string;
  payload: Record<string, unknown>;
}

interface ProviderWideAudit {
  endpoint: string;
  providerWideListSupported: boolean;
  recordsAvailable: number;
  recordsAudited: number;
  scopes: number;
  preferences: number;
  factual: number;
  personalityTraits: number;
  workflowPatterns: number;
  avoidances: number;
  lessons: number;
  uncategorized: number;
  errors: string[];
}

interface AuditReport {
  generatedAt: string;
  evidenceClass: 'mem0-known-scope-inventory' | 'mem0-provider-wide-inventory';
  provider: string;
  requestedScope: string;
  coverage: {
    knownApplicationScopes: number;
    auditedScopes: number;
    providerWideListSupported: boolean;
    limitation: string;
  };
  providerWide: ProviderWideAudit;
  scopes: ScopeAuditResult[];
  totals: Omit<ScopeAuditResult, 'scope' | 'errors' | 'migratedIds'> & { errors: number };
}

const PREFERENCE_PATTERNS = [
  /\b(prefer|prefers|like|likes|love|loves|enjoy|enjoys|favorite|favourite)\b/i,
  /\b(mag|möchte|mochte|liebe|liebt|liebte|bevorzug|bevorzugt|gern|gerne)\b/i,
];
const PERSONALITY_PATTERNS = [
  /\b(bin|ist|war|bist)\s+(ein|eine|eher|sehr|ziemlich|immer|oft|meistens)\b/i,
  /\b(is|am|are|was|were)\s+(a|an|very|quite|always|often|usually|typically)\b/i,
];
const WORKFLOW_PATTERNS = [
  /\b(workflow|prozess|process|routine|ablauf|vorgehen|vorgehensweise)\b/i,
  /\b(immer wenn|jedes mal|every time|whenever|usually|normalerweise|typischerweise)\b/i,
];
const AVOIDANCE_PATTERNS = [
  /\b(vermeide|vermeidet|avoid|avoids|hasse|hasst|hate|hates|nicht|don't|doesn't)\b/i,
];
const FACTUAL_PATTERNS = [
  /\b(war|hatte|ging|traf|besuchte|kaufte|verkaufte|arbeitete|wohnte|lebte)\b/i,
  /\b(was|had|went|met|visited|bought|sold|worked|lived|stayed)\b/i,
  /\b(ereignis|event|termin|appointment|meeting|treffen|datum|date|uhrzeit|time)\b/i,
  /\b(ergebnis|result|entscheidung|decision|beschluss|vereinbarung|agreement)\b/i,
  /\b(gestern|yesterday|letzte woche|last week|letzten monat|last month|vor)\b/i,
];

function parseArgs(): AuditOptions {
  const args = process.argv.slice(2);
  const options: AuditOptions = { dryRun: false, migrate: false, limit: 1000 };
  for (let i = 0; i < args.length; i += 1) {
    switch (args[i]) {
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--scope':
        options.scope = args[++i];
        break;
      case '--migrate':
        options.migrate = true;
        break;
      case '--limit':
        options.limit = Number(args[++i]) || 1000;
        break;
      case '--output':
        options.output = args[++i];
        break;
    }
  }
  return options;
}

function parseScope(value: string): AuditScope {
  const parts = value.split(':');
  const userId = parts[0] ?? '';
  const personaId = parts[1] ?? '';
  const workspaceId = parts.slice(2).join(':');
  if (
    parts.length < 3 ||
    !/^[A-Za-z0-9._-]+$/.test(userId) ||
    !/^[A-Za-z0-9._-]+$/.test(personaId) ||
    !(workspaceId === '' || /^[A-Za-z0-9._:-]+$/.test(workspaceId))
  ) {
    throw new Error('--scope must be userId:personaId:workspaceId or all');
  }
  return { userId, personaId, workspaceId };
}

function scopeKey(scope: AuditScope): string {
  return `${scope.userId}\u0000${scope.personaId}\u0000${scope.workspaceId ?? ''}`;
}

function classifyMemory(content: string, type?: string): string {
  const text = content.trim();
  if (type) {
    const normalized = type.toLowerCase();
    if (normalized === 'preference') return 'preference';
    if (normalized === 'avoidance') return 'avoidance';
    if (normalized === 'personality_trait') return 'personality_trait';
    if (normalized === 'workflow_pattern') return 'workflow_pattern';
    if (normalized === 'lesson') return 'lesson';
    if (normalized === 'fact') return 'factual';
  }
  if (PREFERENCE_PATTERNS.some((pattern) => pattern.test(text))) return 'preference';
  if (PERSONALITY_PATTERNS.some((pattern) => pattern.test(text))) return 'personality_trait';
  if (WORKFLOW_PATTERNS.some((pattern) => pattern.test(text))) return 'workflow_pattern';
  if (AVOIDANCE_PATTERNS.some((pattern) => pattern.test(text))) return 'avoidance';
  if (FACTUAL_PATTERNS.some((pattern) => pattern.test(text))) return 'factual';
  return 'uncategorized';
}

function addScope(scopes: Map<string, AuditScope>, scope: AuditScope): void {
  const key = scopeKey(scope);
  if (!scopes.has(key)) scopes.set(key, scope);
}

function providerPayloadMemory(item: ProviderMemory): {
  scope: AuditScope;
  content: string;
  type?: string;
} | null {
  const payload = item.payload || {};
  const nestedMetadata =
    payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
      ? (payload.metadata as Record<string, unknown>)
      : {};
  const content = String(
    payload.memory ?? payload.data ?? payload.content ?? payload.text ?? '',
  ).trim();
  const userId = String(payload.user_id ?? payload.userId ?? '').trim();
  const personaId = String(payload.agent_id ?? payload.agentId ?? payload.run_id ?? '').trim();
  const workspaceId = String(
    nestedMetadata.workspaceId ?? payload.workspace_id ?? payload.workspaceId ?? '',
  ).trim();
  if (!content || !userId || !personaId) return null;
  return {
    scope: { userId, personaId, workspaceId },
    content,
    type: String(nestedMetadata.type ?? payload.type ?? '').trim() || undefined,
  };
}

async function fetchProviderWideInventory(): Promise<{
  endpoint: string;
  supported: boolean;
  records: ProviderMemory[];
  errors: string[];
}> {
  const baseUrl = String(process.env.MEM0_BASE_URL || '')
    .trim()
    .replace(/\/+$/, '');
  const apiKey = String(process.env.MEM0_API_KEY || '').trim();
  const endpoint = `${baseUrl.replace(/\/v1$/i, '')}/admin/memories`;
  if (!baseUrl || !apiKey) {
    return {
      endpoint,
      supported: false,
      records: [],
      errors: ['MEM0_BASE_URL or MEM0_API_KEY is missing.'],
    };
  }
  const records: ProviderMemory[] = [];
  const pageSize = 500;
  let page = 1;
  try {
    while (true) {
      const response = await fetch(`${endpoint}?page=${page}&page_size=${pageSize}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (response.status === 403 || response.status === 404) {
        return {
          endpoint,
          supported: false,
          records: [],
          errors: [`Provider-wide endpoint returned HTTP ${response.status}.`],
        };
      }
      if (!response.ok) throw new Error(`Provider-wide endpoint returned HTTP ${response.status}.`);
      const body = (await response.json()) as {
        items?: unknown;
        total?: unknown;
        page?: unknown;
      };
      const items = Array.isArray(body.items)
        ? body.items.flatMap((item) => {
            if (!item || typeof item !== 'object') return [];
            const value = item as Record<string, unknown>;
            const payload = value.payload;
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
            return [{ id: String(value.id ?? ''), payload: payload as Record<string, unknown> }];
          })
        : [];
      records.push(...items);
      const total = Number(body.total ?? records.length);
      if (items.length === 0 || records.length >= total) break;
      page += 1;
    }
    return { endpoint, supported: true, records, errors: [] };
  } catch (error) {
    return {
      endpoint,
      supported: false,
      records,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

async function discoverKnownScopes(): Promise<AuditScope[]> {
  const scopes = new Map<string, AuditScope>();
  const messageDbPath = process.env.MESSAGES_DB_PATH || path.resolve('.local/messages.db');
  if (fs.existsSync(messageDbPath)) {
    const db = new Database(messageDbPath, { readonly: true });
    try {
      const rows = db
        .prepare('SELECT DISTINCT user_id, persona_id FROM conversations')
        .all() as Array<{ user_id: string; persona_id: string }>;
      for (const row of rows) {
        addScope(scopes, { userId: row.user_id, personaId: row.persona_id, workspaceId: '' });
      }
    } finally {
      db.close();
    }
  }

  try {
    const { runWorldModelMigrations, getWorldModelDb } = await import('@/server/world-model/db');
    await runWorldModelMigrations();
    const db = getWorldModelDb();
    const rows = await db.query<{ user_id: string; persona_id: string; workspace_id: string }>(
      `SELECT DISTINCT user_id, persona_id, workspace_id FROM world_model_observations
       UNION SELECT DISTINCT user_id, persona_id, workspace_id FROM world_model_entities
       UNION SELECT DISTINCT user_id, persona_id, workspace_id FROM world_model_tasks`,
    );
    for (const row of rows.rows) {
      addScope(scopes, {
        userId: row.user_id,
        personaId: row.persona_id,
        workspaceId: row.workspace_id,
      });
    }
  } catch {
    // The audit still reports the known message scopes if PostgreSQL is down.
  }

  if (scopes.size === 0)
    addScope(scopes, { userId: 'default', personaId: 'default', workspaceId: '' });
  return [...scopes.values()];
}

function emptyScopeResult(scope: AuditScope): ScopeAuditResult {
  return {
    scope,
    totalMemories: 0,
    preferences: 0,
    factual: 0,
    personalityTraits: 0,
    workflowPatterns: 0,
    avoidances: 0,
    lessons: 0,
    uncategorized: 0,
    migratedCount: 0,
    errors: [],
    migratedIds: [],
  };
}

async function auditScope(options: AuditOptions, scope: AuditScope): Promise<ScopeAuditResult> {
  const result = emptyScopeResult(scope);
  try {
    const { getMemoryService } = await import('@/server/memory/runtime');
    const memoryService = getMemoryService();
    const memories: Awaited<ReturnType<typeof memoryService.listPage>>['nodes'] = [];
    let page = 1;
    let fetched = 0;
    while (fetched < options.limit && page <= 100) {
      const batch = await memoryService.listPage(
        scope.personaId,
        { page, pageSize: Math.min(200, options.limit), query: undefined, type: undefined },
        scope.userId,
      );
      memories.push(...batch.nodes);
      fetched += batch.nodes.length;
      if (batch.nodes.length === 0 || batch.pagination.total <= fetched) break;
      page += 1;
    }
    result.totalMemories = memories.length;

    let observationService:
      | typeof import('@/server/world-model/services/observationService').recordObservation
      | undefined;
    let db: ReturnType<typeof import('@/server/world-model/db').getWorldModelDb> | undefined;
    if (options.migrate && !options.dryRun) {
      const { getWorldModelConfig } = await import('@/server/world-model/config');
      const config = getWorldModelConfig();
      if (!config.enabled && !config.e2eEnabled) {
        result.errors.push('World Model is disabled; factual migration was not executed.');
        return result;
      }
      const { runWorldModelMigrations, getWorldModelDb } = await import('@/server/world-model/db');
      await runWorldModelMigrations();
      db = getWorldModelDb();
      observationService = (await import('@/server/world-model/services/observationService'))
        .recordObservation;
    }

    for (const node of memories.slice(0, options.limit)) {
      const classification = classifyMemory(node.content, node.type);
      if (classification === 'preference') result.preferences += 1;
      else if (classification === 'avoidance') result.avoidances += 1;
      else if (classification === 'personality_trait') result.personalityTraits += 1;
      else if (classification === 'workflow_pattern') result.workflowPatterns += 1;
      else if (classification === 'lesson') result.lessons += 1;
      else if (classification === 'factual') result.factual += 1;
      else result.uncategorized += 1;

      if (options.migrate && !options.dryRun && classification === 'factual') {
        try {
          const { runWithWorldModelScope } = await import('@/server/world-model/db');
          const { upsertEntity } =
            await import('@/server/world-model/repositories/entityRepository');
          const { insertAssertion } =
            await import('@/server/world-model/repositories/assertionRepository');
          await runWithWorldModelScope(scope, async () => {
            const observation = await observationService!({
              ...scope,
              sourceType: 'automation',
              sourceId: `mem0-audit:${node.id}`,
              occurredAt: new Date().toISOString(),
              payload: { content: node.content, originalType: node.type, mem0Id: node.id },
              sourceAuthority: 'mem0_audit',
            });
            const subject = await upsertEntity(
              {
                ...scope,
                canonicalName: 'Mem0 Factual Audit',
                category: 'concept',
                owner: 'shared',
                properties: { source: 'mem0', mem0Id: node.id },
              },
              db,
            );
            await insertAssertion(
              {
                ...scope,
                subjectId: subject.id,
                predicate: 'mem0_factual_audit',
                objectValue: node.content,
                modality: 'inferred',
                confidence: 0.6,
                sourceObservationId: observation.observation.id,
              },
              db,
            );
          });
          result.migratedCount += 1;
          result.migratedIds.push(node.id);
        } catch (error) {
          result.errors.push(
            `Migrate ${node.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  } catch (error) {
    result.errors.push(`Fatal: ${error instanceof Error ? error.message : String(error)}`);
  }
  return result;
}

async function runAudit(options: AuditOptions): Promise<AuditReport> {
  if (options.migrate && options.scope === 'all') {
    throw new Error('--migrate requires one explicit --scope; refusing an unbounded migration.');
  }
  const knownScopes =
    options.scope && options.scope !== 'all'
      ? [parseScope(options.scope)]
      : await discoverKnownScopes();
  const providerInventory = await fetchProviderWideInventory();
  const scopes = options.scope && options.scope !== 'all' ? knownScopes : knownScopes;
  const results: ScopeAuditResult[] = [];
  for (const scope of scopes) {
    console.log(`Auditing ${scope.userId}:${scope.personaId}:${scope.workspaceId}`);
    results.push(await auditScope(options, scope));
  }

  const providerScopes = new Map<string, AuditScope>();
  let providerRecordsAudited = 0;
  const providerClassification = {
    preferences: 0,
    factual: 0,
    personalityTraits: 0,
    workflowPatterns: 0,
    avoidances: 0,
    lessons: 0,
    uncategorized: 0,
  };
  for (const record of providerInventory.records) {
    const parsed = providerPayloadMemory(record);
    if (!parsed) continue;
    if (options.scope && options.scope !== 'all') {
      const requested = knownScopes[0];
      if (
        requested &&
        (parsed.scope.userId !== requested.userId ||
          parsed.scope.personaId !== requested.personaId ||
          parsed.scope.workspaceId !== requested.workspaceId)
      ) {
        continue;
      }
    }
    addScope(providerScopes, parsed.scope);
    providerRecordsAudited += 1;
    const classification = classifyMemory(parsed.content, parsed.type);
    if (classification === 'preference') providerClassification.preferences += 1;
    else if (classification === 'factual') providerClassification.factual += 1;
    else if (classification === 'personality_trait') providerClassification.personalityTraits += 1;
    else if (classification === 'workflow_pattern') providerClassification.workflowPatterns += 1;
    else if (classification === 'avoidance') providerClassification.avoidances += 1;
    else if (classification === 'lesson') providerClassification.lessons += 1;
    else providerClassification.uncategorized += 1;
  }

  const totals = results.reduce<AuditReport['totals']>(
    (total, result) => ({
      totalMemories: total.totalMemories + result.totalMemories,
      preferences: total.preferences + result.preferences,
      factual: total.factual + result.factual,
      personalityTraits: total.personalityTraits + result.personalityTraits,
      workflowPatterns: total.workflowPatterns + result.workflowPatterns,
      avoidances: total.avoidances + result.avoidances,
      lessons: total.lessons + result.lessons,
      uncategorized: total.uncategorized + result.uncategorized,
      migratedCount: total.migratedCount + result.migratedCount,
      errors: total.errors + result.errors.length,
    }),
    {
      totalMemories: 0,
      preferences: 0,
      factual: 0,
      personalityTraits: 0,
      workflowPatterns: 0,
      avoidances: 0,
      lessons: 0,
      uncategorized: 0,
      migratedCount: 0,
      errors: 0,
    },
  );
  return {
    generatedAt: new Date().toISOString(),
    evidenceClass: providerInventory.supported
      ? 'mem0-provider-wide-inventory'
      : 'mem0-known-scope-inventory',
    provider: process.env.MEMORY_PROVIDER || 'unknown',
    requestedScope: options.scope || 'all',
    coverage: {
      knownApplicationScopes: knownScopes.length,
      auditedScopes: results.length,
      providerWideListSupported: providerInventory.supported,
      limitation: providerInventory.supported
        ? 'Provider-wide local admin inventory was enumerated; migration remains explicit and scope-limited.'
        : 'Provider-wide inventory is unavailable; unknown scopes outside application inventory cannot be ruled out.',
    },
    providerWide: {
      endpoint: providerInventory.endpoint,
      providerWideListSupported: providerInventory.supported,
      recordsAvailable: providerInventory.records.length,
      recordsAudited: providerRecordsAudited,
      scopes: providerScopes.size,
      ...providerClassification,
      errors: providerInventory.errors,
    },
    scopes: results,
    totals,
  };
}

const options = parseArgs();
void runAudit(options)
  .then((report) => {
    console.log(JSON.stringify(report, null, 2));
    if (options.output) {
      fs.writeFileSync(options.output, JSON.stringify(report, null, 2));
      console.log(`Report written to ${options.output}`);
    }
    process.exit(report.totals.errors > 0 ? 1 : 0);
  })
  .catch((error) => {
    console.error(`Audit failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
