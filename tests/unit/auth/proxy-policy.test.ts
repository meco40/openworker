import { describe, expect, it } from 'vitest';
import {
  CLIENT_LOOPBACK_HEADER,
  applyClientLoopbackMarker,
  applyLoopbackMarkerForTopology,
  isCrossSiteBrowserRequest,
  isLoopbackAddress,
  isLoopbackHostHeader,
  isSameOriginBrowserRequest,
  shouldAllowAnonymousLocalPrincipal,
  type BrowserRequestHeaders,
} from '@/server/auth/proxyPolicy';

const LOOPBACK_PEER = '127.0.0.1';
const LAN_PEER = '192.168.1.50';

function browser(overrides: Partial<BrowserRequestHeaders> = {}): BrowserRequestHeaders {
  return { host: 'localhost:3000', origin: null, referer: null, secFetchSite: null, ...overrides };
}

function decide(
  overrides: Partial<Parameters<typeof shouldAllowAnonymousLocalPrincipal>[0]> = {},
): boolean {
  return shouldAllowAnonymousLocalPrincipal({
    requireAuth: false,
    mcApiTokenConfigured: false,
    socketLoopback: true,
    browser: browser(),
    ...overrides,
  });
}

describe('shouldAllowAnonymousLocalPrincipal', () => {
  it('denies a LAN client that spoofs a same-origin Origin, with and without MC_API_TOKEN', () => {
    const spoofed = browser({
      host: 'localhost:3000',
      origin: 'http://localhost:3000',
      secFetchSite: 'same-origin',
    });

    expect(decide({ socketLoopback: false, browser: spoofed })).toBe(false);
    expect(decide({ socketLoopback: false, mcApiTokenConfigured: true, browser: spoofed })).toBe(
      false,
    );
  });

  it('denies CSRF from an evil origin aimed at localhost', () => {
    const csrf = browser({
      host: 'localhost:3000',
      origin: 'https://evil.example',
      secFetchSite: 'cross-site',
    });

    expect(decide({ browser: csrf })).toBe(false);
    expect(decide({ mcApiTokenConfigured: true, browser: csrf })).toBe(false);
    // Origin alone is enough, even without Fetch Metadata.
    expect(decide({ browser: browser({ origin: 'https://evil.example' }) })).toBe(false);
  });

  it('denies DNS rebinding where the Host name is attacker-controlled', () => {
    const rebinding = browser({
      host: 'evil.example:3000',
      origin: 'http://evil.example:3000',
      secFetchSite: 'same-origin',
    });

    expect(decide({ browser: rebinding })).toBe(false);
    expect(decide({ mcApiTokenConfigured: true, browser: rebinding })).toBe(false);
  });

  it('allows same-origin browser UI on loopback', () => {
    const ui = browser({ origin: 'http://localhost:3000', secFetchSite: 'same-origin' });
    const getWithReferer = browser({ referer: 'http://localhost:3000/chat' });

    expect(decide({ browser: ui })).toBe(true);
    expect(decide({ mcApiTokenConfigured: true, browser: ui })).toBe(true);
    expect(decide({ browser: getWithReferer })).toBe(true);
    expect(decide({ mcApiTokenConfigured: true, browser: getWithReferer })).toBe(true);
  });

  it('allows a loopback curl without Origin only when MC_API_TOKEN is not set', () => {
    const curl = browser({ host: '127.0.0.1:3000' });

    expect(decide({ browser: curl })).toBe(true);
    expect(decide({ mcApiTokenConfigured: true, browser: curl })).toBe(false);
  });

  it('denies anonymous access whenever REQUIRE_AUTH is true', () => {
    const ui = browser({ origin: 'http://localhost:3000', secFetchSite: 'same-origin' });

    expect(decide({ requireAuth: true, browser: ui })).toBe(false);
    expect(decide({ requireAuth: true, browser: browser() })).toBe(false);
  });

  it('denies a missing Host header and non-loopback Host names', () => {
    expect(decide({ browser: browser({ host: null }) })).toBe(false);
    expect(decide({ browser: browser({ host: 'mc.example.com' }) })).toBe(false);
  });

  it('denies cross-site and same-site fetch metadata even with a loopback Host', () => {
    expect(decide({ browser: browser({ secFetchSite: 'cross-site' }) })).toBe(false);
    expect(
      decide({
        browser: browser({ origin: 'http://localhost:4000', secFetchSite: 'same-site' }),
      }),
    ).toBe(false);
  });
});

describe('isLoopbackAddress', () => {
  it.each(['127.0.0.1', '127.8.9.10', '127.255.255.255', '::1', '::ffff:127.0.0.1'])(
    'treats %s as loopback',
    (address) => {
      expect(isLoopbackAddress(address)).toBe(true);
    },
  );

  it.each([
    '192.168.1.50',
    '10.0.0.1',
    '172.17.0.1',
    '::ffff:192.168.1.50',
    '0.0.0.0',
    '::',
    'fe80::1',
    '127.0.0.256',
    '1270.0.0.1',
    '',
  ])('treats %s as not loopback', (address) => {
    expect(isLoopbackAddress(address)).toBe(false);
  });

  it('treats a missing address as not loopback', () => {
    expect(isLoopbackAddress(null)).toBe(false);
  });
});

describe('isLoopbackHostHeader', () => {
  it.each([
    'localhost',
    'localhost:3000',
    'LOCALHOST:3000',
    '127.0.0.1:3000',
    '[::1]:3000',
    '[::1]',
    '::1',
    'app.localhost:3000',
  ])('accepts loopback Host %s', (host) => {
    expect(isLoopbackHostHeader(host)).toBe(true);
  });

  it.each([
    'evil.example',
    'evil.example:3000',
    'localhost.evil.example',
    'localhost:3000@evil.example',
    'localhost@evil.example',
    'localhost.',
    '127.0.0.2',
    '0.0.0.0:3000',
    '',
  ])('rejects non-loopback Host %s', (host) => {
    expect(isLoopbackHostHeader(host)).toBe(false);
  });

  it('rejects a missing Host header', () => {
    expect(isLoopbackHostHeader(null)).toBe(false);
  });
});

describe('isCrossSiteBrowserRequest and isSameOriginBrowserRequest', () => {
  it('treats matching Origin, Referer or same-origin metadata as same-origin', () => {
    expect(isCrossSiteBrowserRequest(browser({ origin: 'http://localhost:3000' }))).toBe(false);
    expect(isSameOriginBrowserRequest(browser({ origin: 'http://localhost:3000' }))).toBe(true);
    expect(isSameOriginBrowserRequest(browser({ referer: 'http://localhost:3000/a' }))).toBe(true);
    expect(isSameOriginBrowserRequest(browser({ secFetchSite: 'same-origin' }))).toBe(true);
  });

  it('treats an opaque "null" Origin as cross-site', () => {
    expect(isCrossSiteBrowserRequest(browser({ origin: 'null' }))).toBe(true);
    expect(isSameOriginBrowserRequest(browser({ origin: 'null' }))).toBe(false);
  });

  it('treats a mismatching Referer as cross-site', () => {
    expect(isCrossSiteBrowserRequest(browser({ referer: 'https://evil.example/x' }))).toBe(true);
  });

  it('treats cross-site and same-site fetch metadata as cross-site', () => {
    expect(isCrossSiteBrowserRequest(browser({ secFetchSite: 'cross-site' }))).toBe(true);
    expect(isCrossSiteBrowserRequest(browser({ secFetchSite: 'same-site' }))).toBe(true);
  });

  it('treats a request without browser headers as neither cross-site nor same-origin', () => {
    expect(isCrossSiteBrowserRequest(browser())).toBe(false);
    expect(isSameOriginBrowserRequest(browser())).toBe(false);
  });
});

describe('applyClientLoopbackMarker', () => {
  it('discards a spoofed marker from a non-loopback peer', () => {
    const headers: Record<string, string | string[] | undefined> = {
      [CLIENT_LOOPBACK_HEADER]: '1',
    };

    applyClientLoopbackMarker(headers, LAN_PEER);

    expect(headers[CLIENT_LOOPBACK_HEADER]).toBeUndefined();
  });

  it('sets the marker for loopback peers and overrides a client-sent value', () => {
    const plain: Record<string, string | string[] | undefined> = {};
    const spoofedZero: Record<string, string | string[] | undefined> = {
      [CLIENT_LOOPBACK_HEADER]: '0',
    };
    const mapped: Record<string, string | string[] | undefined> = {};

    applyClientLoopbackMarker(plain, LOOPBACK_PEER);
    applyClientLoopbackMarker(spoofedZero, LOOPBACK_PEER);
    applyClientLoopbackMarker(mapped, '::ffff:127.0.0.1');

    expect(plain[CLIENT_LOOPBACK_HEADER]).toBe('1');
    expect(spoofedZero[CLIENT_LOOPBACK_HEADER]).toBe('1');
    expect(mapped[CLIENT_LOOPBACK_HEADER]).toBe('1');
  });

  it('leaves the marker unset when the peer address is unknown', () => {
    const headers: Record<string, string | string[] | undefined> = {};

    applyClientLoopbackMarker(headers, null);

    expect(headers[CLIENT_LOOPBACK_HEADER]).toBeUndefined();
  });
});

describe('applyLoopbackMarkerForTopology', () => {
  it('derives the marker from the socket peer when this process owns the listener', () => {
    const loopback: Record<string, string | string[] | undefined> = {};
    const lan: Record<string, string | string[] | undefined> = {
      [CLIENT_LOOPBACK_HEADER]: '1',
    };

    applyLoopbackMarkerForTopology(loopback, LOOPBACK_PEER, false);
    applyLoopbackMarkerForTopology(lan, LAN_PEER, false);

    expect(loopback[CLIENT_LOOPBACK_HEADER]).toBe('1');
    // A spoofed value must still be discarded in the direct topology.
    expect(lan[CLIENT_LOOPBACK_HEADER]).toBeUndefined();
  });

  // Regression test. Behind the gateway the local peer is always the gateway,
  // which is loopback. Re-deriving the marker here would mark every request as
  // loopback and invert the documented "missing marker fails closed" invariant.
  it('keeps a forwarded marker untouched and does not invent one', () => {
    const forwardedLoopback: Record<string, string | string[] | undefined> = {
      [CLIENT_LOOPBACK_HEADER]: '1',
    };
    const nothingForwarded: Record<string, string | string[] | undefined> = {};

    applyLoopbackMarkerForTopology(forwardedLoopback, LOOPBACK_PEER, true);
    applyLoopbackMarkerForTopology(nothingForwarded, LOOPBACK_PEER, true);

    expect(forwardedLoopback[CLIENT_LOOPBACK_HEADER]).toBe('1');
    // Must stay absent so the policy check fails closed.
    expect(nothingForwarded[CLIENT_LOOPBACK_HEADER]).toBeUndefined();
  });

  it('drops a marker sent by a non-loopback peer even behind the gateway', () => {
    const spoofed: Record<string, string | string[] | undefined> = {
      [CLIENT_LOOPBACK_HEADER]: '1',
    };

    applyLoopbackMarkerForTopology(spoofed, LAN_PEER, true);

    expect(spoofed[CLIENT_LOOPBACK_HEADER]).toBeUndefined();
  });
});
