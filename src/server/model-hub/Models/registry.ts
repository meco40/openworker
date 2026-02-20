import type { ProviderAdapter } from '@/server/model-hub/Models/types';
import anthropicProviderAdapter from '@/server/model-hub/Models/anthropic';
import bytedanceProviderAdapter from '@/server/model-hub/Models/bytedance';
import cohereProviderAdapter from '@/server/model-hub/Models/cohere';
import geminiProviderAdapter from '@/server/model-hub/Models/gemini';
import githubProviderAdapter from '@/server/model-hub/Models/github-copilot';
import kimiProviderAdapter from '@/server/model-hub/Models/kimi';
import lmStudioProviderAdapter from '@/server/model-hub/Models/lmstudio';
import mistralProviderAdapter from '@/server/model-hub/Models/mistral';
import openAIProviderAdapter from '@/server/model-hub/Models/openai';
import openAICodexProviderAdapter from '@/server/model-hub/Models/openai-codex';
import ollamaProviderAdapter from '@/server/model-hub/Models/ollama';
import openRouterProviderAdapter from '@/server/model-hub/Models/openrouter';
import xAIProviderAdapter from '@/server/model-hub/Models/xai';
import zaiProviderAdapter from '@/server/model-hub/Models/zai';

const providerAdapters: Record<string, ProviderAdapter> = {
  [geminiProviderAdapter.id]: geminiProviderAdapter,
  [openAIProviderAdapter.id]: openAIProviderAdapter,
  [openAICodexProviderAdapter.id]: openAICodexProviderAdapter,
  [anthropicProviderAdapter.id]: anthropicProviderAdapter,
  [openRouterProviderAdapter.id]: openRouterProviderAdapter,
  [ollamaProviderAdapter.id]: ollamaProviderAdapter,
  [lmStudioProviderAdapter.id]: lmStudioProviderAdapter,
  [xAIProviderAdapter.id]: xAIProviderAdapter,
  [mistralProviderAdapter.id]: mistralProviderAdapter,
  [cohereProviderAdapter.id]: cohereProviderAdapter,
  [kimiProviderAdapter.id]: kimiProviderAdapter,
  [zaiProviderAdapter.id]: zaiProviderAdapter,
  [bytedanceProviderAdapter.id]: bytedanceProviderAdapter,
  [githubProviderAdapter.id]: githubProviderAdapter,
};

export function getProviderAdapter(providerId: string): ProviderAdapter | null {
  return providerAdapters[providerId] ?? null;
}

export function listProviderAdapterIds(): string[] {
  return Object.keys(providerAdapters);
}
