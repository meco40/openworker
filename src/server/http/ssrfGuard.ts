import dns from 'node:dns/promises';

const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;

function parseIpv4(value: string): number[] | null {
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const numbers = parts.map(Number);
  return numbers.every((part) => part >= 0 && part <= 255) ? numbers : null;
}

function ipv4ToInteger(parts: number[]): number {
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isBlockedIpv4(value: string): boolean {
  const parts = parseIpv4(value);
  if (!parts) return false;
  const number = ipv4ToInteger(parts);
  const inRange = (start: number, end: number) => number >= start && number <= end;
  return (
    inRange(0x00000000, 0x00ffffff) || // current network
    inRange(0x0a000000, 0x0affffff) || // RFC1918
    inRange(0x64400000, 0x647fffff) || // carrier-grade NAT
    inRange(0x7f000000, 0x7fffffff) || // loopback
    inRange(0xa9fe0000, 0xa9feffff) || // link-local
    inRange(0xac100000, 0xac1fffff) || // RFC1918
    inRange(0xc0000000, 0xc00000ff) || // IETF protocol assignments
    inRange(0xc0000200, 0xc00002ff) || // TEST-NET-1
    inRange(0xc0120000, 0xc01200ff) || // benchmarking
    inRange(0xc0a80000, 0xc0a8ffff) || // RFC1918
    inRange(0xc6336400, 0xc63364ff) || // TEST-NET-2
    inRange(0xcb007100, 0xcb0071ff) || // TEST-NET-3
    inRange(0xe0000000, 0xffffffff) // multicast/reserved
  );
}

function parseIpv6(value: string): number[] | null {
  const normalized = value.toLowerCase().split('%', 1)[0];
  if (!normalized.includes(':')) return null;

  const [head, tail, ...extra] = normalized.split('::');
  if (extra.length > 0) return null;

  const parsePart = (part: string): number[] | null => {
    if (!part) return [];
    const pieces = part.split(':');
    const result: number[] = [];
    for (const piece of pieces) {
      if (piece.includes('.')) {
        const ipv4 = parseIpv4(piece);
        if (!ipv4) return null;
        result.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
      } else if (/^[0-9a-f]{1,4}$/.test(piece)) {
        result.push(Number.parseInt(piece, 16));
      } else {
        return null;
      }
    }
    return result;
  };

  const left = parsePart(head);
  const right = parsePart(tail || '');
  if (!left || !right) return null;
  if (tail === undefined) {
    return left.length === 8 ? left : null;
  }
  const missing = 8 - left.length - right.length;
  return missing > 0 && missing <= 8
    ? [...left, ...Array.from({ length: missing }, () => 0), ...right]
    : null;
}

function isBlockedIpv6(value: string): boolean {
  const parts = parseIpv6(value);
  if (!parts) return false;

  // IPv4-mapped IPv6 addresses must use the IPv4 policy too.
  if (parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff) {
    return isBlockedIpv4(
      [parts[6] >> 8, parts[6] & 0xff, parts[7] >> 8, parts[7] & 0xff].join('.'),
    );
  }

  const first = parts[0];
  const second = parts[1];
  return (
    parts.every((part) => part === 0) ||
    parts.every((part, index) => (index === 7 ? part === 1 : part === 0)) || // ::1
    (first & 0xfe00) === 0xfc00 || // unique local
    (first & 0xffc0) === 0xfe80 || // link-local
    (first & 0xfe00) === 0xfec0 || // deprecated site-local
    (first & 0xff00) === 0xff00 || // multicast
    (first === 0x0100 && second === 0) || // discard-only ::100
    (first === 0x2001 && second === 0x0db8) || // documentation
    (first === 0x2001 && (second & 0xfff0) === 0x0010) // benchmarking
  );
}

export function isPrivateOrReservedIp(value: string): boolean {
  return isBlockedIpv4(value) || isBlockedIpv6(value);
}

export async function assertSafeHttpUrl(input: string | URL): Promise<URL> {
  const url = input instanceof URL ? new URL(input) : new URL(input);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`Unsupported protocol: ${url.protocol}`);
  }
  if (!url.hostname || url.username || url.password) {
    throw new Error('URL must contain a hostname and no embedded credentials.');
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error(`SSRF guard: blocked local hostname "${hostname}"`);
  }
  if (isPrivateOrReservedIp(hostname)) {
    throw new Error(`SSRF guard: blocked private/loopback address "${hostname}"`);
  }

  // Resolve every address family. Fetch's default DNS lookup is not enough
  // for an SSRF decision because an AAAA answer can be private even when A is public.
  let addresses: Array<{ address: string }>;
  try {
    addresses = (await dns.lookup(hostname, { all: true, verbatim: true })) as Array<{
      address: string;
    }>;
  } catch {
    throw new Error(`SSRF guard: hostname could not be resolved "${hostname}"`);
  }
  if (addresses.length === 0) {
    throw new Error(`SSRF guard: hostname could not be resolved "${hostname}"`);
  }
  for (const address of addresses) {
    if (isPrivateOrReservedIp(address.address)) {
      throw new Error(
        `SSRF guard: hostname "${hostname}" resolves to private address "${address.address}"`,
      );
    }
  }

  return url;
}

export interface SsrfFetchOptions {
  maxRedirects?: number;
}

export async function fetchWithSsrfGuard(
  input: string | URL,
  init: RequestInit = {},
  options: SsrfFetchOptions = {},
): Promise<Response> {
  const maxRedirects = Math.max(0, Math.floor(options.maxRedirects ?? DEFAULT_MAX_REDIRECTS));
  let currentInit: RequestInit = { ...init, redirect: 'manual' as RequestRedirect };
  let currentUrl = input instanceof URL ? new URL(input) : new URL(input);

  for (let redirectCount = 0; ; redirectCount += 1) {
    await assertSafeHttpUrl(currentUrl);
    const response = await fetch(currentUrl, currentInit);
    const isRedirect = response.status >= 300 && response.status < 400;
    const location = response.headers.get('location');
    if (!isRedirect || !location) return response;
    if (redirectCount >= maxRedirects) {
      throw new Error('SSRF guard: redirect limit exceeded.');
    }
    const nextUrl = new URL(location, currentUrl);
    if (nextUrl.origin !== currentUrl.origin) {
      const redirectedHeaders = new Headers(currentInit.headers);
      for (const header of ['authorization', 'cookie', 'proxy-authorization']) {
        redirectedHeaders.delete(header);
      }
      currentInit = { ...currentInit, headers: redirectedHeaders };
    }
    currentUrl = nextUrl;
  }
}

export async function readResponseBytesLimited(
  response: Response,
  maxBytes = DEFAULT_MAX_BODY_BYTES,
): Promise<Buffer> {
  const contentLength = Number(response.headers.get('content-length') || '');
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`Response body exceeds the ${maxBytes}-byte limit.`);
  }

  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes)
      throw new Error(`Response body exceeds the ${maxBytes}-byte limit.`);
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`Response body exceeds the ${maxBytes}-byte limit.`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export async function readResponseTextLimited(
  response: Response,
  maxBytes = DEFAULT_MAX_BODY_BYTES,
): Promise<string> {
  return (await readResponseBytesLimited(response, maxBytes)).toString('utf8');
}
