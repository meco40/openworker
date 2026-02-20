/**
 * Callback data patterns (max 64 bytes for Telegram):
 * - mdl_prov              - show providers list
 * - mdl_list_{prov}_{pg}  - show models for provider (page starts at 1)
 * - mdl_sel_{provider/id} - select model
 * - mdl_back              - back to providers list
 */

export type ButtonRow = Array<{ text: string; callback_data: string }>;

export type ParsedModelCallback =
  | { type: 'providers' }
  | { type: 'list'; provider: string; page: number }
  | { type: 'select'; provider: string; model: string }
  | { type: 'back' };

export type ProviderInfo = {
  id: string;
  count: number;
};

export type ModelsKeyboardParams = {
  provider: string;
  models: string[];
  currentModel?: string;
  currentPage: number;
  totalPages: number;
  pageSize?: number;
};

const MODELS_PAGE_SIZE = 8;
const MAX_CALLBACK_DATA_BYTES = 64;

export function parseModelCallbackData(data: string): ParsedModelCallback | null {
  const trimmed = data.trim();
  if (!trimmed.startsWith('mdl_')) {
    return null;
  }

  if (trimmed === 'mdl_prov' || trimmed === 'mdl_back') {
    return { type: trimmed === 'mdl_prov' ? 'providers' : 'back' };
  }

  const listMatch = trimmed.match(/^mdl_list_([a-z0-9_-]+)_(\d+)$/i);
  if (listMatch) {
    const [, provider, pageStr] = listMatch;
    const page = Number.parseInt(pageStr ?? '1', 10);
    if (provider && Number.isFinite(page) && page >= 1) {
      return { type: 'list', provider, page };
    }
  }

  const selectMatch = trimmed.match(/^mdl_sel_(.+)$/);
  if (selectMatch) {
    const modelRef = selectMatch[1];
    if (modelRef) {
      const slashIndex = modelRef.indexOf('/');
      if (slashIndex > 0 && slashIndex < modelRef.length - 1) {
        return {
          type: 'select',
          provider: modelRef.slice(0, slashIndex),
          model: modelRef.slice(slashIndex + 1),
        };
      }
    }
  }

  return null;
}

export function buildProviderKeyboard(providers: ProviderInfo[]): ButtonRow[] {
  if (providers.length === 0) {
    return [];
  }

  const rows: ButtonRow[] = [];
  let currentRow: ButtonRow = [];

  for (const provider of providers) {
    currentRow.push({
      text: `${provider.id} (${provider.count})`,
      callback_data: `mdl_list_${provider.id}_1`,
    });

    if (currentRow.length === 2) {
      rows.push(currentRow);
      currentRow = [];
    }
  }

  if (currentRow.length > 0) {
    rows.push(currentRow);
  }

  return rows;
}

export function buildModelsKeyboard(params: ModelsKeyboardParams): ButtonRow[] {
  const { provider, models, currentModel, currentPage, totalPages } = params;
  const pageSize = params.pageSize ?? MODELS_PAGE_SIZE;

  if (models.length === 0) {
    return [[{ text: '< Back', callback_data: 'mdl_back' }]];
  }

  const rows: ButtonRow[] = [];
  const startIndex = (currentPage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, models.length);
  const pageModels = models.slice(startIndex, endIndex);

  for (const model of pageModels) {
    const callbackData = `mdl_sel_${provider}/${model}`;
    if (Buffer.byteLength(callbackData, 'utf8') > MAX_CALLBACK_DATA_BYTES) {
      continue;
    }

    const active = model === currentModel;
    rows.push([
      {
        text: active ? `${truncateModelId(model, 40)} *` : truncateModelId(model, 40),
        callback_data: callbackData,
      },
    ]);
  }

  if (totalPages > 1) {
    const pageRow: ButtonRow = [];
    if (currentPage > 1) {
      pageRow.push({
        text: '< Prev',
        callback_data: `mdl_list_${provider}_${currentPage - 1}`,
      });
    }
    pageRow.push({
      text: `${currentPage}/${totalPages}`,
      callback_data: `mdl_list_${provider}_${currentPage}`,
    });
    if (currentPage < totalPages) {
      pageRow.push({
        text: 'Next >',
        callback_data: `mdl_list_${provider}_${currentPage + 1}`,
      });
    }
    rows.push(pageRow);
  }

  rows.push([{ text: '< Back', callback_data: 'mdl_back' }]);
  return rows;
}

export function buildBrowseProvidersButton(): ButtonRow[] {
  return [[{ text: 'Browse providers', callback_data: 'mdl_prov' }]];
}

export function calculateTotalPages(totalModels: number, pageSize?: number): number {
  const size = pageSize ?? MODELS_PAGE_SIZE;
  return size > 0 ? Math.max(1, Math.ceil(totalModels / size)) : 1;
}

export function getModelsPageSize(): number {
  return MODELS_PAGE_SIZE;
}

function truncateModelId(modelId: string, maxLen: number): string {
  if (modelId.length <= maxLen) {
    return modelId;
  }
  return `...${modelId.slice(-(maxLen - 3))}`;
}
