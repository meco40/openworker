import type { OrchestraFlowGraph } from './orchestraGraph';

const EDITOR_ROLES = new Set(['admin', 'dev']);
const PUBLISHER_ROLES = new Set(['admin', 'dev']);

export function normalizeWorkerRole(role: string | null | undefined): string {
  return String(role || 'dev').trim().toLowerCase();
}

export function canEditOrchestra(role: string | null | undefined): boolean {
  return EDITOR_ROLES.has(normalizeWorkerRole(role));
}

export function canPublishOrchestra(role: string | null | undefined): boolean {
  return PUBLISHER_ROLES.has(normalizeWorkerRole(role));
}

export function enforceOrchestraGraphLimits(
  graph: OrchestraFlowGraph,
  limits?: { maxNodes?: number; maxEdges?: number },
): { ok: true } | { ok: false; error: string } {
  const maxNodes = limits?.maxNodes ?? Number(process.env.WORKER_ORCHESTRA_MAX_NODES || 64);
  const maxEdges = limits?.maxEdges ?? Number(process.env.WORKER_ORCHESTRA_MAX_EDGES || 128);

  if (graph.nodes.length > maxNodes) {
    return {
      ok: false,
      error: `Graph exceeds node limit (${graph.nodes.length}/${maxNodes}).`,
    };
  }
  if (graph.edges.length > maxEdges) {
    return {
      ok: false,
      error: `Graph exceeds edge limit (${graph.edges.length}/${maxEdges}).`,
    };
  }
  return { ok: true };
}
