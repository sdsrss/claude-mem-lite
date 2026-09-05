// Phase-2 instrumentation: benchmark/cite-recall.mjs must credit the task-imperative
// line (CLAUDE_MEM_TASK_IMPERATIVE) to its own :imperative bucket. The line is
// co-located with the <memory-context> block in ONE UserPromptSubmit attachment, so
// per-attachment marker routing would fold its #NN into :memory-context; this locks the
// per-line split + the #1501 OR-gate (imperative-only attachments must not be skipped).
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

describe('cite-recall :imperative bucket', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cite-imp-'));
  });
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  const A = (T, stdout) => ({
    timestamp: T,
    sessionId: 's1',
    type: 'attachment',
    attachment: { hookName: 'UserPromptSubmit', stdout },
  });
  const cite = (T, text) => ({
    timestamp: T,
    sessionId: 's1',
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  });

  it('routes the co-located imperative #NN to :imperative without polluting :memory-context, and catches imperative-only attachments', () => {
    // Real-clock timestamps: cite-recall filters candidate files by mtime >= START, and the
    // fixture is written now — a hard-coded date in the future of the sandbox clock excludes it.
    const now = Date.now();
    const T = new Date(now).toISOString();
    writeFileSync(
      join(dir, 't.jsonl'),
      [
        A(
          T,
          '<memory-context relevance="high">\n- [bugfix] foo (#10)\n- [decision] bar (#20)\n</memory-context>\nMemory — a past lesson applies to THIS task. You must: do the thing (#30)',
        ),
        A(T, 'Memory — a past lesson applies to THIS task. You must: keep the filter (#40)'),
        cite(T, 'I applied #10 and #30, and per #40 I kept it.'),
      ]
        .map((e) => JSON.stringify(e))
        .join('\n'),
    );

    const byHook = runCiteRecall(
      dir,
      new Date(now - 3600000).toISOString(),
      new Date(now + 3600000).toISOString(),
    );
    const imp = byHook['UserPromptSubmit:imperative'];
    const mc = byHook['UserPromptSubmit:memory-context'];

    expect(imp).toBeDefined();
    expect(imp.inject_unique).toBe(2); // #30 (co-located) + #40 (imperative-only via OR-gate)
    expect(imp.cited_unique).toBe(2); // both cited
    expect(mc).toBeDefined();
    expect(mc.inject_unique).toBe(2); // #10,#20 — NOT polluted by #30/#40
    expect(mc.cited_unique).toBe(1); // only #10 cited
  });
});
