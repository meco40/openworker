/**
 * Production auth configuration guard.
 *
 * In production, authentication must be explicitly enabled. This prevents
 * accidental deployments that expose the control plane without auth.
 */
export function assertProductionAuthConfig(): void {
  if (process.env.NODE_ENV !== 'production') {
    return;
  }

  const requireAuth = String(process.env.REQUIRE_AUTH || 'false').toLowerCase() === 'true';
  const e2eAnonymousAuth =
    String(process.env.E2E_ALLOW_ANONYMOUS_AUTH || '').toLowerCase() === 'true';
  const hostname = String(process.env.HOSTNAME || '')
    .trim()
    .toLowerCase();
  const loopbackHost = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  if (e2eAnonymousAuth && loopbackHost && !requireAuth) {
    return;
  }

  if (!requireAuth) {
    throw new Error(
      'REQUIRE_AUTH must be set to "true" in production. ' +
        'Refusing to start without authentication to protect the control plane.',
    );
  }

  const secret = process.env.NEXTAUTH_SECRET?.trim() || process.env.AUTH_SECRET?.trim();
  if (!secret) {
    throw new Error('NEXTAUTH_SECRET (or AUTH_SECRET) must be set in production.');
  }
}
