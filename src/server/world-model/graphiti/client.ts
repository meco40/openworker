import { createHash } from 'node:crypto';

/**
 * Phase 12: Graphiti REST client.
 *
 * Graphiti remains a derived projection. The client targets the official
 * graph-service contract (`/healthcheck`, `/messages`, `/entity-node`, and
 * `/group/{group_id}`); PostgreSQL remains the system of record.
 */

export interface GraphitiClientConfig {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  maxRetries: number;
}

export interface GraphitiNode {
  id: string;
  label: string;
  properties: Record<string, unknown>;
}

export interface GraphitiEdge {
  source: string;
  target: string;
  type: string;
  sourceLabel?: string;
  targetLabel?: string;
  properties?: Record<string, unknown>;
}

export interface GraphitiMessage {
  uuid?: string;
  name?: string;
  content: string;
  roleType?: 'user' | 'assistant' | 'system';
  role?: string | null;
  timestamp?: string;
  sourceDescription?: string;
}

export interface GraphitiHealthStatus {
  reachable: boolean;
  latencyMs: number;
  nodeCount?: number;
  edgeCount?: number;
  error?: string;
}

export interface GraphitiQueueStatus {
  pendingJobs: number;
  activeJobs: number;
  completedJobs: number;
  failedJobs: number;
  workers: number;
}

export interface GraphitiFact {
  uuid?: string;
  name?: string;
  fact: string;
  validAt?: string;
  invalidAt?: string;
  sourceNodeUuid?: string;
  targetNodeUuid?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 3;
const CIRCUIT_RESET_MS = 60_000;

let circuitOpen = false;
let circuitOpenSince: number | null = null;

function getClientConfig(): GraphitiClientConfig {
  return {
    baseUrl: (process.env.GRAPHITI_BASE_URL ?? 'http://localhost:8001').replace(/\/+$/, ''),
    apiKey: process.env.GRAPHITI_API_KEY,
    timeoutMs: Number(process.env.GRAPHITI_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    maxRetries: Math.max(1, Number(process.env.GRAPHITI_MAX_RETRIES) || DEFAULT_MAX_RETRIES),
  };
}

function checkCircuit(): void {
  if (circuitOpen && circuitOpenSince && Date.now() - circuitOpenSince > CIRCUIT_RESET_MS) {
    circuitOpen = false;
    circuitOpenSince = null;
    console.log('[world-model:graphiti] circuit breaker reset');
  }
  if (circuitOpen) throw new Error('[world-model:graphiti] circuit breaker open');
}

function tripCircuit(): void {
  circuitOpen = true;
  circuitOpenSince = Date.now();
  console.warn('[world-model:graphiti] circuit breaker tripped');
}

function resetCircuitAfterSuccess(): void {
  circuitOpen = false;
  circuitOpenSince = null;
}

/**
 * Graphiti group IDs are transport identifiers, not arbitrary application
 * scopes. Keep the original scope in PostgreSQL and use a deterministic,
 * provider-safe identifier for the derived projection.
 */
export function graphitiGroupId(userId: string, personaId: string, workspaceId: string): string {
  const canonicalScope = `${userId}\u0000${personaId}\u0000${workspaceId}`;
  return `openclaw-${createHash('sha256').update(canonicalScope, 'utf8').digest('hex').slice(0, 32)}`;
}

function buildHeaders(config: GraphitiClientConfig): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
  };
}

async function requestGraphiti<T>(
  config: GraphitiClientConfig,
  path: string,
  init: RequestInit = {},
): Promise<{ response: Response; body: T }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const headers = new Headers(buildHeaders(config));
    if (init.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    }
    const response = await fetch(`${config.baseUrl}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => ({}))) as T;
    if (!response.ok) {
      throw new Error(
        `Graphiti request failed: HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
      );
    }
    return { response, body };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Graphiti request timeout after ${config.timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function withRetries<T>(label: string, operation: () => Promise<T>): Promise<T> {
  const config = getClientConfig();
  checkCircuit();
  let lastError: unknown;

  for (let attempt = 1; attempt <= config.maxRetries; attempt += 1) {
    try {
      const result = await operation();
      resetCircuitAfterSuccess();
      return result;
    } catch (error) {
      lastError = error;
      if (attempt >= config.maxRetries) break;
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }

  tripCircuit();
  throw new Error(
    `${label} failed after ${config.maxRetries} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

function toGraphitiMessage(message: GraphitiMessage): Record<string, unknown> {
  return {
    ...(message.uuid ? { uuid: message.uuid } : {}),
    name: message.name ?? '',
    content: message.content,
    role_type: message.roleType ?? 'system',
    role: message.role ?? null,
    timestamp: message.timestamp ?? new Date().toISOString(),
    source_description: message.sourceDescription ?? 'OpenClaw World Model',
  };
}

function deduplicateGraphitiMessages(messages: GraphitiMessage[]): GraphitiMessage[] {
  const seen = new Set<string>();
  return messages.filter((message) => {
    const key = message.uuid
      ? `uuid:${message.uuid}`
      : `content:${message.name ?? ''}\u0000${message.content}\u0000${message.timestamp ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Executes the official Graphiti REST message ingestion endpoint. */
export async function addGraphitiMessages(
  groupId: string,
  messages: GraphitiMessage[],
): Promise<{ accepted: number }> {
  if (!groupId || messages.length === 0) return { accepted: 0 };
  const uniqueMessages = deduplicateGraphitiMessages(messages);
  if (uniqueMessages.length === 0) return { accepted: 0 };
  const config = getClientConfig();
  return withRetries('Graphiti message ingestion', async () => {
    const { response } = await requestGraphiti<{ success?: boolean }>(config, '/messages', {
      method: 'POST',
      body: JSON.stringify({
        group_id: groupId,
        messages: uniqueMessages.map(toGraphitiMessage),
      }),
    });
    return { accepted: uniqueMessages.length };
  });
}

/** Executes the official Graphiti fact-search endpoint for one safe group. */
export async function searchGraphitiFacts(
  groupId: string,
  query: string,
  maxFacts = 10,
): Promise<GraphitiFact[]> {
  if (!groupId || !query.trim()) return [];
  const config = getClientConfig();
  return withRetries('Graphiti fact search', async () => {
    const { body } = await requestGraphiti<unknown>(config, '/search', {
      method: 'POST',
      body: JSON.stringify({
        group_ids: [groupId],
        query,
        max_facts: Math.max(1, Math.min(100, Math.floor(maxFacts))),
      }),
    });
    const candidate = body && typeof body === 'object' ? body : {};
    const facts = Array.isArray(candidate)
      ? candidate
      : Array.isArray((candidate as { facts?: unknown[] }).facts)
        ? (candidate as { facts: unknown[] }).facts
        : [];
    return facts.flatMap((value) => {
      if (!value || typeof value !== 'object') return [];
      const fact = String((value as { fact?: unknown }).fact ?? '').trim();
      if (!fact) return [];
      const item = value as Record<string, unknown>;
      return [
        {
          uuid: typeof item.uuid === 'string' ? item.uuid : undefined,
          name: typeof item.name === 'string' ? item.name : undefined,
          fact,
          validAt: typeof item.valid_at === 'string' ? item.valid_at : undefined,
          invalidAt: typeof item.invalid_at === 'string' ? item.invalid_at : undefined,
          sourceNodeUuid:
            typeof item.source_node_uuid === 'string' ? item.source_node_uuid : undefined,
          targetNodeUuid:
            typeof item.target_node_uuid === 'string' ? item.target_node_uuid : undefined,
        },
      ];
    });
  });
}

/** Performs the official Graphiti REST health check. */
export async function checkGraphitiHealth(): Promise<GraphitiHealthStatus> {
  const config = getClientConfig();
  const startedAt = Date.now();
  try {
    checkCircuit();
    await requestGraphiti<Record<string, unknown>>(config, '/healthcheck');
    resetCircuitAfterSuccess();
    return { reachable: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return {
      reachable: false,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Returns the patched ingest queue status for rebuild completion checks. */
export async function getGraphitiQueueStatus(): Promise<GraphitiQueueStatus> {
  const config = getClientConfig();
  return withRetries('Graphiti queue status', async () => {
    const { body } = await requestGraphiti<{
      pending_jobs?: unknown;
      active_jobs?: unknown;
      completed_jobs?: unknown;
      failed_jobs?: unknown;
      workers?: unknown;
    }>(config, '/queue-status');
    return {
      pendingJobs: Number(body.pending_jobs ?? 0),
      activeJobs: Number(body.active_jobs ?? 0),
      completedJobs: Number(body.completed_jobs ?? 0),
      failedJobs: Number(body.failed_jobs ?? 0),
      workers: Number(body.workers ?? 0),
    };
  });
}

export async function waitForGraphitiQueue(
  input: {
    timeoutMs?: number;
    pollMs?: number;
    baselineFailedJobs?: number;
  } = {},
): Promise<GraphitiQueueStatus> {
  const timeoutMs = Math.max(
    10_000,
    Number(input.timeoutMs ?? process.env.GRAPHITI_QUEUE_DRAIN_TIMEOUT_MS) || 600_000,
  );
  const pollMs = Math.max(250, Number(input.pollMs) || 1_000);
  const startedAt = Date.now();
  const initial = await getGraphitiQueueStatus();
  const baselineFailedJobs = input.baselineFailedJobs ?? initial.failedJobs;
  while (Date.now() - startedAt <= timeoutMs) {
    const status = await getGraphitiQueueStatus();
    if (status.pendingJobs === 0 && status.activeJobs === 0) {
      if (status.failedJobs > baselineFailedJobs) {
        throw new Error(
          `Graphiti queue drained with ${status.failedJobs - baselineFailedJobs} failed job(s).`,
        );
      }
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Graphiti queue did not drain within ${timeoutMs}ms.`);
}

/** Upserts entity nodes through the official Graphiti REST endpoint. */
export async function upsertGraphitiNodes(
  nodes: GraphitiNode[],
): Promise<{ created: number; updated: number }> {
  const config = getClientConfig();
  let created = 0;
  for (const node of nodes) {
    await withRetries(`Graphiti node ${node.id}`, async () => {
      const groupId = String(node.properties.segment ?? 'openclaw');
      await requestGraphiti(config, '/entity-node', {
        method: 'POST',
        body: JSON.stringify({
          uuid: node.id,
          group_id: groupId,
          name: node.label,
          summary: String(node.properties.summary ?? node.properties.text ?? node.label),
        }),
      });
    });
    created += 1;
  }
  return { created, updated: 0 };
}

/**
 * Graphiti's REST service does not expose a raw edge-upsert route. Represent
 * an explicit relation as a deterministic message so Graphiti extracts and
 * stores the temporal edge using its supported ingestion path.
 */
export async function upsertGraphitiEdges(
  edges: GraphitiEdge[],
): Promise<{ created: number; updated: number }> {
  const messages = edges.map((edge) => ({
    uuid: `edge:${createHash('sha256')
      .update(`${edge.source}\u0000${edge.type}\u0000${edge.target}`, 'utf8')
      .digest('hex')
      .slice(0, 32)}`,
    name: edge.type,
    content: buildRelationEpisodeContent(edge),
    roleType: 'system' as const,
    sourceDescription: `OpenClaw World Model relation projection (${edge.type})`,
  }));
  const groupId = String(edges[0]?.properties?.segment ?? 'openclaw');
  const result = await addGraphitiMessages(groupId, messages);
  return { created: result.accepted, updated: 0 };
}

function humanizeRelationType(value: string): string {
  return value
    .trim()
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('en-US');
}

function buildRelationEpisodeContent(edge: GraphitiEdge): string {
  const source = edge.sourceLabel?.trim() || edge.source;
  const target = edge.targetLabel?.trim() || edge.target;
  const relation = humanizeRelationType(edge.type);
  const phrase = relation.startsWith('responsible ')
    ? `is ${relation}`
    : relation.startsWith('is ') ||
        relation.startsWith('has ') ||
        relation.startsWith('can ') ||
        relation.startsWith('works ') ||
        relation.startsWith('lives ') ||
        relation.startsWith('located ') ||
        relation.startsWith('likes ') ||
        relation.startsWith('knows ') ||
        relation.startsWith('manages ') ||
        relation.startsWith('uses ') ||
        relation.startsWith('prefers ')
      ? relation
      : `has relation "${relation}" to`;
  const metadata = edge.properties
    ? Object.entries(edge.properties)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => `${key}=${String(value)}`)
        .join('; ')
    : '';
  return `"${source}" ${phrase} "${target}".${metadata ? ` Structured metadata: ${metadata}.` : ''}`;
}

/** Deletes all Graphiti data for one World-Model scope/group. */
export async function clearGraphitiScope(
  userId: string,
  personaId: string,
  workspaceId: string,
): Promise<void> {
  const config = getClientConfig();
  const groupId = graphitiGroupId(userId, personaId, workspaceId);
  await withRetries(`Graphiti group ${groupId} deletion`, async () => {
    await requestGraphiti(config, `/group/${encodeURIComponent(groupId)}`, {
      method: 'DELETE',
    });
  });
}

export function resetGraphitiCircuit(): void {
  resetCircuitAfterSuccess();
}
