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

export class OrchestraService {
  validateGraphForUser(userId: string, graphLike: unknown): OrchestraValidationResult {
    if (!graphLike || typeof graphLike !== 'object') {
      return { ok: false, error: 'Graph must be an object with nodes and edges.' };
    }

    const personas = getPersonaRepository().listPersonas(userId);
    const allowedPersonaIds = new Set(personas.map((persona) => persona.id));
    const result = validateOrchestraGraph(
      graphLike,
      allowedPersonaIds.size > 0
        ? {
            allowedPersonaIds,
          }
        : undefined,
    );

    if (!result.ok) {
      return { ok: false, error: result.errors[0]?.message || 'Invalid graph.' };
    }

    return { ok: true, graph: graphLike as OrchestraFlowGraph };
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
  ) {
    return getWorkerRepository().updateFlowDraft(id, userId, {
      name: updates.name,
      graphJson: updates.graph ? JSON.stringify(updates.graph) : undefined,
      workspaceType: updates.workspaceType,
    });
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
