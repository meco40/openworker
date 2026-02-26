import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import PipelineSection from '@/components/model-hub/sections/PipelineSection';
import type { ProviderCatalogEntry } from '@/components/model-hub/types';

describe('pipeline section account row layout', () => {
  it('renders long masked secrets as truncated text with a title', () => {
    const providerLookup = new Map<string, ProviderCatalogEntry>([
      [
        'openrouter',
        {
          id: 'openrouter',
          name: 'OpenRouter',
          icon: 'R',
          authMethods: ['api_key'],
          capabilities: [],
          defaultModels: [],
          endpointType: 'openai_compatible',
        },
      ],
    ]);

    const html = renderToStaticMarkup(
      createElement(PipelineSection, {
        isLoadingPipeline: false,
        pipeline: [],
        isLoadingEmbeddingPipeline: false,
        embeddingPipeline: [],
        providerLookup,
        providerAccounts: [
          {
            id: 'acc-1',
            providerId: 'openrouter',
            label: 'OpenRouter Account',
            authMethod: 'api_key',
            secretMasked: '************************************************************0704d',
            hasRefreshToken: false,
            createdAt: '2026-02-15T00:00:00.000Z',
            updatedAt: '2026-02-15T00:00:00.000Z',
            lastCheckAt: null,
            lastCheckOk: true,
          },
        ],
        onOpenAddModelModal: () => {},
        onOpenAddEmbeddingModelModal: () => {},
        onToggleModelStatus: () => {},
        onMoveModel: () => {},
        onRemoveModelFromPipeline: () => {},
        onToggleEmbeddingModelStatus: () => {},
        onMoveEmbeddingModel: () => {},
        onRemoveEmbeddingModelFromPipeline: () => {},
        isLoadingAccounts: false,
        deletingAccountId: null,
        onSetDeletingAccountId: () => {},
        onDeleteAccount: () => {},
      }),
    );

    expect(html).toContain(
      'title="************************************************************0704d"',
    );
    expect(html).toContain('truncate font-mono text-[10px] text-zinc-600');
  });

  it('renders active embedding model section with add button', () => {
    const providerLookup = new Map<string, ProviderCatalogEntry>();

    const html = renderToStaticMarkup(
      createElement(PipelineSection, {
        isLoadingPipeline: false,
        pipeline: [],
        isLoadingEmbeddingPipeline: false,
        embeddingPipeline: [],
        providerLookup,
        providerAccounts: [],
        onOpenAddModelModal: () => {},
        onOpenAddEmbeddingModelModal: () => {},
        onToggleModelStatus: () => {},
        onMoveModel: () => {},
        onRemoveModelFromPipeline: () => {},
        onToggleEmbeddingModelStatus: () => {},
        onMoveEmbeddingModel: () => {},
        onRemoveEmbeddingModelFromPipeline: () => {},
        isLoadingAccounts: false,
        deletingAccountId: null,
        onSetDeletingAccountId: () => {},
        onDeleteAccount: () => {},
      }),
    );

    expect(html).toContain('Active Embedding Model');
    expect(html).toContain('Embedding hinzufügen');
    expect(html).toContain('Bitte ein Embedding Model hinzufügen');
  });

  it('renders codex probe rate limits next to capability chips when available', () => {
    const providerLookup = new Map<string, ProviderCatalogEntry>([
      [
        'openai-codex',
        {
          id: 'openai-codex',
          name: 'OpenAI Codex',
          icon: 'OC',
          authMethods: ['oauth'],
          capabilities: ['chat', 'tools', 'vision', 'audio'],
          defaultModels: ['gpt-5.3-codex'],
          endpointType: 'openai-compatible',
        },
      ],
    ]);

    const html = renderToStaticMarkup(
      createElement(PipelineSection as unknown as ComponentType<Record<string, unknown>>, {
        isLoadingPipeline: false,
        pipeline: [
          {
            id: 'pm-1',
            profileId: 'p1',
            accountId: 'codex-acc',
            providerId: 'openai-codex',
            modelName: 'gpt-5.3-codex',
            priority: 1,
            status: 'active',
            createdAt: '2026-02-15T00:00:00.000Z',
            updatedAt: '2026-02-15T00:00:00.000Z',
          },
        ],
        isLoadingEmbeddingPipeline: false,
        embeddingPipeline: [],
        providerLookup,
        providerAccounts: [
          {
            id: 'codex-acc',
            providerId: 'openai-codex',
            label: 'Codex Account',
            authMethod: 'oauth',
            secretMasked: '************',
            hasRefreshToken: true,
            createdAt: '2026-02-15T00:00:00.000Z',
            updatedAt: '2026-02-15T00:00:00.000Z',
            lastCheckAt: '2026-02-26T00:00:00.000Z',
            lastCheckOk: true,
          },
        ],
        onOpenAddModelModal: () => {},
        onOpenAddEmbeddingModelModal: () => {},
        onToggleModelStatus: () => {},
        onMoveModel: () => {},
        onRemoveModelFromPipeline: () => {},
        onToggleEmbeddingModelStatus: () => {},
        onMoveEmbeddingModel: () => {},
        onRemoveEmbeddingModelFromPipeline: () => {},
        isLoadingAccounts: false,
        deletingAccountId: null,
        onSetDeletingAccountId: () => {},
        onDeleteAccount: () => {},
        probeRateLimitsByAccountId: {
          'codex-acc': {
            windows: [
              { window: '5h', limit: 300, remaining: 129 },
              { window: '5d', limit: 3000, remaining: 2701 },
            ],
          },
        },
      }),
    );

    expect(html).toContain('Audio');
    expect(html).toContain('5H 129/300');
    expect(html).toContain('5D 2701/3000');
  });

  it('renders codex probe remaining percent when absolute values are unavailable', () => {
    const providerLookup = new Map<string, ProviderCatalogEntry>([
      [
        'openai-codex',
        {
          id: 'openai-codex',
          name: 'OpenAI Codex',
          icon: 'OC',
          authMethods: ['oauth'],
          capabilities: ['chat', 'tools', 'vision', 'audio'],
          defaultModels: ['gpt-5.3-codex'],
          endpointType: 'openai-compatible',
        },
      ],
    ]);

    const html = renderToStaticMarkup(
      createElement(PipelineSection as unknown as ComponentType<Record<string, unknown>>, {
        isLoadingPipeline: false,
        pipeline: [
          {
            id: 'pm-1',
            profileId: 'p1',
            accountId: 'codex-acc',
            providerId: 'openai-codex',
            modelName: 'gpt-5.3-codex',
            priority: 1,
            status: 'active',
            createdAt: '2026-02-15T00:00:00.000Z',
            updatedAt: '2026-02-15T00:00:00.000Z',
          },
        ],
        isLoadingEmbeddingPipeline: false,
        embeddingPipeline: [],
        providerLookup,
        providerAccounts: [
          {
            id: 'codex-acc',
            providerId: 'openai-codex',
            label: 'Codex Account',
            authMethod: 'oauth',
            secretMasked: '************',
            hasRefreshToken: true,
            createdAt: '2026-02-15T00:00:00.000Z',
            updatedAt: '2026-02-15T00:00:00.000Z',
            lastCheckAt: '2026-02-26T00:00:00.000Z',
            lastCheckOk: true,
          },
        ],
        onOpenAddModelModal: () => {},
        onOpenAddEmbeddingModelModal: () => {},
        onToggleModelStatus: () => {},
        onMoveModel: () => {},
        onRemoveModelFromPipeline: () => {},
        onToggleEmbeddingModelStatus: () => {},
        onMoveEmbeddingModel: () => {},
        onRemoveEmbeddingModelFromPipeline: () => {},
        isLoadingAccounts: false,
        deletingAccountId: null,
        onSetDeletingAccountId: () => {},
        onDeleteAccount: () => {},
        probeRateLimitsByAccountId: {
          'codex-acc': {
            windows: [
              { window: '5h', usedPercent: 86, remainingPercent: 14 },
              { window: '5d', usedPercent: 77, remainingPercent: 23 },
            ],
          },
        },
      }),
    );

    expect(html).toContain('5H 14%');
    expect(html).toContain('5D 23%');
  });
});
