// doctor must be able to answer "is the configured LLM provider actually usable?"
//
// The gap this closes, measured 2026-08-19: with OPENROUTER_API_KEY set and every
// keyed call failing at the socket (a local firewall denied the node binary's
// egress), doctor reported 21/21 checks and zero mention of the provider. The
// product degraded to `claude -p` — 13.5s per background call against 1.4s via
// the API — for weeks, and NOTHING anywhere said so: the fallback logs one
// debugLog('WARN') that no surface reads.
//
// The probe deliberately checks TRANSPORT, not credentials. A bad key answers
// HTTP 401 — loud, self-explanatory, and it costs a request to learn. An
// unreachable host is the silent class, it is what actually happened, and it is
// answerable with a socket open and close.
import { describe, it, expect, afterEach, vi } from 'vitest';
import net from 'node:net';
import { llmProviderStatus } from '../lib/llm-provider-probe.mjs';

const PROXY_ENV = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];

describe('llmProviderStatus', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function noProxy() {
    for (const v of PROXY_ENV) vi.stubEnv(v, '');
  }

  it('reports the CLI provider without probing anything when no key is set', async () => {
    noProxy();
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENROUTER_API_KEY', '');
    const probe = vi.fn();
    const s = await llmProviderStatus({ _probe: probe });
    expect(s.mode).toBe('cli');
    expect(s.level).toBe('ok');
    expect(probe).not.toHaveBeenCalled();
    expect(s.message).toMatch(/claude CLI/);
  });

  it('probes api.anthropic.com when ANTHROPIC_API_KEY is set', async () => {
    noProxy();
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    const probe = vi.fn(async () => ({ reachable: true }));
    const s = await llmProviderStatus({ _probe: probe });
    expect(s.mode).toBe('api');
    expect(probe.mock.calls[0][0]).toBe('api.anthropic.com');
    expect(s.level).toBe('ok');
  });

  it('probes openrouter.ai when only OPENROUTER_API_KEY is set', async () => {
    noProxy();
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENROUTER_API_KEY', 'or-test');
    const probe = vi.fn(async () => ({ reachable: true }));
    const s = await llmProviderStatus({ _probe: probe });
    expect(s.mode).toBe('openrouter');
    expect(probe.mock.calls[0][0]).toBe('openrouter.ai');
  });

  it('WARNS, naming the silent fallback, when the configured provider is unreachable', async () => {
    noProxy();
    vi.stubEnv('OPENROUTER_API_KEY', 'or-test');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const probe = vi.fn(async () => ({ reachable: false, error: 'ECONNABORTED' }));
    const s = await llmProviderStatus({ _probe: probe });
    expect(s.level).toBe('warn');
    // The message has to say what the user LOSES, not just that a probe failed —
    // "openrouter.ai unreachable" alone reads as cosmetic.
    expect(s.message).toMatch(/ECONNABORTED/);
    expect(s.message).toMatch(/fall(s|ing)? back|claude CLI/i);
  });

  it('reports which transport the probe used, so a proxy misconfig is visible', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'or-test');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:10808');
    const probe = vi.fn(async () => ({ reachable: true }));
    const proxyProbe = vi.fn(async () => ({ reachable: true }));
    const s = await llmProviderStatus({ _probe: probe, _proxyProbe: proxyProbe });
    // Proxied path must exercise the CONNECT probe against the proxy AND name
    // the provider host — a direct TCP probe here is the false-green shape the
    // pre-tag review found.
    expect(probe).not.toHaveBeenCalled();
    expect(proxyProbe.mock.calls[0][0]).toBe('http://127.0.0.1:10808');
    expect(proxyProbe.mock.calls[0][1]).toBe('openrouter.ai');
    expect(s.message).toMatch(/proxy/i);
  });

  it('never throws when the probe itself blows up — doctor must always finish', async () => {
    noProxy();
    vi.stubEnv('OPENROUTER_API_KEY', 'or-test');
    const s = await llmProviderStatus({
      _probe: async () => {
        throw new Error('boom');
      },
    });
    expect(s.level).toBe('warn');
    expect(s.message).toMatch(/boom/);
  });
});

describe('tcpReachable (the real probe)', () => {
  it('resolves reachable for a listening socket and unreachable for a dead port', async () => {
    const { tcpReachable } = await import('../lib/llm-provider-probe.mjs');
    const server = net.createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
      expect((await tcpReachable('127.0.0.1', { port, timeout: 2000 })).reachable).toBe(true);
      const dead = await tcpReachable('127.0.0.1', { port: 1, timeout: 2000 });
      expect(dead.reachable).toBe(false);
      expect(typeof dead.error).toBe('string');
    } finally {
      server.close();
    }
  });
});
