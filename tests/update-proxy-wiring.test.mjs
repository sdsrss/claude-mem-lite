// hook-update.mjs must route through the CONNECT tunnel when a proxy is configured.
//
// The defect this pins: the tunnel existed (added for OpenRouter, memory #8757)
// but lived as two PRIVATE functions inside haiku-client.mjs, so the auto-update
// path kept calling bare `fetch`. Node's fetch ignores HTTP(S)_PROXY, so on a
// proxy-bound machine the version check and the release download both failed
// silently — and "silently" is the whole problem: checkForUpdate swallows
// network errors by design, so the plugin reports itself permanently up to date.
// Measured on the dev box 2026-08-19: direct egress to api.github.com = HTTP 000,
// the same request through the proxy = HTTP 200.
//
// Both directions are asserted. A test that only proves "proxy is used when set"
// would pass an implementation that ALWAYS tunnels, which would break every user
// without a proxy.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';

// hook-update resolves STATE_DIR from DB_DIR at MODULE LOAD, and the 403/429 arm
// below calls saveState(). Without this, that arm wrote {"rateLimited":true}
// into the DEVELOPER'S REAL ~/.claude-mem-lite/runtime/update-state.json —
// verified: the file did not exist before this suite and appeared, with that
// content, after a run. Hoisted so the env is set before the import below.
const MEM_DIR = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'mem-proxy-wiring-'));
  process.env.CLAUDE_MEM_DIR = dir;
  return dir;
});

vi.mock('../lib/proxy-fetch.mjs', () => ({
  httpConnectProxyFor: vi.fn(() => null),
  getViaConnectProxy: vi.fn(),
  postViaConnectProxy: vi.fn(),
  onceViaConnectProxy: vi.fn(),
  requestViaConnectProxy: vi.fn(),
}));

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { httpConnectProxyFor, getViaConnectProxy } from '../lib/proxy-fetch.mjs';
import { fetchLatestRelease, fetchAssetBuffer } from '../hook-update.mjs';

afterAll(() => {
  rmSync(MEM_DIR, { recursive: true, force: true });
});

const PROXY = 'http://127.0.0.1:10808';
const RELEASE_BODY = {
  tag_name: 'v9.9.9',
  tarball_url: 'https://api.github.com/t',
  html_url: 'https://gh/r',
  assets: [],
};

function proxyResponse(payload, { status = 200, buffer = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {},
    json: () => payload,
    text: () => JSON.stringify(payload),
    buffer: () => buffer,
  };
}

describe('auto-update honours the proxy', () => {
  beforeEach(() => {
    vi.mocked(httpConnectProxyFor).mockReset().mockReturnValue(null);
    vi.mocked(getViaConnectProxy).mockReset();
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('version check: tunnels through the proxy and never touches bare fetch', async () => {
    vi.mocked(httpConnectProxyFor).mockReturnValue(PROXY);
    vi.mocked(getViaConnectProxy).mockResolvedValue(proxyResponse(RELEASE_BODY));

    const rel = await fetchLatestRelease();
    expect(rel?.version).toBe('9.9.9');
    expect(getViaConnectProxy).toHaveBeenCalledTimes(1);
    expect(getViaConnectProxy.mock.calls[0][1]).toContain('/releases/latest');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('version check: uses native fetch when NO proxy is configured (no regression)', async () => {
    globalThis.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => RELEASE_BODY });

    const rel = await fetchLatestRelease();
    expect(rel?.version).toBe('9.9.9');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(getViaConnectProxy).not.toHaveBeenCalled();
  });

  it('version check: a proxied 403 still routes to the rate-limit backoff', async () => {
    // Losing this mapping would turn a rate-limit into the 24h transient-failure
    // path — the exact regression the 403/429 branch exists to prevent.
    //
    // `toBeNull()` alone did NOT test that: the `if (!res.ok) return null`
    // fallthrough satisfies it too, so gating the branch on `!proxy` survived the
    // whole suite (pre-tag review finding 2). The state write is the observable
    // difference between the two paths, so assert THAT.
    vi.mocked(httpConnectProxyFor).mockReturnValue(PROXY);
    vi.mocked(getViaConnectProxy).mockResolvedValue(proxyResponse(null, { status: 403 }));
    const stateFile = join(MEM_DIR, 'runtime', 'update-state.json');
    rmSync(stateFile, { force: true });

    expect(await fetchLatestRelease()).toBeNull();

    expect(existsSync(stateFile), 'the proxied 403 must persist the rate-limit state').toBe(true);
    expect(JSON.parse(readFileSync(stateFile, 'utf8')).rateLimited).toBe(true);
  });

  it('version check: a proxy failure degrades to null, never throws', async () => {
    // checkForUpdate must stay silent on network failure; a rejection escaping
    // here would surface as a hook error on every SessionStart behind a proxy.
    vi.mocked(httpConnectProxyFor).mockReturnValue(PROXY);
    vi.mocked(getViaConnectProxy).mockRejectedValue(new Error('proxy CONNECT 407'));
    await expect(fetchLatestRelease()).resolves.toBeNull();
  });

  it('asset download: tunnels through the proxy and returns the bytes', async () => {
    vi.mocked(httpConnectProxyFor).mockReturnValue(PROXY);
    const payload = Buffer.from('tarball-bytes');
    vi.mocked(getViaConnectProxy).mockResolvedValue(proxyResponse(null, { buffer: payload }));

    const buf = await fetchAssetBuffer(
      'https://github.com/sdsrss/claude-mem-lite/releases/download/v1/a.tgz',
    );
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.toString()).toBe('tarball-bytes');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('asset download: keeps the github.com host lock on the PROXIED path too', async () => {
    // The host lock is a supply-chain guard: it must not be reachable-around by
    // simply having a proxy configured.
    vi.mocked(httpConnectProxyFor).mockReturnValue(PROXY);
    await expect(fetchAssetBuffer('https://evil.test/a.tgz')).rejects.toThrow(/rejected asset url/);
    expect(getViaConnectProxy).not.toHaveBeenCalled();
  });

  it('asset download: a non-2xx proxied response throws (never returns a partial buffer)', async () => {
    vi.mocked(httpConnectProxyFor).mockReturnValue(PROXY);
    vi.mocked(getViaConnectProxy).mockResolvedValue(
      proxyResponse(null, { status: 404, buffer: Buffer.alloc(0) }),
    );
    await expect(
      fetchAssetBuffer('https://github.com/sdsrss/claude-mem-lite/releases/download/v1/a.tgz'),
    ).rejects.toThrow(/404/);
  });
});
