// resolveAnthropicBaseUrl validated the PARSED value and returned the RAW text. Every consumer
// then re-parsed that text its own way: haiku-client decided "plain http" on a case-sensitive
// prefix and sent the key to HTTP_PROXY for `HTTP://127.0.0.1` (fixed in b59e0cec), and a value
// with a trailing control character (`http://127.0.0.1:4000\x01`) passed the resolver and doctor
// while every direct call threw building `raw + '/v1/messages'` (D#259). The resolver now returns
// the URL it validated, so every consumer reads the same parse.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { resolveAnthropicBaseUrl } from '../lib/anthropic-base-url.mjs';

function resolve(raw) {
  vi.stubEnv('ANTHROPIC_BASE_URL', raw);
  return resolveAnthropicBaseUrl();
}

describe('resolveAnthropicBaseUrl returns the URL it validated', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['HTTP://127.0.0.1:4000', 'http://127.0.0.1:4000'],
    ['ht\ttp://127.0.0.1:4000/', 'http://127.0.0.1:4000'],
    ['http://127.0.0.1:4000\x01', 'http://127.0.0.1:4000'],
    ['\x01http://localhost:4000', 'http://localhost:4000'],
    ['https://GW.Example.com:443/anthropic/', 'https://gw.example.com/anthropic'],
    ['https://gw.example.com:8443/anthropic', 'https://gw.example.com:8443/anthropic'],
  ])('%j -> %s', (raw, want) => {
    expect(resolve(raw)).toEqual({ url: want, configured: true, error: null });
  });

  it('every accepted spelling builds a request URL with the scheme, host and port the resolver checked', () => {
    const spellings = [
      'http://127.0.0.1:4000',
      'HTTP://127.0.0.1:4000',
      'http://127.0.0.1:4000\x01',
      'http://127.0.0.1:4000\x1f',
      'h\nttp://[::1]:4000',
      'http:\\\\localhost:4000',
      'http://foo.localhost:4000/',
      'https://aif-example.services.ai.azure.com/anthropic/',
      'https://gw.example.com:8443',
    ];
    for (const raw of spellings) {
      const r = resolve(raw);
      expect(r.error, raw).toBeNull();
      const parsedRaw = new URL(raw);
      const req = new URL(`${r.url}/v1/messages`);
      expect([req.protocol, req.host], JSON.stringify(raw)).toEqual([parsedRaw.protocol, parsedRaw.host]);
      expect(req.pathname.endsWith('/v1/messages'), raw).toBe(true);
    }
  });

  it('accepts plain http to each loopback form and refuses look-alikes', () => {
    for (const raw of [
      'http://localhost:4000',
      'http://foo.localhost:4000',
      'http://[::1]:4000',
      'http://127.0.0.9',
    ]) {
      expect(resolve(raw).error, raw).toBeNull();
    }
    for (const raw of [
      'http://localhost.evil.example:4000',
      'http://127.attacker.example',
      'http://[::2]:4000',
    ]) {
      expect(resolve(raw).error, raw).toMatch(/non-loopback/);
    }
  });
});
