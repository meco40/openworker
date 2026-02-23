import { createElement } from 'react';
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
});
