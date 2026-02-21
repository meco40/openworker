import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const OPENAI_CODEX_PUBLIC_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const OPENAI_CODEX_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
export const OPENAI_CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
export const OPENAI_CODEX_SCOPE = 'openid profile email offline_access';
export const OPENAI_CODEX_LOCAL_REDIRECT_URI = 'http://localhost:1455/auth/callback';
const OPENAI_CODEX_AUTH_CLAIM_PATH = 'https://api.openai.com/auth';

interface CodexTokensPayload {
  access_token?: unknown;
  refresh_token?: unknown;
  account_id?: unknown;
}

interface CodexAuthFilePayload {
  tokens?: CodexTokensPayload;
}

export interface CodexCliCredentials {
  accessToken: string;
  refreshToken: string;
  accountId?: string;
  source: 'keychain' | 'auth_file';
}

export interface OpenAICodexRefreshResult {
  accessToken: string;
  refreshToken: string;
  expiresAt?: number;
  accountId?: string;
}

function toStringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveHomeDirFromEnv(): string {
  const home = toStringOrEmpty(process.env.HOME) || toStringOrEmpty(process.env.USERPROFILE);
  return home ? path.resolve(home) : '';
}

function resolveCodexHomePath(): string {
  const configuredPath = process.env.CODEX_HOME?.trim();
  const homeRoot = configuredPath || resolveHomeDirFromEnv();
  if (!homeRoot) return '';
  const home = configuredPath ? homeRoot : path.join(homeRoot, '.codex');
  try {
    return fs.realpathSync.native(home);
  } catch {
    return home;
  }
}

function resolveCodexAuthFilePath(): string | null {
  const codexHome = resolveCodexHomePath();
  if (!codexHome) return null;
  return path.join(codexHome, 'auth.json');
}

function computeCodexKeychainAccount(codexHomePath: string): string {
  const hash = createHash('sha256').update(codexHomePath).digest('hex');
  return `cli|${hash.slice(0, 16)}`;
}

function resolveCodexHomePathOrNull(): string | null {
  const codexHomePath = resolveCodexHomePath();
  return codexHomePath || null;
}

function parseAuthPayload(raw: unknown): CodexCliCredentials | null {
  if (!raw || typeof raw !== 'object') return null;
  const tokens = (raw as CodexAuthFilePayload).tokens;
  if (!tokens || typeof tokens !== 'object') return null;

  const accessToken = toStringOrEmpty(tokens.access_token);
  const refreshToken = toStringOrEmpty(tokens.refresh_token);
  if (!accessToken || !refreshToken) return null;

  const accountId =
    toStringOrEmpty(tokens.account_id) || extractCodexAccountId(accessToken) || undefined;
  return {
    accessToken,
    refreshToken,
    accountId,
    source: 'auth_file',
  };
}

function readCodexFromKeychain(): CodexCliCredentials | null {
  if (process.platform !== 'darwin') return null;

  const codexHomePath = resolveCodexHomePathOrNull();
  if (!codexHomePath) return null;
  const account = computeCodexKeychainAccount(codexHomePath);
  try {
    const raw = execSync(`security find-generic-password -s "Codex Auth" -a "${account}" -w`, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const parsed = JSON.parse(raw) as { tokens?: CodexTokensPayload };
    const fromKeychain = parseAuthPayload(parsed);
    if (!fromKeychain) return null;
    return { ...fromKeychain, source: 'keychain' };
  } catch {
    return null;
  }
}

function readCodexFromAuthFile(): CodexCliCredentials | null {
  const authPath = resolveCodexAuthFilePath();
  if (!authPath) return null;
  try {
    const raw = fs.readFileSync(authPath, 'utf8');
    const parsed = JSON.parse(raw) as CodexAuthFilePayload;
    return parseAuthPayload(parsed);
  } catch {
    return null;
  }
}

export function readCodexCliCredentials(): CodexCliCredentials | null {
  const keychainCreds = readCodexFromKeychain();
  if (keychainCreds) return keychainCreds;
  return readCodexFromAuthFile();
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1];
    if (!payload) return null;
    const decoded = Buffer.from(payload, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded) as Record<string, unknown>;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function extractCodexAccountId(accessToken: string): string | null {
  const payload = decodeJwtPayload(accessToken);
  if (!payload) return null;
  const auth = payload[OPENAI_CODEX_AUTH_CLAIM_PATH];
  if (!auth || typeof auth !== 'object') return null;
  const accountId = (auth as { chatgpt_account_id?: unknown }).chatgpt_account_id;
  return typeof accountId === 'string' && accountId.trim() ? accountId.trim() : null;
}

export function isJwtExpiringSoon(token: string, bufferSeconds = 90): boolean {
  const payload = decodeJwtPayload(token);
  const exp = payload?.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  return exp <= nowSec + Math.max(0, bufferSeconds);
}

export function getOpenAICodexClientId(): string {
  return process.env.OPENAI_OAUTH_CLIENT_ID?.trim() || OPENAI_CODEX_PUBLIC_CLIENT_ID;
}

export async function refreshOpenAICodexToken(
  refreshToken: string,
): Promise<OpenAICodexRefreshResult> {
  const tokenUrl = process.env.OPENAI_OAUTH_TOKEN_URL?.trim() || OPENAI_CODEX_TOKEN_URL;
  const clientId = getOpenAICodexClientId();
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const details =
      toStringOrEmpty(json.error_description) ||
      toStringOrEmpty(json.error) ||
      `OpenAI Codex token refresh failed (${response.status}).`;
    throw new Error(details);
  }

  const nextAccessToken = toStringOrEmpty(json.access_token);
  if (!nextAccessToken) {
    throw new Error('OpenAI Codex token refresh response did not include access_token.');
  }

  const nextRefreshToken = toStringOrEmpty(json.refresh_token) || refreshToken;
  const expiresIn = Number(json.expires_in);
  const expiresAt =
    Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined;

  return {
    accessToken: nextAccessToken,
    refreshToken: nextRefreshToken,
    expiresAt,
    accountId: extractCodexAccountId(nextAccessToken) || undefined,
  };
}
