/**
 * Request-origin policy for API access without a session or bearer token.
 *
 * Trust is derived from the TCP peer and from browser fetch metadata, never from
 * a header the client can forge alone. server.ts discards any incoming
 * CLIENT_LOOPBACK_HEADER and sets it only when the socket peer is loopback, so a
 * missing marker (LAN peer, `next dev` without server.ts) fails closed. `dev:next`
 * binds 127.0.0.1 because plain `next dev` cannot strip a client-sent marker.
 */

export const CLIENT_LOOPBACK_HEADER = 'x-betaclaw-client-loopback';

export interface BrowserRequestHeaders {
  host: string | null | undefined;
  origin: string | null | undefined;
  referer: string | null | undefined;
  secFetchSite: string | null | undefined;
}

const IPV4_LOOPBACK = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
// Host header parts: a plain host name (no userinfo "@", no stray colons) or a bracketed IPv6 literal, then an optional port.
const HOST_NAME = /^[^\s:@/[\]]+$/;
const PORT_SUFFIX = /^:\d{1,5}$/;

/** True for 127.0.0.0/8, ::1 and their IPv4-mapped forms. */
export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  let normalized = address.trim().toLowerCase();
  if (normalized.startsWith('::ffff:')) normalized = normalized.slice('::ffff:'.length);
  if (normalized === '::1') return true;
  const match = IPV4_LOOPBACK.exec(normalized);
  return match !== null && match.slice(1).every((octet) => Number(octet) <= 255);
}

/** Replaces any client-supplied loopback marker with one derived from the socket peer. */
export function applyClientLoopbackMarker(
  headers: Record<string, string | string[] | undefined>,
  remoteAddress: string | null | undefined,
): void {
  delete headers[CLIENT_LOOPBACK_HEADER];
  if (isLoopbackAddress(remoteAddress)) {
    headers[CLIENT_LOOPBACK_HEADER] = '1';
  }
}

function normalizedHost(hostHeader: string | null | undefined): string | null {
  const host = hostHeader?.trim().toLowerCase();
  return host ? host : null;
}

function hostNameOf(hostHeader: string | null | undefined): string | null {
  const host = normalizedHost(hostHeader);
  if (host === null || host === '::1') return host; // unbracketed IPv6 literal, tolerated
  const bracketed = host.startsWith('[');
  const closeAt = bracketed ? host.indexOf(']') : -1;
  if (bracketed && closeAt === -1) return null;
  const colon = host.indexOf(':');
  const name = bracketed ? host.slice(1, closeAt) : colon === -1 ? host : host.slice(0, colon);
  const suffix = bracketed ? host.slice(closeAt + 1) : host.slice(name.length);
  if (suffix !== '' && !PORT_SUFFIX.test(suffix)) return null;
  if (!bracketed && !HOST_NAME.test(name)) return null;
  return name;
}

/** Host header names a loopback address: localhost, 127.0.0.1, ::1, or *.localhost (port ignored). */
export function isLoopbackHostHeader(hostHeader: string | null | undefined): boolean {
  const name = hostNameOf(hostHeader);
  return (
    name !== null &&
    (name === 'localhost' || name === '127.0.0.1' || name === '::1' || name.endsWith('.localhost'))
  );
}

function urlHostMatches(url: string | null | undefined, host: string | null): boolean {
  if (!url || host === null) return false;
  try {
    return new URL(url).host.toLowerCase() === host;
  } catch {
    return false;
  }
}

/**
 * True when a browser reports the request as cross-site: Fetch Metadata says so, or a
 * present Origin/Referer names a different host (including the opaque "null" origin).
 */
export function isCrossSiteBrowserRequest(input: BrowserRequestHeaders): boolean {
  const site = input.secFetchSite?.trim().toLowerCase();
  if (site === 'cross-site' || site === 'same-site') return true;
  const host = normalizedHost(input.host);
  return (
    (Boolean(input.origin) && !urlHostMatches(input.origin, host)) ||
    (Boolean(input.referer) && !urlHostMatches(input.referer, host))
  );
}

/** True for browser UI requests from the same origin (Fetch Metadata or a matching Origin/Referer). */
export function isSameOriginBrowserRequest(input: BrowserRequestHeaders): boolean {
  if (input.secFetchSite?.trim().toLowerCase() === 'same-origin') return true;
  const host = normalizedHost(input.host);
  return urlHostMatches(input.origin, host) || urlHostMatches(input.referer, host);
}

export interface AnonymousLocalPrincipalInput {
  requireAuth: boolean;
  mcApiTokenConfigured: boolean;
  socketLoopback: boolean;
  browser: BrowserRequestHeaders;
}

/**
 * Anonymous access as the local principal (no session, no bearer token).
 *
 * Denied when auth is required. Otherwise the TCP peer must be loopback, the Host
 * must name loopback (blocks DNS rebinding), and no cross-site browser may be
 * involved. With MC_API_TOKEN configured only same-origin browser UI qualifies;
 * other local clients must present the bearer token.
 */
export function shouldAllowAnonymousLocalPrincipal(input: AnonymousLocalPrincipalInput): boolean {
  if (input.requireAuth) return false;
  if (!input.socketLoopback || !isLoopbackHostHeader(input.browser.host)) return false;
  if (isCrossSiteBrowserRequest(input.browser)) return false;
  return !input.mcApiTokenConfigured || isSameOriginBrowserRequest(input.browser);
}
