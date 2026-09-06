// lib/proxy-fetch.mjs — HTTPS over an HTTP CONNECT tunnel, using node: built-ins only.
//
// Node's global fetch (undici) does NOT honour HTTP(S)_PROXY, and undici's
// ProxyAgent is not importable without adding a dependency (this package ships
// three: @modelcontextprotocol/sdk, better-sqlite3, zod — a proxy shim is not
// worth a fourth). In an environment where external hosts are only reachable
// through a local proxy, a direct fetch hangs or dies instantly, so every
// network feature silently stops working.
//
// This lived as two private functions inside haiku-client.mjs (added for the
// OpenRouter path, memory #8757). It is a lib module now because it was needed
// in a SECOND place and nobody could see that: hook-update.mjs kept calling bare
// `fetch`, so on a proxy-bound machine the auto-update version check and the
// release download both failed silently and the plugin reported itself
// permanently up to date. Measured on the dev box 2026-08-19: direct egress to
// api.github.com / openrouter.ai = HTTP 000, the same requests through the proxy
// = HTTP 200.
//
// Zero behaviour change when no proxy is configured: httpConnectProxyFor returns
// null and callers keep native fetch.

import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

/**
 * The HTTP proxy that should carry `targetUrl`, or null to use native fetch.
 * Deliberately ignores socks5:// (ALL_PROXY on Clash/v2ray setups): an HTTP
 * CONNECT sent into a SOCKS listener does not fail fast, it hangs.
 * @param {string} targetUrl
 * @returns {string|null}
 */
export function httpConnectProxyFor(targetUrl) {
  const proxy =
    process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!proxy || !/^https?:\/\//.test(proxy)) return null; // socks5 ALL_PROXY not supported here
  try {
    const host = new URL(targetUrl).hostname;
    const noProxy = (process.env.NO_PROXY || process.env.no_proxy || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (noProxy.some((n) => n === host || (n.startsWith('.') && host.endsWith(n.slice(1))))) return null;
    return proxy;
  } catch {
    return null;
  }
}

/**
 * Proxy-Authorization header for a proxy URL that carries credentials, or {} when it does
 * not. R10 P2-14.
 *
 * redactProxyUrl below exists precisely because HTTP(S)_PROXY legitimately carries
 * `user:pass@` — yet neither CONNECT call site ever sent those credentials. Behind an
 * authenticating proxy every CONNECT came back 407, the caller treated it as unreachable
 * and silently fell back to spawning `claude -p` (about 10x slower), and doctor reported
 * "unreachable", which points at the network rather than at the missing header. The same
 * module carries auto-update, so that path degraded too.
 *
 * decodeURIComponent because a password with `@` or `:` MUST be percent-encoded in the URL
 * and the proxy expects the decoded bytes. The header value is a credential: it must never
 * be logged, and redactProxyUrl stays the only thing that produces printable proxy text.
 * @param {URL} p
 * @returns {Record<string,string>}
 */
function proxyAuthHeader(p) {
  if (!p.username) return {};
  const user = decodeURIComponent(p.username);
  const pass = decodeURIComponent(p.password || '');
  return { 'Proxy-Authorization': `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` };
}

/**
 * A proxy URL safe to print. HTTP(S)_PROXY legitimately carries `user:pass@`,
 * and this string reaches doctor's stdout and `doctor --json` — the text users
 * paste into bug reports. Host and port survive so the line stays diagnosable.
 * Never returns the input on the error path: echoing an unparseable value back
 * is how the leak would return through the defensive branch. (pre-tag review)
 * @param {string|null|undefined} proxy
 * @returns {string}
 */
export function redactProxyUrl(proxy) {
  if (!proxy || typeof proxy !== 'string') return '(unset)';
  try {
    const u = new URL(proxy);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '(unparseable proxy url)';
  }
}

/**
 * Does this proxy actually establish a tunnel to `host`? Opens a CONNECT,
 * checks for 200, closes. No TLS, no request, no credentials.
 *
 * A plain TCP connect to the proxy port is NOT this question: anything
 * listening there answers it yes — a SOCKS-only listener, a proxy that forbids
 * CONNECT, or whatever took the port after the proxy died. That gap made
 * doctor's provider check report a healthy provider against a socket that
 * could not carry one request. (pre-tag review)
 *
 * @param {string} proxy
 * @param {string} host target hostname
 * @param {{timeout?: number, port?: number}} [opts]
 * @returns {Promise<{reachable: boolean, error?: string}>} never rejects
 */
export function connectProbeViaProxy(proxy, host, { timeout = 4000, port = 443 } = {}) {
  return new Promise((resolve) => {
    let p;
    try {
      p = new URL(proxy);
    } catch {
      return resolve({ reachable: false, error: 'unparseable proxy url' });
    }
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const req = http.request({
      host: p.hostname,
      port: Number(p.port) || 80,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: { Host: `${host}:${port}`, ...proxyAuthHeader(p) },
    });
    req.setTimeout(timeout, () => {
      req.destroy();
      done({ reachable: false, error: 'timeout' });
    });
    req.on('connect', (res, socket) => {
      socket.destroy();
      done(
        res.statusCode === 200
          ? { reachable: true }
          : { reachable: false, error: `proxy CONNECT ${res.statusCode}` },
      );
    });
    // A listener that accepts TCP then closes (not a proxy) lands here, as does
    // a refused connection. Both are "no tunnel", which is the whole question.
    req.on('error', (e) => done({ reachable: false, error: e.code || e.message }));
    req.on('close', () => done({ reachable: false, error: 'closed without CONNECT response' }));
    req.end();
  });
}

/**
 * ONE request over a freshly-opened CONNECT tunnel — no redirect handling.
 * fetch-compatible subset: resolves { ok, status, headers, text(), json(),
 * buffer() }; REJECTS on connect/timeout/socket error so a caller's try/catch
 * degrades exactly as it would for a failed fetch.
 *
 * The body is collected as Buffers (not a utf8 string) so the same primitive
 * serves the JSON call sites and the release manifest/signature asset download.
 *
 * @param {string} proxy proxy origin, e.g. http://127.0.0.1:10808
 * @param {string} url absolute https:// target
 * @param {{method?:string, headers?:object, body?:string|Buffer, timeout?:number}} [opts]
 */
export function onceViaConnectProxy(
  proxy,
  url,
  { method = 'GET', headers = {}, body = '', timeout = 20000 } = {},
) {
  return new Promise((resolve, reject) => {
    let p, t;
    try {
      p = new URL(proxy);
      t = new URL(url);
    } catch (e) {
      return reject(e);
    }
    const port = Number(t.port) || 443;
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(overall);
      fn(arg);
    };
    // `timeout` bounds the WHOLE call, not each phase. Two per-phase
    // socket timers made a 1000ms budget reject at 2008ms — every caller's
    // network deadline was silently double what it asked for. Recomputing each
    // phase's timer from a deadline did NOT fix it: a TLS socket wrapping an
    // already-connected socket never completes its handshake here, and
    // ClientRequest.setTimeout arms against socket events that then never come.
    // So the bound is an explicit timer rather than a claim about when Node
    // arms its own. unref'd: a background worker must not be held open by it.
    // (pre-tag review)
    const deadline = Date.now() + timeout;
    const remaining = () => Math.max(1, deadline - Date.now());
    const sockets = [];
    const overall = setTimeout(() => {
      for (const s of sockets) {
        try {
          s.destroy();
        } catch {
          /* already gone */
        }
      }
      finish(reject, new Error('proxy request timeout'));
    }, timeout);
    if (typeof overall.unref === 'function') overall.unref();
    const connReq = http.request({
      host: p.hostname,
      port: Number(p.port) || 80,
      method: 'CONNECT',
      path: `${t.hostname}:${port}`,
      headers: { Host: `${t.hostname}:${port}`, ...proxyAuthHeader(p) },
    });
    connReq.setTimeout(remaining(), () => connReq.destroy(new Error('proxy CONNECT timeout')));
    connReq.on('error', (e) => finish(reject, e));
    connReq.on('socket', (s) => sockets.push(s));
    connReq.on('connect', (res, socket) => {
      sockets.push(socket);
      if (res.statusCode !== 200) {
        socket.destroy();
        return finish(reject, new Error(`proxy CONNECT ${res.statusCode}`));
      }
      const req = https.request(
        url,
        { method, headers, createConnection: () => tls.connect({ socket, servername: t.hostname }) },
        (resp) => {
          const chunks = [];
          resp.on('data', (c) => chunks.push(Buffer.from(c)));
          resp.on('end', () => {
            const buf = Buffer.concat(chunks);
            finish(resolve, {
              ok: resp.statusCode >= 200 && resp.statusCode < 300,
              status: resp.statusCode,
              headers: resp.headers,
              buffer: () => buf,
              text: () => buf.toString('utf8'),
              json: () => JSON.parse(buf.toString('utf8')),
            });
          });
        },
      );
      req.setTimeout(remaining(), () => req.destroy(new Error('proxy request timeout')));
      req.on('error', (e) => finish(reject, e));
      req.end(body);
    });
    connReq.end();
  });
}

/**
 * onceViaConnectProxy + redirect following. Native fetch follows redirects by
 * default, so a call site swapped from fetch to the tunnel needs this or the
 * GitHub release asset (302 github.com → objects.githubusercontent.com) comes
 * back as an unusable 302 body.
 *
 * Two safety rules the loop enforces, both of which fetch also applies:
 *   • Authorization is dropped when the hop crosses to a different host — a
 *     redirect must not be able to walk a credential to another origin.
 *   • The body is not replayed; a redirected request continues as a bodiless
 *     GET (fetch's behaviour for 301/302/303).
 *
 * @param {string} proxy
 * @param {string} url
 * @param {{method?:string, headers?:object, body?:string|Buffer, timeout?:number, maxRedirects?:number}} [opts]
 * @param {{_once?: Function}} [seams] injectable transport (tests)
 */
export async function requestViaConnectProxy(proxy, url, opts = {}, { _once = onceViaConnectProxy } = {}) {
  const { maxRedirects = 5, ...rest } = opts;
  let current = url;
  let next = { method: 'GET', headers: {}, body: '', timeout: 20000, ...rest };
  // `timeout` is the budget for the CHAIN, not per hop. Native fetch aborts the
  // whole redirect sequence on one signal; giving each hop a fresh full budget
  // made a 3s caller worst-case ~18s across 6 hops. (pre-tag review NOTE 7)
  const chainDeadline = Date.now() + (next.timeout || 20000);
  for (let hop = 0; ; hop++) {
    next = { ...next, timeout: Math.max(1, chainDeadline - Date.now()) };
    const res = await _once(proxy, current, next);
    const location = res.status >= 300 && res.status < 400 && res.headers && res.headers.location;
    if (!location || hop >= maxRedirects) return res;
    const target = new URL(location, current);
    const sameHost = target.hostname === new URL(current).hostname;
    const headers = { ...next.headers };
    if (!sameHost) {
      delete headers.Authorization;
      delete headers.authorization;
    }
    next = { ...next, method: 'GET', body: '', headers };
    current = target.toString();
  }
}

/** GET convenience wrapper — the shape hook-update's two call sites need. */
export function getViaConnectProxy(proxy, url, { headers = {}, timeout = 20000, maxRedirects = 5 } = {}) {
  return requestViaConnectProxy(proxy, url, { method: 'GET', headers, timeout, maxRedirects });
}

/**
 * POST convenience wrapper. Kept for the OpenRouter call site, whose contract
 * predates this module: single request, NO redirect following (the API does not
 * redirect, and silently re-issuing a prompt POST as a GET would be worse than
 * surfacing the status).
 */
export function postViaConnectProxy(proxy, url, { headers = {}, body = '', timeout = 20000 } = {}) {
  return onceViaConnectProxy(proxy, url, { method: 'POST', headers, body, timeout });
}
