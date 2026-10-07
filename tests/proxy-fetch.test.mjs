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
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

  it('declines a plain http target — the tunnel is TLS-only and would crash the process', () => {
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:1');
    // An http gateway (LiteLLM on localhost, say) must keep native fetch: taking
    // the tunnel makes https.request throw ERR_INVALID_PROTOCOL inside the
    // CONNECT callback, which no caller try/catch sees.
    expect(httpConnectProxyFor('http://127.0.0.1:4000/v1/messages')).toBeNull();
    expect(httpConnectProxyFor('https://gw.example.com/v1/messages')).toBe('http://127.0.0.1:1');
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

  it('rejects (never throws) for a non-https target instead of crashing the process', async () => {
    // Second lock on the http-target door: even a direct caller gets a rejection
    // it can catch, not an ERR_INVALID_PROTOCOL thrown from a socket callback.
    await expect(
      onceViaConnectProxy('http://127.0.0.1:1', 'http://a.test/x', { timeout: 2000 }),
    ).rejects.toThrow(/https targets only/);
  });
});

// #33 made the target a user-set ANTHROPIC_BASE_URL, so it can be an IP literal
// (`https://10.0.0.5:8443`). Node refuses an IP as the TLS servername
// (ERR_INVALID_ARG_VALUE: SNI carries DNS names only), so every call through
// the tunnel failed and fell back to the CLI while doctor reported the gateway
// reachable. The trust store has to hold the fixture cert, so each call runs in
// a child with NODE_EXTRA_CA_CERTS; the servers stay in this process.
const HAS_OPENSSL = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const HAS_IPV6_LOOPBACK = Object.values(networkInterfaces())
  .flat()
  .some((a) => a?.address === '::1');

describe.skipIf(!HAS_OPENSSL)('onceViaConnectProxy (IP-literal https target through a real tunnel)', () => {
  const PROXY_FETCH_URL = pathToFileURL(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'proxy-fetch.mjs'),
  ).href;
  let dir, proxy, proxyUrl;
  const servers = [];
  const certs = {};

  function makeCert(name, san) {
    const key = join(dir, `${name}.key`);
    const cert = join(dir, `${name}.pem`);
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2'].concat([
        '-subj',
        '/CN=localhost',
        '-addext',
        `subjectAltName=${san}`,
      ]),
      { stdio: 'ignore' },
    );
    return { key: readFileSync(key), cert: readFileSync(cert), certPath: cert };
  }

  function listen(server, host = '127.0.0.1') {
    servers.push(server);
    return new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)));
  }

  /**
   * onceViaConnectProxy in a child that trusts `certPath`. Resolves {status, body} or {error},
   * plus `hung: true` when the child had to be killed: a settled call whose tunnel socket was
   * never closed holds the process open (120 s here, the server's handshake timeout).
   */
  function callInChild(certPath, target) {
    const script = `
      const { onceViaConnectProxy } = await import(process.argv[1]);
      try {
        const r = await onceViaConnectProxy(process.argv[2], process.argv[3], { timeout: 5000 });
        console.log(JSON.stringify({ status: r.status, body: r.text() }));
      } catch (e) {
        console.log(JSON.stringify({ error: e.code || e.message }));
      }`;
    return new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        ['--input-type=module', '-e', script, PROXY_FETCH_URL, proxyUrl, target],
        { env: { ...process.env, NODE_EXTRA_CA_CERTS: certPath }, timeout: 8000 },
        (err, stdout) => {
          if (err && !err.killed) return reject(err);
          const last = stdout.trim().split('\n').pop();
          const parsed = last ? JSON.parse(last) : {};
          resolve(err ? { ...parsed, hung: true } : parsed);
        },
      );
    });
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mem-proxy-ip-'));
    certs.ip = makeCert('ip', 'DNS:localhost,IP:127.0.0.1,IP:::1');
    certs.dnsOnly = makeCert('dns', 'DNS:localhost');
    for (const name of ['ip', 'dnsOnly']) {
      const { key, cert } = certs[name];
      certs[name].port = await listen(https.createServer({ key, cert }, (req, res) => res.end('gateway')));
    }
    if (HAS_IPV6_LOOPBACK) {
      const { key, cert } = certs.ip;
      certs.ip.port6 = await listen(
        https.createServer({ key, cert }, (req, res) => res.end('gateway')),
        '::1',
      );
    }
    // A real CONNECT proxy: dial the requested host:port and splice the sockets.
    proxy = http.createServer();
    proxy.on('connect', (req, client, head) => {
      const cut = req.url.lastIndexOf(':');
      const host = req.url.slice(0, cut).replace(/^\[|\]$/g, '');
      const upstream = net.connect(Number(req.url.slice(cut + 1)), host, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
    });
    proxyUrl = `http://127.0.0.1:${await listen(proxy)}`;
  });

  afterAll(() => {
    for (const s of servers) {
      s.closeAllConnections?.();
      s.close();
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('CONTROL: a DNS-name target already works through the tunnel', async () => {
    const r = await callInChild(certs.ip.certPath, `https://localhost:${certs.ip.port}/v1/messages`);
    expect(r).toEqual({ status: 200, body: 'gateway' });
  });

  it('reaches an IPv4-literal target — the IP is not sent as SNI', async () => {
    const r = await callInChild(certs.ip.certPath, `https://127.0.0.1:${certs.ip.port}/v1/messages`);
    expect(r).toEqual({ status: 200, body: 'gateway' });
  });

  it.skipIf(!HAS_IPV6_LOOPBACK)(
    'reaches an IPv6-literal target — brackets stripped for SNI and identity',
    async () => {
      const r = await callInChild(certs.ip.certPath, `https://[::1]:${certs.ip.port6}/v1/messages`);
      expect(r).toEqual({ status: 200, body: 'gateway' });
    },
  );

  it('still checks the certificate against the IP: a cert without that IP is refused', async () => {
    const r = await callInChild(
      certs.dnsOnly.certPath,
      `https://127.0.0.1:${certs.dnsOnly.port}/v1/messages`,
    );
    expect(r).toEqual({ error: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  });
});
