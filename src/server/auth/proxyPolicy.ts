interface ProxyPolicyInput {
  requireAuth: boolean;
  hasSession: boolean;
  sameOrigin: boolean;
  loopbackHost: boolean;
}

/**
 * Defines fallback behavior when no MC_API_TOKEN is configured.
 * This keeps local UI usage functional while denying anonymous external access.
 */
export function shouldAllowApiRequestWithoutToken(input: ProxyPolicyInput): boolean {
  if (input.hasSession) {
    return true;
  }

  if (input.requireAuth) {
    return false;
  }

  return input.sameOrigin || input.loopbackHost;
}
