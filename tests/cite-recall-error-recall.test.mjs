// D#51: benchmark/cite-recall.mjs must credit the PostToolUse error-recall hint
// (hook.mjs triggerErrorRecall → `[claude-mem-lite] Related memories found for this
// error:` + `  #NN [type] body` rows) to its OWN :error-recall bucket, using the same
// row-anchored extraction as production lib/citation-tracker.mjs (INJECTED_ROW_RE).
//
// Two artifacts this locks out (both DEFLATE the channel's true recall by padding the
// injected denominator with never-cited ids):
//   A1  error-recall #NN were bucketed under the generic `PostToolUse:Bash` label and
//       only caught INCIDENTALLY when a co-located `[mem] episode flushed` line tripped
//       the loose [mem] marker — no explicit detection, wrong bucket name.
//   A2  a FOREIGN plugin's PostToolUse:Bash output (e.g. code-graph grep echoing a code
//       comment `// #123 / #45678`) that happens to contain `[mem]` had its code-comment
//       #NN counted as injected observations via the broad /#\d+\b/ extractor.
// Also excluded: a lesson body that QUOTES another obs (`… see #9999 …`) and the trailing
// `Use mem_get(ids=[…])` bare numbers — neither is a genuine injected row.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { execFileSync } from 'child_process';

const SCRIPT = resolve(new URL('..', import.meta.url).pathname, 'benchmark/cite-recall.mjs');

function runCiteRecall(dir, startISO, endISO) {
  const out = execFileSync(
    'node',
    [SCRIPT, `--dir=${dir}`, '--json', `--start=${startISO}`, `--end=${endISO}`],
    { encoding: 'utf8' },
  );
  return Object.fromEntries((JSON.parse(out).per_hook || []).map((h) => [h.hook, h]));
}

describe('cite-recall :error-recall bucket (D#51)', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cite-err-'));
  });
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // PostToolUse:Bash error-recall attachment (real shape: stdout carries the hint block,
  // a co-located episode-flush line trips the loose [mem] marker in the wild).
  const errRecall = (T, body) => ({
    timestamp: T,
    sessionId: 's1',
    type: 'attachment',
    attachment: { hookName: 'PostToolUse:Bash', command: 'node "/x/post-tool-use.sh"', stdout: body },
  });
  const cite = (T, text) => ({
    timestamp: T,
    sessionId: 's1',
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  });

  it('routes error-recall #NN to :error-recall with row-anchored extraction; excludes foreign/quoted/bare ids', () => {
    const now = Date.now();
    const T = new Date(now).toISOString();
    const block = [
      '[claude-mem-lite] Related memories found for this error:',
      '  #3860 [bugfix] Error: foo failed, same root cause as #9999 [decision] over there',
      '  #8736 [bugfix] bar baz qux',
      '  → Use mem_get(ids=[3860,8736]) for details.',
      '[mem] episode flushed: 2 entries (Bash×1)',
    ].join('\n');
    // A2: a FOREIGN (code-graph) PostToolUse:Bash attachment containing [mem] + code-comment
    // #NN, plus a grepped `<memory-context` literal — neither is a real mem injection.
    const foreign = {
      timestamp: T,
      sessionId: 's1',
      type: 'attachment',
      attachment: {
        hookName: 'PostToolUse:Bash',
        command: 'node "/x/code-graph/hook.mjs"',
        stdout:
          '[code-graph] AST view (ran alongside [mem]):\nlib/x.mjs:16  // #123 / #45678 at a word boundary\n<memory-context relevance="high"> (grepped source literal, not an inject)',
      },
    };
    writeFileSync(
      join(dir, 't.jsonl'),
      [errRecall(T, block), foreign, cite(T, 'I looked at #3860 and applied it.')]
        .map((e) => JSON.stringify(e))
        .join('\n'),
    );

    const byHook = runCiteRecall(
      dir,
      new Date(now - 3600000).toISOString(),
      new Date(now + 3600000).toISOString(),
    );
    const er = byHook['PostToolUse:Bash:error-recall'];

    expect(er).toBeDefined();
    expect(er.inject_unique).toBe(2); // #3860 + #8736 only
    expect(er.cited_unique).toBe(1); // #3860 cited
    // #9999 (quoted in a body), #123/#45678 (foreign code comment), and the bare
    // mem_get(ids=[3860,8736]) numbers must NOT create their own generic bucket. A
    // grepped `<memory-context` literal in foreign Bash output must not fabricate a
    // PostToolUse:Bash:memory-context bucket either.
    expect(byHook['PostToolUse:Bash']).toBeUndefined();
    expect(byHook['PostToolUse:Bash:memory-context']).toBeUndefined();
    // Sanity: no bucket anywhere injected the foreign/quoted ids.
    for (const h of Object.values(byHook)) {
      expect(h.inject_unique).toBeLessThanOrEqual(2);
    }
  });

  it('catches an error-recall block even with NO co-located [mem] marker (was missed before)', () => {
    const now = Date.now();
    const T = new Date(now).toISOString();
    const block = [
      '[claude-mem-lite] Related memories found for this error:',
      '  #4242 [decision] pick option D over B',
    ].join('\n'); // note: no `[mem]` line — old loose-marker gate would skip this entirely
    writeFileSync(
      join(dir, 't.jsonl'),
      [errRecall(T, block), cite(T, 'per #4242 I chose D')].map((e) => JSON.stringify(e)).join('\n'),
    );

    const byHook = runCiteRecall(
      dir,
      new Date(now - 3600000).toISOString(),
      new Date(now + 3600000).toISOString(),
    );
    const er = byHook['PostToolUse:Bash:error-recall'];
    expect(er).toBeDefined();
    expect(er.inject_unique).toBe(1);
    expect(er.cited_unique).toBe(1);
  });
});
