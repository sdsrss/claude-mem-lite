// lib/hook-stdin.mjs — one bounded stdin reader for every hook entry point.
//
// Audit 2026-09-02 P1-9. Six hook processes read the host's JSON payload off stdin and they
// did it six ways, in two groups:
//
//   BOUNDED, three different calibers: hook.mjs (3 s / 256 KB / `{text, truncated}`),
//   scripts/user-prompt-search.js (2 s / 64 KB / bare string), scripts/pre-agent-inject.js
//   (1.5 s / 262144 / never rejects).
//
//   UNBOUNDED, three copies of `for await (const chunk of process.stdin) input += chunk`:
//   pre-tool-recall.js, pre-skill-bridge.js, post-tool-recall.js. No cap and no timeout.
//   That matters most on `PreToolUse:Write`, whose `tool_input.content` is the ENTIRE file
//   being written: writing a multi-megabyte file made pre-tool-recall buffer all of it and
//   `JSON.parse` all of it, to read `file_path`. The only bound was the host's own 3 s
//   fail-open — i.e. the hook silently did nothing, which is indistinguishable from the
//   hook having nothing to say.
//
// ZERO DEPENDENCIES, deliberately: the importers are latency-sensitive hook processes whose
// whole cost is module loading, and one of them (`pre-agent-inject.js`) exists to be the
// cheap default-off path. Nothing here imports from the repo.
//
// The calibers are NOT unified. Each caller passes its own, because those numbers are
// decisions about different payloads — a user prompt is not a tool response — and quietly
// giving one caller another's limits is a behaviour change wearing a refactor's clothes.
// What is shared is the mechanism: cap, timer, teardown, and the guarantee that the promise
// settles exactly once.

/** Default cap: matches the host's own full-payload tier. */
export const DEFAULT_STDIN_MAX_BYTES = 256 * 1024;
/** Default timeout: under the host's ~3 s fail-open, so we decide rather than get killed. */
export const DEFAULT_STDIN_TIMEOUT_MS = 3000;

/**
 * Read the hook payload from a stream, bounded in both bytes and time.
 *
 * @param {object}  [opts]
 * @param {number}  [opts.timeoutMs]  Give up after this long.
 * @param {number}  [opts.maxBytes]   Stop reading past this many characters.
 * @param {boolean} [opts.rejectOnTimeout=false]  `true` reproduces hook.mjs's contract, where
 *   a timeout drops the event rather than acting on a partial payload. `false` resolves with
 *   whatever arrived and `timedOut: true` — the right call for a path that is advisory and
 *   must never throw into a host hook.
 * @param {NodeJS.ReadableStream} [opts.stream=process.stdin]  Injectable for tests; nothing
 *   else about this module is observable without it.
 * @returns {Promise<{text: string, truncated: boolean, timedOut: boolean}>}
 */
export function readHookStdin({
  timeoutMs = DEFAULT_STDIN_TIMEOUT_MS,
  maxBytes = DEFAULT_STDIN_MAX_BYTES,
  rejectOnTimeout = false,
  stream = process.stdin,
} = {}) {
  return new Promise((resolve, reject) => {
    let data = '';
    // Every path below routes through settle(), and settle() is a no-op after the first
    // call. The hand-written copies each had to get this right on four separate paths
    // (cap hit, end, error, timer) and the `.destroy()` in the cap branch can itself emit
    // 'error' — so "resolve twice" and "resolve then reject" were both reachable shapes.
    let done = false;
    const settle = (fn, arg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { stream.destroy(); } catch { /* already gone */ }
      fn(arg);
    };

    const timer = setTimeout(() => {
      if (rejectOnTimeout) settle(reject, new Error('timeout'));
      else settle(resolve, { text: data, truncated: false, timedOut: true });
    }, timeoutMs);

    try {
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        data += chunk;
        if (data.length > maxBytes) {
          settle(resolve, { text: data.slice(0, maxBytes), truncated: true, timedOut: false });
        }
      });
      stream.on('end', () => settle(resolve, { text: data, truncated: false, timedOut: false }));
      stream.on('error', (err) => settle(reject, err));
      stream.resume();
    } catch (err) {
      settle(reject, err);
    }
  });
}
