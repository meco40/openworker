import { NextResponse } from 'next/server';
import { PROVIDER_CATALOG } from '../../../../src/server/model-hub/providerCatalog';
import { resolveRequestUserContext } from '../../../../src/server/auth/userContext';

export const runtime = 'nodejs';

/**
 * Check which OAuth flows are actually configured on the server
 * by verifying the required environment variables exist.
 */
function getOAuthReadiness(): Record<string, boolean> {
  return {
    // OpenAI Codex OAuth is available via public Codex app id (or optional custom id).
    'openai-codex': true,
    'github-copilot': Boolean(process.env.GITHUB_OAUTH_CLIENT_ID?.trim()),
    // OpenRouter uses PKCE — no server-side secrets needed
    openrouter: true,
  };
}

export async function GET() {
  const userContext = await resolveRequestUserContext();
  if (!userContext) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const oauthReady = getOAuthReadiness();

  const providers = PROVIDER_CATALOG.map((provider) => {
    // OpenAI Codex/OpenRouter should always show OAuth as an available method in UI.
    // `oauthConfigured` indicates whether the flow is ready server-side.
    const configuredAuthMethods = provider.authMethods.filter((method) => {
      if (method === 'none') return true;
      if (method === 'api_key') return true;
      if (method !== 'oauth') return false;

      if (provider.id === 'openai-codex' || provider.id === 'openrouter') {
        return true;
      }

      return oauthReady[provider.id] === true;
    });

    const oauthConfigured =
      provider.id === 'openrouter' ? true : (oauthReady[provider.id] ?? false);

    const sortedAuthMethods = [...configuredAuthMethods].sort((left, right) => {
      if (left === right) return 0;
      if (left === 'none') return -1;
      if (right === 'none') return 1;
      if (left === 'api_key') return -1;
      return 1;
    });

    if (sortedAuthMethods.length === 0) {
      sortedAuthMethods.push('api_key');
    }

    return {
      ...provider,
      authMethods: sortedAuthMethods,
      oauthConfigured,
    };
  });

  return NextResponse.json({ ok: true, providers });
}
