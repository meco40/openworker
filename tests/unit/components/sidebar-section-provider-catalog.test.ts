import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import SidebarSection from '../../../components/model-hub/sections/SidebarSection';
import type { ProviderCatalogEntry } from '../../../components/model-hub/types';

describe('sidebar section provider catalog panel', () => {
  it('does not render the provider catalog block', () => {
    const providerCatalog: ProviderCatalogEntry[] = [
      {
        id: 'openai',
        name: 'OpenAI',
        icon: 'O',
        authMethods: ['api_key'],
        capabilities: ['chat'],
        defaultModels: ['gpt-4.1-mini'],
        endpointType: 'openai_compatible',
      },
    ];

    const html = renderToStaticMarkup(
      createElement(SidebarSection, {
        providerCatalog,
        connectProviderId: 'openai',
        onConnectProviderIdChange: () => {},
        selectedConnectProvider: providerCatalog[0],
        availableAuthMethods: ['api_key'],
        connectAuthMethod: 'api_key',
        onConnectAuthMethodChange: () => {},
        connectLabel: 'OpenAI Account',
        onConnectLabelChange: () => {},
        connectSecret: '',
        onConnectSecretChange: () => {},
        isConnecting: false,
        connectMessage: null,
        accountsError: null,
        onConnectProviderAccount: () => {},
        pipeline: [],
        providerAccounts: [],
        isLoadingAccounts: false,
        sessionStats: { requests: 0, lastProbeOk: null },
      }),
    );

    expect(html).not.toContain('Provider Katalog');
  });
});
