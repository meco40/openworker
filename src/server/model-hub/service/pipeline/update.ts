import type {
  ModelHubRepository,
  PipelineModelEntry,
  CreatePipelineModelInput,
} from '@/server/model-hub/repository';

export function movePipelineModel(
  repository: ModelHubRepository,
  profileId: string,
  modelId: string,
  direction: 'up' | 'down',
): boolean {
  const pipeline = [...repository.listPipelineModels(profileId)].sort(
    (a, b) => a.priority - b.priority,
  );
  const sourceIndex = pipeline.findIndex((model) => model.id === modelId);
  if (sourceIndex < 0) return false;

  const targetIndex = direction === 'up' ? sourceIndex - 1 : sourceIndex + 1;
  if (targetIndex < 0 || targetIndex >= pipeline.length) return false;

  const source = pipeline[sourceIndex];
  const target = pipeline[targetIndex];
  repository.updatePipelineModelPriority(source.id, target.priority);
  repository.updatePipelineModelPriority(target.id, source.priority);
  return true;
}

export function replacePipeline(
  repository: ModelHubRepository,
  profileId: string,
  models: CreatePipelineModelInput[],
): PipelineModelEntry[] {
  return repository.replacePipeline(profileId, models);
}
