import type { ProviderAdapter } from './types';
import anthropicProviderAdapter from './anthropic';
import bytedanceProviderAdapter from './bytedance';
import cohereProviderAdapter from './cohere';
import geminiProviderAdapter from './gemini';
import githubProviderAdapter from './github-copilot';
import kimiProviderAdapter from './kimi';
import mistralProviderAdapter from './mistral';
import openAIProviderAdapter from './openai';
import openAICodexProviderAdapter from './openai-codex';
import openRouterProviderAdapter from './openrouter';
import xAIProviderAdapter from './xai';
import zaiProviderAdapter from './zai';

const providerAdapters: Record<string, ProviderAdapter> = {
  [geminiProviderAdapter.id]: geminiProviderAdapter,
  [openAIProviderAdapter.id]: openAIProviderAdapter,
  [openAICodexProviderAdapter.id]: openAICodexProviderAdapter,
  [anthropicProviderAdapter.id]: anthropicProviderAdapter,
  [openRouterProviderAdapter.id]: openRouterProviderAdapter,
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
