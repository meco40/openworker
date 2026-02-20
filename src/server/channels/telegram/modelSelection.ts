import { ChannelType } from '../../../../types';
import type { PipelineModelEntry } from '../../model-hub/repository';
import { getModelHubService } from '../../model-hub/runtime';
import {
  answerTelegramCallbackQuery,
  buildInlineKeyboard,
  deliverTelegram,
  editTelegramMessage,
  type TelegramReplyMarkup,
} from '../outbound/telegram';
import {
  buildBrowseProvidersButton,
  buildModelsKeyboard,
  buildProviderKeyboard,
  calculateTotalPages,
  getModelsPageSize,
  parseModelCallbackData,
} from './modelButtons';

type TelegramModelProvider = {
  id: string;
  models: string[];
};

export interface TelegramModelCallbackQuery {
  id: string;
  data?: string;
  message?: {
    message_id?: number;
    message_thread_id?: number;
    chat?: { id?: number; type?: string; is_forum?: boolean };
  };
}

type ParsedNativeCommand =
  | { kind: 'none' }
  | { kind: 'model'; args: string; command: '/model' };

const CLEAR_MODEL_ARGS = new Set(['off', 'clear', 'auto', 'default']);

function parseNativeCommand(text: string): ParsedNativeCommand {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) {
    return { kind: 'none' };
  }

  const firstSpace = trimmed.indexOf(' ');
  const token = (firstSpace >= 0 ? trimmed.slice(0, firstSpace) : trimmed).toLowerCase();
  const bareToken = token.split('@')[0];

  if (bareToken !== '/model') {
    return { kind: 'none' };
  }

  const args = firstSpace >= 0 ? trimmed.slice(firstSpace + 1).trim() : '';
  return { kind: 'model', args, command: '/model' };
}

function normalizeProviderKey(providerId: string): string {
  return providerId.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

function listActiveProviders(profileId: string): TelegramModelProvider[] {
  const entries = getModelHubService()
    .listPipeline(profileId)
    .filter((entry) => entry.status === 'active');

  const byProvider = new Map<string, Set<string>>();

  for (const entry of entries) {
    const providerKey = normalizeProviderKey(entry.providerId);
    if (!providerKey) {
      continue;
    }

    const target = byProvider.get(providerKey) ?? new Set<string>();
    target.add(entry.modelName);
    byProvider.set(providerKey, target);
  }

  return [...byProvider.entries()]
    .map(([id, models]) => ({
      id,
      models: [...models].sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function findModelByReference(
  providers: TelegramModelProvider[],
  rawReference: string,
): { provider: string; model: string } | null {
  const normalized = rawReference.trim();
  if (!normalized) {
    return null;
  }

  if (normalized.includes('/')) {
    const slashIndex = normalized.indexOf('/');
    const provider = normalizeProviderKey(normalized.slice(0, slashIndex));
    const modelCandidate = normalized.slice(slashIndex + 1).trim();
    const providerEntry = providers.find((entry) => entry.id === provider);
    const exact = providerEntry?.models.find((model) => model === modelCandidate);
    if (providerEntry && exact) {
      return { provider, model: exact };
    }
  }

  const matches: Array<{ provider: string; model: string }> = [];
  const normalizedLower = normalized.toLowerCase();
  for (const provider of providers) {
    for (const model of provider.models) {
      if (model.toLowerCase() === normalizedLower) {
        matches.push({ provider: provider.id, model });
      }
    }
  }

  if (matches.length === 1) {
    return matches[0];
  }

  return null;
}

function buildModelOverviewText(
  currentModel: string | null,
  providers: TelegramModelProvider[],
): string {
  const lines = [
    'Model selection',
    `Current override: ${currentModel || 'auto (pipeline fallback)'}`,
    '',
  ];

  if (providers.length === 0) {
    lines.push('No active models are available in profile p1.');
    return lines.join('\n');
  }

  lines.push('Providers:');
  for (const provider of providers) {
    lines.push(`- ${provider.id}: ${provider.models.length} models`);
  }
  lines.push('');
  lines.push('Use /model <model-id> to set directly, or choose a provider below.');

  return lines.join('\n');
}

function toProviderInfo(providers: TelegramModelProvider[]): Array<{ id: string; count: number }> {
  return providers.map((provider) => ({
    id: provider.id,
    count: provider.models.length,
  }));
}

function resolveProfileId(): string {
  return process.env.MODEL_HUB_PROFILE_ID?.trim() || 'p1';
}

async function resolveTelegramConversation(chatId: string, conversationExternalChatId?: string) {
  // eslint-disable-next-line import-x/no-cycle
  const { getMessageService } = await import('../messages/runtime');
  const service = getMessageService();
  const conversation = service.getOrCreateConversation(
    ChannelType.TELEGRAM,
    conversationExternalChatId || chatId,
  );
  return { service, conversation };
}

async function sendOrEditTelegramModelMessage(
  chatId: string,
  text: string,
  options: {
    messageId?: number;
    replyMarkup?: TelegramReplyMarkup;
  },
): Promise<void> {
  if (typeof options.messageId === 'number') {
    try {
      await editTelegramMessage(chatId, options.messageId, text, {
        replyMarkup: options.replyMarkup,
      });
      return;
    } catch (error) {
      console.warn('[Telegram] editMessageText failed, falling back to sendMessage:', error);
    }
  }

  await deliverTelegram(chatId, text, {
    replyMarkup: options.replyMarkup,
  });
}

export async function handleTelegramNativeCommand(
  chatId: string,
  text: string,
  conversationExternalChatId?: string,
): Promise<boolean> {
  const parsed = parseNativeCommand(text);
  if (parsed.kind !== 'model') {
    return false;
  }

  const { service, conversation } = await resolveTelegramConversation(chatId, conversationExternalChatId);
  const profileId = resolveProfileId();
  const providers = listActiveProviders(profileId);
  const arg = parsed.args.trim();
  const argLower = arg.toLowerCase();

  if (CLEAR_MODEL_ARGS.has(argLower)) {
    service.setModelOverride(conversation.id, null, conversation.userId);
    await deliverTelegram(chatId, 'Model override cleared. The pipeline fallback will be used.');
    return true;
  }

  if (arg.length > 0) {
    const selected = findModelByReference(providers, arg);
    if (!selected) {
      await deliverTelegram(
        chatId,
        'Model not found in active pipeline. Send /model for provider browsing.',
      );
      return true;
    }

    service.setModelOverride(conversation.id, selected.model, conversation.userId);
    await deliverTelegram(chatId, `Model override set to ${selected.model} (${selected.provider}).`);
    return true;
  }

  const overview = buildModelOverviewText(conversation.modelOverride, providers);
  const replyMarkup = buildInlineKeyboard(buildProviderKeyboard(toProviderInfo(providers)));
  await deliverTelegram(chatId, overview, { replyMarkup });
  return true;
}

export async function processTelegramModelCallback(
  query: TelegramModelCallbackQuery,
): Promise<boolean> {
  const data = query.data?.trim();
  if (!data) {
    return false;
  }

  const parsed = parseModelCallbackData(data);
  if (!parsed) {
    return false;
  }

  const chatIdRaw = query.message?.chat?.id;
  if (typeof chatIdRaw !== 'number') {
    await answerTelegramCallbackQuery(query.id, 'Missing chat context.');
    return true;
  }

  const chatId = String(chatIdRaw);
  const profileId = resolveProfileId();
  const providers = listActiveProviders(profileId);
  const conversationExternalChatId = resolveCallbackConversationExternalChatId(query);
  const { service, conversation } = await resolveTelegramConversation(
    chatId,
    conversationExternalChatId,
  );
  const messageId = query.message?.message_id;

  switch (parsed.type) {
    case 'providers':
    case 'back': {
      await answerTelegramCallbackQuery(query.id);
      const replyMarkup = buildInlineKeyboard(
        providers.length > 0
          ? buildProviderKeyboard(toProviderInfo(providers))
          : buildBrowseProvidersButton(),
      );
      await sendOrEditTelegramModelMessage(
        chatId,
        buildModelOverviewText(conversation.modelOverride, providers),
        {
          messageId,
          replyMarkup,
        },
      );
      return true;
    }
    case 'list': {
      const provider = providers.find((entry) => entry.id === parsed.provider);
      if (!provider) {
        await answerTelegramCallbackQuery(query.id, 'Provider not found.');
        return true;
      }

      const totalPages = calculateTotalPages(provider.models.length, getModelsPageSize());
      const currentPage = Math.min(Math.max(parsed.page, 1), totalPages);
      const rows = buildModelsKeyboard({
        provider: provider.id,
        models: provider.models,
        currentModel: conversation.modelOverride || undefined,
        currentPage,
        totalPages,
      });

      await answerTelegramCallbackQuery(query.id);
      await sendOrEditTelegramModelMessage(
        chatId,
        `Provider ${provider.id} (${provider.models.length} models)\nSelect a model:`,
        {
          messageId,
          replyMarkup: buildInlineKeyboard(rows),
        },
      );
      return true;
    }
    case 'select': {
      const selectedProvider = providers.find((entry) => entry.id === parsed.provider);
      const selectedModel = selectedProvider?.models.find((model) => model === parsed.model);

      if (!selectedProvider || !selectedModel) {
        await answerTelegramCallbackQuery(query.id, 'Model not available.');
        return true;
      }

      service.setModelOverride(conversation.id, selectedModel, conversation.userId);
      await answerTelegramCallbackQuery(query.id, `Model set: ${selectedModel}`);

      await sendOrEditTelegramModelMessage(
        chatId,
        `Model override set to ${selectedModel} (${selectedProvider.id}).`,
        {
          messageId,
          replyMarkup: buildInlineKeyboard(buildBrowseProvidersButton()),
        },
      );
      return true;
    }
    default:
      return false;
  }
}

export function resolveActivePipelineEntries(profileId = resolveProfileId()): PipelineModelEntry[] {
  return getModelHubService()
    .listPipeline(profileId)
    .filter((entry) => entry.status === 'active');
}

function resolveCallbackConversationExternalChatId(query: TelegramModelCallbackQuery): string | undefined {
  const chat = query.message?.chat;
  if (!chat || typeof chat.id !== 'number') {
    return undefined;
  }

  const baseChatId = String(chat.id);
  const rawThreadId = query.message?.message_thread_id;
  const threadId =
    typeof rawThreadId === 'number' && Number.isFinite(rawThreadId) ? Math.trunc(rawThreadId) : null;

  if (threadId === null || threadId <= 0) {
    return baseChatId;
  }

  if (chat.type === 'private') {
    return `${baseChatId}:topic:${threadId}`;
  }

  const isForumGroup = chat.type === 'supergroup' && chat.is_forum === true;
  if (!isForumGroup || threadId === 1) {
    return baseChatId;
  }

  return `${baseChatId}:topic:${threadId}`;
}
