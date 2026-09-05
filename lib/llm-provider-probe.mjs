// lib/llm-provider-probe.mjs — "is the configured LLM provider actually usable?"
//
// Every keyed-provider dispatcher in haiku-client.mjs degrades to `claude -p`
// when the API call fails, and says so with one debugLog('WARN') that no surface
// reads. That is the right RUNTIME behaviour — a memory hook must never block on
// a provider outage — but it means a permanently broken provider is invisible.
//
// Observed 2026-08-19 on the dev box: OPENROUTER_API_KEY set, every call failing
// at the socket (a local firewall denied the node binary's egress), doctor
// reporting 21/21 green with no mention of the provider. Cost of the silence:
// 13.5s per background LLM call instead of 1.4s, for weeks.
//
// Scope: TRANSPORT only. A rejected key answers HTTP 401 — loud, and it costs a
// real request plus shipping the key to learn. Unreachability is the silent
// class, and one socket open/close answers it.

import net from 'node:net';
import { httpConnectProxyFor, connectProbeViaProxy, redactProxyUrl } from './proxy-fetch.mjs';

const PROVIDER_HOST = { api: 'api.anthropic.com', openrouter: 'openrouter.ai' };

/**
 * Open and immediately close a TCP connection. No TLS, no request, no key.
 * @param {string} host
 * @param {{port?: number, timeout?: number}} [opts]
 * @returns {Promise<{reachable: boolean, error?: string}>} never rejects
 */
export function tcpReachable(host, { port = 443, timeout = 4000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const socket = net.connect({ host, port });
    socket.setTimeout(timeout, () => {
      socket.destroy();
      done({ reachable: false, error: 'timeout' });
    });
    socket.on('connect', () => {
      socket.destroy();
      done({ reachable: true });
    });
    socket.on('error', (e) => {
      socket.destroy();
      done({ reachable: false, error: e.code || e.message });
    });
  });
}

/**
 * One doctor line about the LLM provider.
 *
 * Mode detection is duplicated from haiku-client's detectMode ON PURPOSE: that
 * one memoizes into a module-level `_mode` for the life of the process, which is
 * correct for a worker and wrong for a diagnostic. The precedence order is the
 * shared contract and must not drift — ANTHROPIC_API_KEY, then OPENROUTER_API_KEY,
 * then the CLI.
 *
 * Two seams, not one: the proxied and direct paths ask different questions of
 * different endpoints, so a single injected probe would have to switch on its
 * own arguments — the shape that hides which path a test actually exercised.
 *
 * @param {{_probe?: Function, _proxyProbe?: Function}} [seams]
 * @returns {Promise<{mode: string, level: 'ok'|'warn', message: string}>}
 */
export async function llmProviderStatus({ _probe = tcpReachable, _proxyProbe = connectProbeViaProxy } = {}) {
  const mode = process.env.ANTHROPIC_API_KEY ? 'api' : process.env.OPENROUTER_API_KEY ? 'openrouter' : 'cli';

  if (mode === 'cli') {
    return {
      mode,
      level: 'ok',
      message: 'LLM provider: claude CLI (no ANTHROPIC_API_KEY / OPENROUTER_API_KEY set)',
    };
  }

  const host = PROVIDER_HOST[mode];
  const proxy = httpConnectProxyFor(`https://${host}/`);
  // Report the hop actually exercised. When a proxy is configured the request
  // path is node → proxy → host, so probing the host directly would answer a
  // question the product never asks — and on a machine where only the proxy is
  // permitted, it would answer it wrong.
  // Redacted: HTTP(S)_PROXY legitimately carries user:pass@ and this string is
  // printed and serialized into `doctor --json`. (pre-tag review)
  const via = proxy ? `via proxy ${redactProxyUrl(proxy)}` : 'direct';

  let result;
  try {
    // Through a proxy the question is "does a tunnel open", not "is the port
    // occupied": a plain TCP connect passes against a SOCKS-only listener or a
    // proxy that forbids CONNECT, and doctor would then certify a dead
    // provider. (pre-tag review)
    result = proxy ? await _proxyProbe(proxy, host, { timeout: 4000 }) : await _probe(host, { port: 443 });
  } catch (e) {
    result = { reachable: false, error: e?.message || String(e) };
  }

  if (result?.reachable) {
    return { mode, level: 'ok', message: `LLM provider: ${mode} key set, ${host} reachable (${via})` };
  }
  return {
    mode,
    level: 'warn',
    // Name the consequence, not just the probe: "unreachable" alone reads as
    // cosmetic, and the actual cost (every background call silently falling back
    // to a ~10x slower path) is the reason anyone should care.
    message:
      `LLM provider: ${mode} key set but unreachable ${via} (${result?.error || 'unknown'}) — ` +
      'every background LLM call fails and silently falls back to the claude CLI (~10x slower); ' +
      'check egress/proxy for this node binary',
  };
}
