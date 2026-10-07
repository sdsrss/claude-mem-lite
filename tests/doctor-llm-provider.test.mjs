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

const PROXY_ENV = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'];

describe('llmProviderStatus', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function noProxy() {
    for (const v of PROXY_ENV) vi.stubEnv(v, '');
    // Gateway override unset by default: the api host assertions below pin the
    // public default; the base-URL tests re-stub it explicitly.
    vi.stubEnv('ANTHROPIC_BASE_URL', '');
  }

  it('reports the CLI provider without probing anything when no key is set', async () => {
    noProxy();
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENROUTER_API_KEY', '');
    const probe = vi.fn();
    const s = await llmProviderStatus({ _probe: probe, _claudePath: process.execPath });
    expect(s.mode).toBe('cli');
    expect(s.level).toBe('ok');
    expect(probe).not.toHaveBeenCalled();
    expect(s.message).toMatch(/claude CLI/);
  });

  // E2E round 2026-09-29: with no key and CLAUDE_CODE_PATH=/nonexistent/claude, doctor still
  // printed "✓ LLM provider: claude CLI" while every background summary failed — and a failed
  // summary drops an episode that is not already notable. Still no network: a PATH lookup.
  it('warns when the claude CLI it would spawn does not resolve', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENROUTER_API_KEY', '');
    for (const p of ['/nonexistent/claude', 'no-such-claude-binary-xyz']) {
      const s = await llmProviderStatus({ _claudePath: p });
      expect(s.level, p).toBe('warn');
      expect(s.message).toMatch(/not found/);
      expect(s.message).toContain(p);
    }
  });

  it('finds a bare command name on PATH', async () => {
    const { dirname, basename } = await import('node:path');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENROUTER_API_KEY', '');
    vi.stubEnv('PATH', dirname(process.execPath));
    const s = await llmProviderStatus({ _claudePath: basename(process.execPath) });
    expect(s.level).toBe('ok');
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

  it('probes the ANTHROPIC_BASE_URL host when a gateway base URL is set', async () => {
    noProxy();
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://aif-example.services.ai.azure.com/anthropic');
    const probe = vi.fn(async () => ({ reachable: true }));
    const s = await llmProviderStatus({ _probe: probe });
    expect(probe.mock.calls[0][0]).toBe('aif-example.services.ai.azure.com');
    expect(probe.mock.calls[0][1]).toEqual({ port: 443 });
    expect(s.level).toBe('ok');
    expect(s.message).toContain('aif-example.services.ai.azure.com');
  });

  it('derives the port from a non-https gateway base URL', async () => {
    noProxy();
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'http://127.0.0.1:4000');
    const probe = vi.fn(async () => ({ reachable: true }));
    await llmProviderStatus({ _probe: probe });
    expect(probe.mock.calls[0][0]).toBe('127.0.0.1');
    expect(probe.mock.calls[0][1]).toEqual({ port: 4000 });
  });

  it('probes an IPv6-literal gateway without the URL brackets net.connect cannot resolve', async () => {
    noProxy();
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'http://[::1]:4000');
    const probe = vi.fn(async () => ({ reachable: true }));
    const s = await llmProviderStatus({ _probe: probe });
    // URL.hostname keeps the brackets; net.connect read '[::1]' as a DNS name (ENOTFOUND)
    // and doctor reported a working gateway unreachable.
    expect(probe.mock.calls[0][0]).toBe('::1');
    expect(probe.mock.calls[0][1]).toEqual({ port: 4000 });
    expect(s.level).toBe('ok');
  });

  it('keeps the brackets for an IPv6 gateway behind a proxy: CONNECT names [host]:port', async () => {
    for (const v of PROXY_ENV) vi.stubEnv(v, '');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubEnv('OPENROUTER_API_KEY', '');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://[2001:db8::1]:8443');
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:10808');
    const probe = vi.fn();
    const proxyProbe = vi.fn(async () => ({ reachable: true }));
    await llmProviderStatus({ _probe: probe, _proxyProbe: proxyProbe });
    expect(probe).not.toHaveBeenCalled();
    expect(proxyProbe.mock.calls[0][1]).toBe('[2001:db8::1]');
    expect(proxyProbe.mock.calls[0][2]).toEqual({ timeout: 4000, port: 8443 });
  });

  it('passes the gateway port to the proxy CONNECT probe, not the 443 default', async () => {
    for (const v of PROXY_ENV) vi.stubEnv(v, '');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubEnv('OPENROUTER_API_KEY', '');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://gw.example.com:8443');
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:10808');
    const probe = vi.fn();
    const proxyProbe = vi.fn(async () => ({ reachable: true }));
    const s = await llmProviderStatus({ _probe: probe, _proxyProbe: proxyProbe });
    expect(probe).not.toHaveBeenCalled();
    expect(proxyProbe.mock.calls[0][1]).toBe('gw.example.com');
    // The bug: the tunnel defaulted to 443 while requests went to 8443.
    expect(proxyProbe.mock.calls[0][2]).toEqual({ timeout: 4000, port: 8443 });
    expect(s.level).toBe('ok');
  });

  it('WARNS when ANTHROPIC_BASE_URL is set but unusable, instead of a green default', async () => {
    noProxy();
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'not a url');
    const probe = vi.fn(async () => ({ reachable: true }));
    const s = await llmProviderStatus({ _probe: probe });
    expect(s.level).toBe('warn');
    expect(s.message).toMatch(/ANTHROPIC_BASE_URL/);
    // Probing api.anthropic.com here is the false green this check exists to kill.
    expect(probe).not.toHaveBeenCalled();
  });

  it('WARNS on plain http to a non-loopback gateway (the key would go unencrypted)', async () => {
    noProxy();
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'http://gw.example.com:4000');
    const probe = vi.fn(async () => ({ reachable: true }));
    const s = await llmProviderStatus({ _probe: probe });
    expect(s.level).toBe('warn');
    expect(s.message).toMatch(/http/i);
    expect(probe).not.toHaveBeenCalled();
  });

  it('treats a blank base URL as unset (trim before the default)', async () => {
    noProxy();
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubEnv('ANTHROPIC_BASE_URL', '   ');
    const probe = vi.fn(async () => ({ reachable: true }));
    const s = await llmProviderStatus({ _probe: probe });
    expect(probe.mock.calls[0][0]).toBe('api.anthropic.com');
    expect(s.level).toBe('ok');
  });

  it('WARNS when the base URL carries a query string or fragment', async () => {
    // Otherwise the appended /v1/messages lands inside the query, not the path.
    noProxy();
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://gw.example.com/anthropic?route=x');
    const probe = vi.fn(async () => ({ reachable: true }));
    const s = await llmProviderStatus({ _probe: probe });
    expect(s.level).toBe('warn');
    expect(probe).not.toHaveBeenCalled();
  });

  it('WARNS on an http host that only looks loopback (127.attacker.example)', async () => {
    noProxy();
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'http://127.attacker.example:4000');
    const probe = vi.fn(async () => ({ reachable: true }));
    const s = await llmProviderStatus({ _probe: probe });
    expect(s.level).toBe('warn');
    expect(probe).not.toHaveBeenCalled();
  });

  it('WARNS when the base URL carries userinfo', async () => {
    // fetch() refuses a credentialed URL; without this the client falls back to
    // the CLI while doctor certifies the host.
    noProxy();
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://user:pass@gw.example.com');
    const probe = vi.fn(async () => ({ reachable: true }));
    const s = await llmProviderStatus({ _probe: probe });
    expect(s.level).toBe('warn');
    expect(probe).not.toHaveBeenCalled();
  });

  it('WARNS on a bare trailing "?" — URL.search is empty but the path is broken', async () => {
    noProxy();
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://gw.example.com/anthropic?');
    const probe = vi.fn(async () => ({ reachable: true }));
    const s = await llmProviderStatus({ _probe: probe });
    expect(s.level).toBe('warn');
    expect(probe).not.toHaveBeenCalled();
  });

  it('WARNS on a bare trailing "#" — URL.hash is empty but the path is broken', async () => {
    noProxy();
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://gw.example.com/anthropic#');
    const probe = vi.fn(async () => ({ reachable: true }));
    const s = await llmProviderStatus({ _probe: probe });
    expect(s.level).toBe('warn');
    expect(probe).not.toHaveBeenCalled();
  });

  it('WARNS on a non-http(s) scheme', async () => {
    noProxy();
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'ftp://gw.example.com');
    const probe = vi.fn(async () => ({ reachable: true }));
    const s = await llmProviderStatus({ _probe: probe });
    expect(s.level).toBe('warn');
    expect(probe).not.toHaveBeenCalled();
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
