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
    // OpenAI uses Auth0 PKCE — only client_id needed (no secret, no URL env vars)
    openai: Boolean(process.env.OPENAI_OAUTH_CLIENT_ID?.trim()),
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
    // Filter authMethods: only expose oauth if it's actually configured
    const configuredAuthMethods = provider.authMethods.filter((method) => {
      if (method === 'api_key') return true;
      if (method === 'oauth') return oauthReady[provider.id] === true;
      return false;
    });

    // Ensure at least api_key is available (should always be the case)
    if (configuredAuthMethods.length === 0) {
      configuredAuthMethods.push('api_key');
    }

    return {
      ...provider,
      authMethods: configuredAuthMethods,
      oauthConfigured: oauthReady[provider.id] ?? false,
    };
  });

  return NextResponse.json({ ok: true, providers });
}
