// v3.75.0 shipped the UserPromptSubmit query cap on ONE of that event's two hooks.
//
// UserPromptSubmit registers two commands: `scripts/user-prompt-search.js` (path A, the
// FYI block) and `hook.mjs user-prompt` (path B, the `<memory-context>` block). P2-13
// capped path A and the release notes said "UserPromptSubmit query building" — but path B
// called `sanitizeFtsQuery(userPrompt)` with no options, on the full prompt, every turn.
//
// Path B is the worse half: path A's stdin is bounded by MAX_UPS_PROMPT_BYTES (64KB),
// path B's by MAX_HOOK_STDIN_BYTES (256KB), and nothing truncates between stdin and the
// query builder. So the cost the change set out to remove was still being paid on the
// sibling hook of the same event, at up to 4x the input size.
//
// This is the project's most-repeated defect shape (a guard wired into one path and
// missing on its sibling), so the fix is a shared module rather than a second copy of
// the constants: lib/ups-query.mjs is the one cap definition both faces import.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { sanitizeFtsQuery } from '../utils.mjs';
import { UPS_QUERY_CAPS, upsFtsQuery } from '../lib/ups-query.mjs';
import { searchInjectableEvents } from '../lib/events-injection.mjs';
import { createTestDb } from './test-helpers.mjs';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('UserPromptSubmit query caps — both hooks of the event', () => {
  it('caps are one definition, imported by both faces', () => {
    // A second copy of `{ maxChars: 2000, maxTokens: 64 }` would satisfy every behavioural
    // assertion below while re-opening the exact drift this fix closes.
    const pathA = read('../scripts/user-prompt-search.js');
    const pathB = read('../hook-memory.mjs');
    // Third leg (audit ALGO-1): `hook.mjs user-prompt` runs the events block alongside
    // the memory block. It was wired in v3.48, before this module existed, and kept
    // handing raw prompt text to searchInjectableEvents — so the event that "both faces"
    // above were meant to cover in fact had three query builders, and the uncapped one
    // survived the round that named the defect.
    const pathC = read('../hook.mjs');
    for (const [name, src] of [['user-prompt-search.js', pathA], ['hook-memory.mjs', pathB], ['hook.mjs', pathC]]) {
      expect(src, `${name} must import the shared cap`).toMatch(/from '\.\.?\/lib\/ups-query\.mjs'/);
      expect(src, `${name} must not re-declare the caps`).not.toMatch(/maxChars:\s*2000/);
    }
  });

  it('path B no longer builds an uncapped query from the raw prompt', () => {
    // The precise shape that shipped: sanitizeFtsQuery(userPrompt) with no second arg.
    expect(read('../hook-memory.mjs')).not.toMatch(/sanitizeFtsQuery\(\s*userPrompt\s*\)/);
  });

  it('the cap actually changes the query on an oversized prompt', () => {
    // Anti-vacuity for the two source assertions above: if capped and uncapped agreed,
    // they would be pinning a distinction that does not exist.
    // DISTINCT terms, not a repeated phrase: repetition dedups down to a handful of
    // tokens, so neither cap fires and capped === uncapped — the fixture would report
    // "no difference" while the caps work perfectly. (My first version did exactly that.)
    const huge = Array.from({ length: 300 }, (_, i) => `zzterm${i}alpha`).join(' ');
    expect(huge.length).toBeGreaterThan(UPS_QUERY_CAPS.maxChars);
    const capped = upsFtsQuery(huge);
    const uncapped = sanitizeFtsQuery(huge);
    expect(capped).not.toBe(uncapped);
    expect(capped.length).toBeLessThan(uncapped.length);
  });

  it('leaves a normal prompt byte-identical, capped or not', () => {
    // The caps must be invisible in the case that matters most — every ordinary turn.
    const normal = 'why does the dedup guard skip superseded rows';
    expect(upsFtsQuery(normal)).toBe(sanitizeFtsQuery(normal));
  });

  // ── ALGO-1: the events leg was the event's third, uncapped query builder ──

  it('the events leg cannot be handed raw prompt text at all', () => {
    // Capping at the call site would leave the uncapped door open for the next caller,
    // which is how this leg came to exist. searchInjectableEvents now takes a BUILT
    // query only: a `prompt` option would be silently ignored, so the signature is what
    // is asserted, not the caller's good behaviour.
    const src = read('../lib/events-injection.mjs');
    // Signature shape, not layout — separators are \s* so a formatter may wrap it (P1-3).
    expect(src).toMatch(/export function searchInjectableEvents\(\s*db,\s*\{\s*ftsQuery,/);
    expect(src, 'events-injection must not build a query of its own')
      .not.toMatch(/sanitizeFtsQuery\(/);
    expect(read('../hook.mjs'), 'the events call must pass a built, capped query')
      .toMatch(/searchInjectableEvents\(\s*db,\s*\{\s*ftsQuery: upsFtsQuery\(promptText\)/);
  });

  it('the events leg returns nothing for a query it was never given', () => {
    // Anti-vacuity for the signature assertion: prove the removed option is genuinely
    // inert rather than trusting that it is gone. Passing the old shape must not
    // resurrect the uncapped path — it must simply retrieve nothing.
    const db = createTestDb();
    db.prepare(
      "INSERT INTO events (project, event_type, title, body, importance, created_at_epoch)"
      + " VALUES ('p', 'bugfix', 'redis connection pool exhausted', 'raise the cap', 2, ?)",
    ).run(Date.now());
    expect(searchInjectableEvents(db, { ftsQuery: 'redis', project: 'p' }).length).toBe(1);
    expect(searchInjectableEvents(db, { prompt: 'redis', project: 'p' }).length).toBe(0);
    db.close();
  });

  it('builds the events query in bounded time on a 250KB CJK prompt', () => {
    // Path B's stdin cap is 256KB and nothing truncates between stdin and the query
    // builder, so this is a real input. Measured before the fix: 356ms, synchronously,
    // before the model sees the turn. Distinct CJK terms, not a repeated phrase —
    // repetition dedups to a handful of tokens and the cap never fires (#9081).
    //
    // JUDGED ON SCALING, NOT ON A WALL-CLOCK BUDGET. This case used to assert
    // `ms < 60`, and on 2026-09-02 it blocked a release at 67.6ms during a suite run that
    // took 135s instead of the usual 40s — nothing on this path had changed since v3.75,
    // and the same case runs in ~44ms alone. An absolute millisecond bound on a shared
    // machine measures the machine. The property actually under guard is that the builder
    // does not blow up superlinearly on a large input (the pre-fix behaviour was a
    // 356ms synchronous stall), so compare 250KB against a 25KB baseline in the SAME
    // process: a ratio cancels the load that an absolute number cannot. Same lesson as
    // D#203, and the same one CLAUDE.md records for every ruler here — quote the ratio,
    // never the absolute ms.
    const build = (bytes) => {
      let text = '';
      for (let i = 0; text.length < bytes; i++) text += `第${i}号缺陷在检索层的注入面上复现 `;
      return text;
    };
    const timed = (text) => {
      const started = process.hrtime.bigint();
      const q = upsFtsQuery(text);
      return { ms: Number(process.hrtime.bigint() - started) / 1e6, q };
    };

    const small = build(25_000);
    const large = build(250_000);
    // Warm the path once so the first-call JIT cost lands outside both measurements —
    // otherwise the SMALL arm absorbs it and the ratio reads far below 1.
    timed(small);
    const a = timed(small);
    const b = timed(large);

    expect(String(b.q).length).toBeLessThanOrEqual(UPS_QUERY_CAPS.maxChars);
    expect(String(a.q).length).toBeLessThanOrEqual(UPS_QUERY_CAPS.maxChars);

    // 10x the input must not cost more than ~30x the time. Linear is 10x; the pre-fix
    // quadratic shape would be ~100x. The floor on the denominator keeps a sub-millisecond
    // small arm from manufacturing a huge ratio out of timer granularity.
    const ratio = b.ms / Math.max(a.ms, 0.5);
    expect(
      ratio,
      `10x input cost ${ratio.toFixed(1)}x time (25KB ${a.ms.toFixed(1)}ms -> 250KB ${b.ms.toFixed(1)}ms)`,
    ).toBeLessThan(30);

    // Backstop only, deliberately loose: catches a genuine stall (the 356ms original)
    // without failing on ordinary contention. The ratio above is the real assertion.
    expect(b.ms, `upsFtsQuery took ${b.ms.toFixed(1)}ms on ${large.length} bytes`).toBeLessThan(300);
  });
});
