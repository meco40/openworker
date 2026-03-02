import { NextResponse } from 'next/server';
import { parseOAuthState } from '@/server/model-hub/oauth';
import { PROVIDER_CATALOG } from '@/server/model-hub/providerCatalog';
import { getOpenAICodexClientId, OPENAI_CODEX_TOKEN_URL } from '@/server/model-hub/codexAuth';
import { getModelHubEncryptionKey, getModelHubService } from '@/server/model-hub/runtime';
import { buildModelHubCallbackUrl } from '@/server/model-hub/urlOrigin';
import { withUserContext } from '../../../_shared/withUserContext';

export const runtime = 'nodejs';

interface OauthExchangeResult {
  accessToken: string;
  refreshToken?: string;
}

function findProvider(providerId: string) {
  return PROVIDER_CATALOG.find((provider) => provider.id === providerId) ?? null;
}

function htmlResult(ok: boolean, message: string, status = 200): NextResponse {
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
          window.opener.postMessage(payload, '*');
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

function ensureString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

async function exchangeOpenRouterCode(code: string, codeVerifier: string, callbackUrl: string) {
  const response = await fetch('https://openrouter.ai/api/v1/auth/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      code_verifier: codeVerifier,
      callback_url: callbackUrl,
    }),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(ensureString(json.error) || `OpenRouter exchange failed (${response.status}).`);
  }

  const accessToken = ensureString(json.key || json.access_token || json.api_key);
  if (!accessToken) {
    throw new Error('OpenRouter OAuth response did not contain a usable key.');
  }
  return { accessToken };
}

async function exchangeGitHubCode(code: string, callbackUrl: string): Promise<OauthExchangeResult> {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error('Missing GITHUB_OAUTH_CLIENT_ID or GITHUB_OAUTH_CLIENT_SECRET.');
  }

  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: callbackUrl,
    }),
  });

  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(
      ensureString(json.error_description) || `GitHub OAuth exchange failed (${response.status}).`,
    );
  }

  const accessToken = ensureString(json.access_token);
  if (!accessToken) {
    throw new Error('GitHub OAuth response did not include access_token.');
  }

  return {
    accessToken,
    refreshToken: ensureString(json.refresh_token) || undefined,
  };
}

async function exchangeOpenAICode(
  code: string,
  codeVerifier: string,
  callbackUrl: string,
): Promise<OauthExchangeResult> {
  const clientId = getOpenAICodexClientId();
  const clientSecret = process.env.OPENAI_OAUTH_CLIENT_SECRET?.trim() || '';
  const tokenUrl = process.env.OPENAI_OAUTH_TOKEN_URL?.trim() || OPENAI_CODEX_TOKEN_URL;
  const audience = process.env.OPENAI_OAUTH_AUDIENCE?.trim();

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    code_verifier: codeVerifier,
    redirect_uri: callbackUrl,
  });
  if (audience) {
    body.set('audience', audience);
  }
  if (clientSecret) {
    body.set('client_secret', clientSecret);
  }

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(
      ensureString(json.error_description || json.error) ||
        `OpenAI OAuth exchange failed (${response.status}).`,
    );
  }

  const accessToken = ensureString(json.access_token);
  if (!accessToken) {
    throw new Error('OpenAI OAuth response did not include access_token.');
  }

  return {
    accessToken,
    refreshToken: ensureString(json.refresh_token) || undefined,
  };
}

export const GET = withUserContext(
  async ({ request }) => {
    try {
      const url = new URL(request.url);
      const error = String(url.searchParams.get('error') || '').trim();
      const code = String(url.searchParams.get('code') || '').trim();
      const stateParam = String(url.searchParams.get('state') || '').trim();
      if (error) {
        return htmlResult(false, `OAuth canceled: ${error}`);
      }
      if (!code || !stateParam) {
        return htmlResult(false, 'Missing OAuth callback parameters.');
      }

      const signingKey = getModelHubEncryptionKey();
      const state = parseOAuthState(stateParam, signingKey);
      const provider = findProvider(state.providerId);
      if (!provider) {
        return htmlResult(false, `Unknown provider: ${state.providerId}`);
      }

      const callbackUrl = buildModelHubCallbackUrl(request.url);
      let exchanged: OauthExchangeResult;
      if (state.providerId === 'openrouter') {
        if (!state.codeVerifier) {
          return htmlResult(false, 'OpenRouter callback missing PKCE verifier.');
        }
        exchanged = await exchangeOpenRouterCode(code, state.codeVerifier, callbackUrl);
      } else if (state.providerId === 'github-copilot') {
        exchanged = await exchangeGitHubCode(code, callbackUrl);
      } else if (state.providerId === 'openai-codex') {
        if (!state.codeVerifier) {
          return htmlResult(false, 'OpenAI Codex callback missing PKCE verifier.');
        }
        const exchangeRedirectUri = state.oauthRedirectUri?.trim() || callbackUrl;
        exchanged = await exchangeOpenAICode(code, state.codeVerifier, exchangeRedirectUri);
      } else {
        return htmlResult(false, `OAuth callback for ${provider.name} is not implemented.`);
      }

      const service = getModelHubService();
      service.connectAccount({
        providerId: state.providerId,
        label: state.label,
        authMethod: 'oauth',
        secret: exchanged.accessToken,
        refreshToken: exchanged.refreshToken,
        encryptionKey: signingKey,
      });

      return htmlResult(true, `${provider.name} OAuth verbunden.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'OAuth callback failed.';
      return htmlResult(false, message);
    }
  },
  {
    onUnauthorized: () => htmlResult(false, 'Unauthorized', 401),
  },
);
