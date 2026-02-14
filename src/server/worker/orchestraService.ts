import type { WorkspaceType } from './workspaceManager';
import { getWorkerRepository } from './workerRepository';
import { getPersonaRepository } from '../personas/personaRepository';
import type { OrchestraFlowGraph } from './orchestraGraph';
import { validateOrchestraGraph } from './orchestraValidator';

export interface OrchestraValidationFailure {
  ok: false;
  error: string;
}

export interface OrchestraValidationSuccess {
  ok: true;
  graph: OrchestraFlowGraph;
}

export type OrchestraValidationResult = OrchestraValidationFailure | OrchestraValidationSuccess;

function normalizeDefaultPersonaPlaceholder(
  graphLike: unknown,
  fallbackPersonaId: string | null,
): unknown {
  if (!fallbackPersonaId || !graphLike || typeof graphLike !== 'object') {
    return graphLike;
  }

  const graph = graphLike as { nodes?: unknown };
  if (!Array.isArray(graph.nodes)) {
    return graphLike;
  }

  const normalizedNodes = graph.nodes.map((node) => {
    if (!node || typeof node !== 'object') return node;
    const nodeObj = node as Record<string, unknown>;
    const personaId = typeof nodeObj.personaId === 'string' ? nodeObj.personaId.trim() : '';
    if (personaId !== 'persona-default') {
      return nodeObj;
    }
    return { ...nodeObj, personaId: fallbackPersonaId };
  });

  return {
    ...(graphLike as Record<string, unknown>),
    nodes: normalizedNodes,
  };
}

export class OrchestraService {
  validateGraphForUser(userId: string, graphLike: unknown): OrchestraValidationResult {
    if (!graphLike || typeof graphLike !== 'object') {
      return { ok: false, error: 'Graph must be an object with nodes and edges.' };
    }

    const personas = getPersonaRepository().listPersonas(userId);
    const normalizedGraph = normalizeDefaultPersonaPlaceholder(graphLike, personas[0]?.id || null);
    const allowedPersonaIds = new Set(personas.map((persona) => persona.id));

    // Skill validation is deferred — getSkillRepository is async, but validation is sync.
    // We skip live skill checking here; the canvas UI loads skills separately.
    const allowedSkillIds: Set<string> | undefined = undefined;

    const result = validateOrchestraGraph(
      normalizedGraph,
      allowedPersonaIds.size > 0 || allowedSkillIds
        ? {
            allowedPersonaIds: allowedPersonaIds.size > 0 ? allowedPersonaIds : undefined,
            allowedSkillIds,
          }
        : undefined,
    );

    if (!result.ok) {
      return { ok: false, error: result.errors[0]?.message || 'Invalid graph.' };
    }

    return { ok: true, graph: normalizedGraph as OrchestraFlowGraph };
  }

  createDraft(input: {
    userId: string;
    workspaceType: WorkspaceType;
    name: string;
    graph: OrchestraFlowGraph;
    templateId?: string | null;
  }) {
    return getWorkerRepository().createFlowDraft({
      userId: input.userId,
      workspaceType: input.workspaceType,
      name: input.name,
      graphJson: JSON.stringify(input.graph),
      templateId: input.templateId ?? null,
    });
  }

  updateDraft(
    id: string,
    userId: string,
    updates: { name?: string; graph?: OrchestraFlowGraph; workspaceType?: WorkspaceType },
    expectedUpdatedAt?: string,
  ) {
    return getWorkerRepository().updateFlowDraft(id, userId, {
      name: updates.name,
      graphJson: updates.graph ? JSON.stringify(updates.graph) : undefined,
      workspaceType: updates.workspaceType,
    }, expectedUpdatedAt);
  }

  publishDraft(id: string, userId: string) {
    return getWorkerRepository().publishFlowDraft(id, userId);
  }
}

let instance: OrchestraService | null = null;

export function getOrchestraService(): OrchestraService {
  if (!instance) {
    instance = new OrchestraService();
  }
  return instance;
}
