// D#250. A plain-http ANTHROPIC_BASE_URL is accepted only for a loopback host, on the
// premise that the request, x-api-key included, never leaves this machine. Node's opt-in
// NODE_USE_ENV_PROXY=1 broke that premise: native fetch hands an http:// URL to HTTP_PROXY
// unless Node's own NO_PROXY matcher exempts the host. Measured 2026-10-07 with a fake
// proxy and NO_PROXY=other.test: Node 26.8.1 sent the request to the proxy as a plain
// absolute-form POST, and Node 22.23.3 opened a CONNECT tunnel and wrote the same plaintext
// request into it. Either way the proxy reads the key, and a remote proxy then delivers the
// request to ITS loopback, not ours.
//
// The child process is the real call path (callModelJSON → callModelAPI) under a real env
// proxy; nothing is mocked, because the thing under test is which socket the runtime picks.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HAIKU_CLIENT = pathToFileURL(join(ROOT, 'haiku-client.mjs')).href;
// Not secret-shaped on purpose: this value is written to a fake proxy's log.
const FAKE_KEY = 'test-key-not-real';
const REPLY = JSON.stringify({ content: [{ text: '{"ok":true}' }] });

let proxy;
let gateway;
let sandbox;
const seen = { proxy: [], gateway: [] };

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

beforeAll(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'mem-envproxy-'));
  gateway = http.createServer((req, res) => {
    seen.gateway.push({ url: req.url, key: req.headers['x-api-key'] || null });
    res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
    res.end(REPLY);
  });
  // Answers both shapes Node uses: an absolute-form request (Node 26) and a CONNECT tunnel
  // carrying the plaintext request (Node 22). Each is recorded, then answered like the
  // gateway would be, so a leak shows up as a SUCCESSFUL call — the failure mode is silent.
  proxy = http.createServer((req, res) => {
    seen.proxy.push({ kind: 'request', url: req.url, key: req.headers['x-api-key'] || null });
    res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
    res.end(REPLY);
  });
  proxy.on('connect', (req, socket, head) => {
    seen.proxy.push({ kind: 'connect', url: req.url, key: null });
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    let buf = head.toString('latin1');
    socket.on('data', (d) => {
      buf += d.toString('latin1');
      if (!buf.includes('\r\n\r\n')) return;
      const key = /\r\nx-api-key:\s*([^\r\n]*)/i.exec(buf)?.[1] || null;
      seen.proxy.push({ kind: 'tunnelled-request', url: req.url, key });
      socket.end(
        `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${REPLY.length}\r\nconnection: close\r\n\r\n${REPLY}`,
      );
    });
    socket.on('error', () => {});
  });
  await listen(gateway);
  await listen(proxy);
});

afterAll(async () => {
  await new Promise((r) => proxy.close(r));
  await new Promise((r) => gateway.close(r));
  rmSync(sandbox, { recursive: true, force: true });
});

// One child per host spelling. It first asks the runtime whether env-proxy is live at all
// (a bare http.get through the global agent), so a runtime without NODE_USE_ENV_PROXY skips
// instead of passing vacuously, then makes the real call.
const CHILD = `
import http from 'node:http';
const [gatewayOrigin, haikuClient] = process.argv.slice(1);
await new Promise((resolve) => {
  const req = http.get(gatewayOrigin + '/premise', (res) => { res.resume(); res.on('end', resolve); });
  req.on('error', resolve);
  req.setTimeout(3000, () => { req.destroy(); resolve(); });
});
const { callModelJSON } = await import(haikuClient);
const out = await callModelJSON('hello', 'haiku', { timeout: 5000, maxTokens: 50 });
console.log(JSON.stringify(out));
process.exit(0);
`;

function runChild(gatewayOrigin) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD, gatewayOrigin, HAIKU_CLIENT], {
      env: {
        PATH: process.env.PATH,
        HOME: sandbox,
        CLAUDE_MEM_DIR: join(sandbox, 'data'),
        MEM_NO_AUTO_ADOPT: '1',
        // A failed direct leg must not reach a real `claude -p`.
        CLAUDE_CODE_PATH: join(sandbox, 'no-such-claude'),
        ANTHROPIC_API_KEY: FAKE_KEY,
        ANTHROPIC_BASE_URL: gatewayOrigin,
        NODE_USE_ENV_PROXY: '1',
        HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}`,
        HTTPS_PROXY: `http://127.0.0.1:${proxy.address().port}`,
        // The host is deliberately absent: the case where the leak happens.
        NO_PROXY: 'other.test',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr });
    });
  });
}

describe('a plain-http loopback gateway is reached directly under NODE_USE_ENV_PROXY', () => {
  for (const host of ['127.0.0.1', 'localhost']) {
    it(`${host}: the key goes to the gateway, never to HTTP_PROXY`, async (ctx) => {
      seen.proxy.length = 0;
      seen.gateway.length = 0;
      const origin = `http://${host}:${gateway.address().port}`;

      const r = await runChild(origin);

      // Premise: this runtime really routes the global agent through HTTP_PROXY (an
      // absolute-form request on both Node 22 and 26, so its url carries the path).
      if (!seen.proxy.some((e) => e.kind === 'request' && e.url.endsWith('/premise'))) {
        ctx.skip('this Node does not implement NODE_USE_ENV_PROXY for http.request');
        return;
      }
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toBe('{"ok":true}');
      // Everything the proxy saw besides the premise is the API call leaking: a plain
      // request, a CONNECT (its url is host:port) or what was written into the tunnel.
      expect(seen.proxy.filter((e) => !e.url.endsWith('/premise'))).toEqual([]);
      expect(seen.gateway).toEqual([{ url: '/v1/messages', key: FAKE_KEY }]);
    });
  }
});
