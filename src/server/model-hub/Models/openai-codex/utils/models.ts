import type { FetchedModel } from '@/server/model-hub/Models/types';
import { CODEX_MODEL_SEED } from '../constants';

export function mapDefaultModels(defaultModels: string[]): FetchedModel[] {
  return defaultModels.map((id) => ({
    id,
    name: id,
    provider: 'openai-codex',
  }));
}

export function mergeUniqueModels(
  primary: FetchedModel[],
  secondary: FetchedModel[],
): FetchedModel[] {
  const seen = new Set<string>();
  const merged: FetchedModel[] = [];
  for (const model of [...primary, ...secondary]) {
    if (!model?.id || seen.has(model.id)) continue;
    seen.add(model.id);
    merged.push(model);
  }
  return merged;
}

export function buildCodexSeedModels(defaultModels: string[]): FetchedModel[] {
  const mergedDefaults = [...new Set<string>([...defaultModels, ...CODEX_MODEL_SEED])];
  return mapDefaultModels(mergedDefaults);
}
