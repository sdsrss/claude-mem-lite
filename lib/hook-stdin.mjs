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
/**
 * Cap for a payload that carries a WHOLE FILE: `PreToolUse`/`PostToolUse` on `Write` puts the
 * entire file being written in `tool_input.content`. Exported and named rather than typed at
 * each call site because two entry points see that same payload class, and two hand-written
 * numbers for one class is the drift shape this module exists to remove — this is NOT the
 * calibers being unified, which the note above rules out: a caller with a different payload
 * class still passes its own.
 *
 * Sized as a MEMORY backstop, not a functional gate. The v3.93.0 pre-tag review measured the
 * 256 KB default silently dropping `pretool` recall for any Write over that size, on the
 * reasoning that a truncated payload matched what the host's 3 s fail-open already did —
 * `JSON.parse` is 2.99 ms at 5 MB and 10.8 ms at 10 MB, so it did not.
 */
export const TOOL_INPUT_FILE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Recover the scalar fields a hook needs from a TRUNCATED JSON payload prefix.
 *
 * Mirrors `hook.mjs handlePostToolUse`'s salvage of `tool_name`. Returns null when the
 * prefix does not carry a `file_path` — the caller then behaves exactly as it did before
 * salvage existed, so this can only add recalls, never remove one.
 *
 * Lives here rather than in the one script that calls it because it is about a payload this
 * module bounded: the cap and the recovery from the cap are one decision, and a helper that
 * only the truncating module's caller can reach is a helper nothing can unit-test.
 *
 * Deliberately regex over the prefix rather than a streaming parser: the fields are flat
 * string scalars, and a partial-JSON parser is a dependency and a failure mode for a path
 * whose entire budget is the host's fail-open window.
 *
 * @param {string} prefix Truncated payload text.
 * @returns {{filePath: string, sessionId: string|null, toolName: string|null} | null}
 */
export function salvageTruncatedHookEvent(prefix) {
  // Bounded capture. Unbounded, an 8 MB prefix whose `file_path` string is never closed
  // makes V8 exceed its regexp backtrack limit and THROW RangeError — measured at the cap by
  // the v3.93.0 post-release review. The throw escapes the caller's catch into its top-level
  // one, which still exits 0 but writes a `pre-recall:top` telemetry row: the same
  // hook-error noise the caller split `pre-recall:json` away from. 4096 is far above any
  // real path (PATH_MAX is 4096 on Linux, 1024 on macOS), so no reachable payload is lost.
  const fp = prefix.match(/"file_path"\s*:\s*"((?:[^"\\]|\\.){0,4096})"/);
  if (!fp) return null;
  let filePath;
  // The captured group is still JSON-escaped (Windows paths arrive as `C:\\x`).
  try {
    filePath = JSON.parse(`"${fp[1]}"`);
  } catch {
    return null;
  }
  if (!filePath) return null;
  const sid = prefix.match(/"session_id"\s*:\s*"([^"\\]*)"/);
  const tn = prefix.match(/"tool_name"\s*:\s*"([^"\\]*)"/);
  return { filePath, sessionId: sid ? sid[1] : null, toolName: tn ? tn[1] : null };
}

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
      try {
        stream.destroy();
      } catch {
        /* already gone */
      }
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
