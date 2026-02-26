import type {
  ModelHubRepository,
  PipelineModelEntry,
  CreatePipelineModelInput,
} from '@/server/model-hub/repository';

export function listPipeline(
  repository: ModelHubRepository,
  profileId: string,
): PipelineModelEntry[] {
  return repository.listPipelineModels(profileId);
}

export function addModelToPipeline(
  repository: ModelHubRepository,
  input: CreatePipelineModelInput,
): PipelineModelEntry {
  return repository.addPipelineModel(input);
}

export function removeModelFromPipeline(repository: ModelHubRepository, modelId: string): boolean {
  return repository.removePipelineModel(modelId);
}

export function updateModelStatus(
  repository: ModelHubRepository,
  modelId: string,
  status: 'active' | 'rate-limited' | 'offline',
): void {
  repository.updatePipelineModelStatus(modelId, status);
}
