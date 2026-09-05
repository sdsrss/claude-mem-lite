// Pre-tag review SHOULD-FIX 3: the Anthropic API paths were NOT proxy-aware.
//
// v3.73.0's whole thesis is that Node's global fetch ignores HTTP(S)_PROXY, so a
// bare fetch is a silent outage behind one. The OpenRouter call site had been
// tunnelled since #8757 — but `callModelAPI` and `callHaikuAPI`, i.e. both
// ANTHROPIC_API_KEY paths, still called bare fetch.
//
// The compounding part is the new doctor check: it reports "reachable via proxy"
// for `api` mode, because it probes the hop it BELIEVES the product uses. With
// ANTHROPIC_API_KEY + a proxy + blocked direct egress, doctor printed a green
// line while every background call went direct, failed, and silently fell back
// to the CLI — a green certificate over the exact failure it exists to surface.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../lib/proxy-fetch.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, httpConnectProxyFor: vi.fn(() => null), postViaConnectProxy: vi.fn() };
});

import { httpConnectProxyFor, postViaConnectProxy } from '../lib/proxy-fetch.mjs';
import { callModelJSON, callHaikuJSON, _resetMode } from '../haiku-client.mjs';

const PROXY = 'http://127.0.0.1:10808';
const REPLY = { content: [{ text: '{"ok":true}' }] };

describe('Anthropic API paths honour the proxy', () => {
  beforeEach(() => {
    _resetMode();
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubEnv('OPENROUTER_API_KEY', '');
    vi.mocked(httpConnectProxyFor).mockReset().mockReturnValue(null);
    vi.mocked(postViaConnectProxy).mockReset();
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    _resetMode();
  });

  for (const [name, call] of [
    ['callModelJSON', callModelJSON],
    ['callHaikuJSON', callHaikuJSON],
  ]) {
    it(`${name}: tunnels to api.anthropic.com when a proxy is configured`, async () => {
      vi.mocked(httpConnectProxyFor).mockReturnValue(PROXY);
      vi.mocked(postViaConnectProxy).mockResolvedValue({ ok: true, status: 200, json: () => REPLY });

      const out = await call('hello', 'haiku', { timeout: 5000, maxTokens: 50 });
      expect(out).toEqual({ ok: true });
      expect(postViaConnectProxy).toHaveBeenCalledTimes(1);
      expect(postViaConnectProxy.mock.calls[0][1]).toBe('https://api.anthropic.com/v1/messages');
      // The bare-fetch call is what the proxy branch must replace, not accompany.
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it(`${name}: still uses native fetch with no proxy configured (no regression)`, async () => {
      globalThis.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => REPLY });

      const out = await call('hello', 'haiku', { timeout: 5000, maxTokens: 50 });
      expect(out).toEqual({ ok: true });
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(postViaConnectProxy).not.toHaveBeenCalled();
    });

    it(`${name}: sends the api key over the tunnel, never in the proxy URL`, async () => {
      vi.mocked(httpConnectProxyFor).mockReturnValue(PROXY);
      vi.mocked(postViaConnectProxy).mockResolvedValue({ ok: true, status: 200, json: () => REPLY });

      await call('hello', 'haiku', { timeout: 5000, maxTokens: 50 });
      const opts = postViaConnectProxy.mock.calls[0][2];
      expect(opts.headers['x-api-key']).toBe('sk-test');
      expect(opts.headers['anthropic-version']).toBe('2023-06-01');
      expect(postViaConnectProxy.mock.calls[0][0]).toBe(PROXY);
    });
  }
});
