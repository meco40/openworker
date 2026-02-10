import { NextResponse } from 'next/server';
import { createOAuthNonce, createOAuthState, createPkcePair } from '../../../../../src/server/model-hub/oauth';
import { getModelHubEncryptionKey } from '../../../../../src/server/model-hub/runtime';
import { PROVIDER_CATALOG } from '../../../../../src/server/model-hub/providerCatalog';

export const runtime = 'nodejs';

function findProvider(providerId: string) {
  return PROVIDER_CATALOG.find((provider) => provider.id === providerId) ?? null;
}

function buildCallbackUrl(requestUrl: string): string {
  const url = new URL(requestUrl);
  return `${url.origin}/api/model-hub/oauth/callback`;
}

function popupResult(ok: boolean, message: string, status = 200) {
  const payload = JSON.stringify({
    type: 'MODEL_HUB_OAUTH_RESULT',
    ok,
    message,
  });
  const html = `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Model Hub OAuth</title></head>
  <body>
    <script>
      (function () {
        const payload = ${payload};
        if (window.opener) {
          window.opener.postMessage(payload, window.location.origin);
        }
        document.body.innerText = payload.message;
        setTimeout(function () { window.close(); }, 250);
      })();
    </script>
  </body>
</html>`;
  return new NextResponse(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function buildOpenRouterAuthorizeUrl(
  stateWithVerifier: string,
  callbackUrl: string,
  codeChallenge: string,
): string {
  const authUrl = new URL('https://openrouter.ai/auth');
  authUrl.searchParams.set('callback_url', callbackUrl);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', stateWithVerifier);
  return authUrl.toString();
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const providerId = String(url.searchParams.get('providerId') || '').trim();
    const label = String(url.searchParams.get('label') || '').trim();
    const callbackUrl = buildCallbackUrl(request.url);

    if (!providerId) {
      return popupResult(false, 'providerId is required.', 400);
    }

    const provider = findProvider(providerId);
    if (!provider) {
      return popupResult(false, `Unknown provider: ${providerId}`, 400);
    }
    if (!provider.authMethods.includes('oauth')) {
      return popupResult(false, `${provider.name} does not support OAuth.`, 400);
    }

    const signingKey = getModelHubEncryptionKey();
    const oauthStateBase = {
      providerId,
      label: label || `${provider.name} OAuth`,
      createdAt: Date.now(),
      nonce: createOAuthNonce(),
    };

    if (providerId === 'openrouter') {
      const { codeVerifier, codeChallenge } = createPkcePair();
      const state = createOAuthState({ ...oauthStateBase, codeVerifier }, signingKey);
      return NextResponse.redirect(
        buildOpenRouterAuthorizeUrl(state, callbackUrl, codeChallenge),
        { status: 302 },
      );
    }

    const state = createOAuthState(oauthStateBase, signingKey);

    if (providerId === 'github-copilot') {
      const clientId = process.env.GITHUB_OAUTH_CLIENT_ID?.trim();
      if (!clientId) {
        return popupResult(false, 'GitHub OAuth ist nicht konfiguriert. Bitte GITHUB_OAUTH_CLIENT_ID und GITHUB_OAUTH_CLIENT_SECRET in .env.local setzen. Verwende stattdessen einen API Key (Personal Access Token).', 500);
      }

      const authUrl = new URL('https://github.com/login/oauth/authorize');
      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('redirect_uri', callbackUrl);
      authUrl.searchParams.set('scope', 'read:user user:email');
      authUrl.searchParams.set('state', state);
      return NextResponse.redirect(authUrl.toString(), { status: 302 });
    }

    if (providerId === 'openai') {
      const clientId = process.env.OPENAI_OAUTH_CLIENT_ID?.trim();
      if (!clientId) {
        return popupResult(
          false,
          'OpenAI OAuth ist nicht konfiguriert. Bitte OPENAI_OAUTH_CLIENT_ID in .env.local setzen (OAuth App auf platform.openai.com registrieren). Verwende alternativ einen API Key.',
          500,
        );
      }

      // OpenAI uses Auth0 — endpoints are stable and publicly discoverable via OIDC.
      // We use PKCE (S256) so no client_secret is needed.
      const { codeVerifier, codeChallenge } = createPkcePair();
      const pkceState = createOAuthState({ ...oauthStateBase, codeVerifier }, signingKey);
      const scope = process.env.OPENAI_OAUTH_SCOPE?.trim() || 'openid profile email offline_access';
      const authUrl = new URL('https://auth0.openai.com/authorize');
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('redirect_uri', callbackUrl);
      authUrl.searchParams.set('scope', scope);
      authUrl.searchParams.set('state', pkceState);
      authUrl.searchParams.set('code_challenge', codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      return NextResponse.redirect(authUrl.toString(), { status: 302 });
    }

    return popupResult(false, `OAuth flow for ${provider.name} is not configured.`, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'OAuth start failed.';
    return popupResult(false, message, 500);
  }
}
