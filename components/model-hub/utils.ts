import type { FetchedModel, PipelineModel } from './types';

export function getDefaultActiveModel(pipeline: PipelineModel[]): PipelineModel | null {
  return [...pipeline]
    .filter((model) => model.status === 'active')
    .sort((a, b) => a.priority - b.priority)[0] ?? null;
}

export function filterLiveModels(models: FetchedModel[], query: string): FetchedModel[] {
  if (!query.trim()) return models;
  const lowerQuery = query.toLowerCase();
  return models.filter(
    (model) =>
      model.id.toLowerCase().includes(lowerQuery) ||
      model.name.toLowerCase().includes(lowerQuery),
  );
}
