// lib/proxy-fetch.mjs — the HTTP CONNECT tunnel, extracted from haiku-client.
//
// Why this suite exists: the tunnel shipped inside haiku-client as two private
// functions with ZERO direct coverage (tests/haiku-client.test.mjs only clears
// the proxy env so the real tunnel doesn't hijack its fetch mocks). That blind
// spot is exactly why hook-update.mjs kept calling bare `fetch` for the whole
// auto-update path — nothing failed, because nothing looked. Behind a proxy
// (measured on the dev box 2026-08-19: direct egress HTTP 000, via proxy HTTP
// 200) that means the version check AND the release manifest/signature asset
// download silently never happen, and auto-update degrades to "permanently up
// to date". (Not the tarball: that goes through `curl`, which honours the proxy
// env natively. An earlier version of this comment claimed it did — pre-tag
// review NOTE 6.)
//
// Per the node-fetch-proxy-blindness skill: every suite that mocks fetch on a
// transport that switches on proxy env MUST neutralize those vars, or it tests
// a different code path on a developer machine that has them set.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import { httpConnectProxyFor, requestViaConnectProxy, onceViaConnectProxy } from '../lib/proxy-fetch.mjs';

const PROXY_ENV = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'];

describe('httpConnectProxyFor (transport selection)', () => {
  beforeEach(() => {
    for (const v of PROXY_ENV) vi.stubEnv(v, '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns null when no proxy var is set — callers keep native fetch', () => {
    expect(httpConnectProxyFor('https://openrouter.ai/x')).toBeNull();
  });

  it('prefers HTTPS_PROXY, then lowercase, then HTTP_PROXY', () => {
    vi.stubEnv('HTTP_PROXY', 'http://127.0.0.1:1');
    expect(httpConnectProxyFor('https://a.test/')).toBe('http://127.0.0.1:1');
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:2');
    expect(httpConnectProxyFor('https://a.test/')).toBe('http://127.0.0.1:2');
  });

  it('ignores a socks5 proxy — the CONNECT tunnel speaks HTTP only', () => {
    // ALL_PROXY=socks5://… is the common Clash/v2ray shape; taking it would
    // send an HTTP CONNECT into a SOCKS listener and hang.
    vi.stubEnv('HTTPS_PROXY', 'socks5://127.0.0.1:10808');
    expect(httpConnectProxyFor('https://a.test/')).toBeNull();
  });

  it('honours NO_PROXY for an exact host and a dot-suffix domain', () => {
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:1');
    vi.stubEnv('NO_PROXY', 'a.test, .internal.corp');
    expect(httpConnectProxyFor('https://a.test/x')).toBeNull();
    expect(httpConnectProxyFor('https://build.internal.corp/x')).toBeNull();
    expect(httpConnectProxyFor('https://b.test/x')).toBe('http://127.0.0.1:1');
  });

  it('returns null on an unparseable target instead of throwing', () => {
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:1');
    expect(httpConnectProxyFor('not a url')).toBeNull();
  });
});

describe('requestViaConnectProxy (redirect handling)', () => {
  const PROXY = 'http://127.0.0.1:1';
  const resp = (status, headers = {}) => ({
    ok: status < 300,
    status,
    headers,
    text: () => '',
    json: () => ({}),
    buffer: () => Buffer.alloc(0),
  });

  it('returns a non-redirect response untouched, with one transport call', async () => {
    const once = vi.fn(async () => resp(200));
    const r = await requestViaConnectProxy(PROXY, 'https://a.test/x', {}, { _once: once });
    expect(r.status).toBe(200);
    expect(once).toHaveBeenCalledTimes(1);
  });

  it('follows an absolute 302 — the GitHub asset → CDN hop auto-update needs', async () => {
    const once = vi
      .fn()
      .mockResolvedValueOnce(resp(302, { location: 'https://cdn.test/blob' }))
      .mockResolvedValueOnce(resp(200));
    const r = await requestViaConnectProxy(PROXY, 'https://github.com/a.tgz', {}, { _once: once });
    expect(r.status).toBe(200);
    expect(once.mock.calls[1][1]).toBe('https://cdn.test/blob');
  });

  it('resolves a RELATIVE location against the current url', async () => {
    const once = vi
      .fn()
      .mockResolvedValueOnce(resp(301, { location: '/moved/here' }))
      .mockResolvedValueOnce(resp(200));
    await requestViaConnectProxy(PROXY, 'https://a.test/deep/path', {}, { _once: once });
    expect(once.mock.calls[1][1]).toBe('https://a.test/moved/here');
  });

  it('stops at maxRedirects and returns the last response rather than looping', async () => {
    const once = vi.fn(async () => resp(302, { location: 'https://a.test/loop' }));
    const r = await requestViaConnectProxy(PROXY, 'https://a.test/x', { maxRedirects: 3 }, { _once: once });
    expect(r.status).toBe(302);
    expect(once).toHaveBeenCalledTimes(4); // initial + 3 follows
  });

  it('drops Authorization when a redirect crosses to another host', async () => {
    const once = vi
      .fn()
      .mockResolvedValueOnce(resp(302, { location: 'https://cdn.test/blob' }))
      .mockResolvedValueOnce(resp(200));
    await requestViaConnectProxy(
      PROXY,
      'https://github.com/a.tgz',
      { headers: { Authorization: 'Bearer secret-token', Accept: 'application/json' } },
      { _once: once },
    );
    const secondHeaders = once.mock.calls[1][2].headers;
    expect(secondHeaders.Authorization).toBeUndefined();
    expect(secondHeaders.Accept).toBe('application/json');
  });

  it('keeps Authorization on a SAME-host redirect', async () => {
    const once = vi
      .fn()
      .mockResolvedValueOnce(resp(302, { location: 'https://github.com/other' }))
      .mockResolvedValueOnce(resp(200));
    await requestViaConnectProxy(
      PROXY,
      'https://github.com/a.tgz',
      { headers: { Authorization: 'Bearer t' } },
      { _once: once },
    );
    expect(once.mock.calls[1][2].headers.Authorization).toBe('Bearer t');
  });

  it('does not replay a POST body after a redirect', async () => {
    const once = vi
      .fn()
      .mockResolvedValueOnce(resp(303, { location: 'https://a.test/done' }))
      .mockResolvedValueOnce(resp(200));
    await requestViaConnectProxy(
      PROXY,
      'https://a.test/x',
      { method: 'POST', body: '{"a":1}' },
      { _once: once },
    );
    expect(once.mock.calls[1][2].method).toBe('GET');
    expect(once.mock.calls[1][2].body).toBe('');
  });
});

describe('onceViaConnectProxy (CONNECT negotiation against a fake proxy)', () => {
  let server, port;
  afterEach(() => {
    if (server) {
      server.close();
      server = null;
    }
  });

  function startProxy(onConnect) {
    return new Promise((resolve) => {
      server = http.createServer();
      server.on('connect', onConnect);
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
      });
    });
  }

  it('rejects with the proxy status when CONNECT is refused (407 etc.)', async () => {
    await startProxy((req, socket) => {
      socket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      socket.end();
    });
    await expect(
      onceViaConnectProxy(`http://127.0.0.1:${port}`, 'https://a.test/x', { timeout: 3000 }),
    ).rejects.toThrow(/407/);
  });

  it('rejects on timeout when the proxy accepts but never answers', async () => {
    await startProxy(() => {
      /* swallow: never reply */
    });
    await expect(
      onceViaConnectProxy(`http://127.0.0.1:${port}`, 'https://a.test/x', { timeout: 300 }),
    ).rejects.toThrow(/timeout/i);
  });

  it('rejects (never hangs) when nothing is listening on the proxy port', async () => {
    // Port 1 on loopback: connection refused. A caller's try/catch must see a
    // rejection so it can degrade, exactly as a failed fetch would.
    await expect(
      onceViaConnectProxy('http://127.0.0.1:1', 'https://a.test/x', { timeout: 2000 }),
    ).rejects.toBeTruthy();
  });
});
