// Audit 2026-09-02 P1-14: `CLAUDE_MEM_RUNTIME_DIR` did not relocate the runtime directory,
// it SPLIT it.
//
// Six places honoured it (the five standalone hook scripts + hook-launcher) and two did
// not: `hook-shared.mjs` — which `hook.mjs`, `server.mjs`, `hook-context.mjs` and
// `hook-episode.mjs` all take `RUNTIME_DIR` from — and `hook-optimize.mjs`. So a harness
// that set the variable got the `fyi`/`pretool` faces writing markers into the override
// while `ups`/`keyctx` read them from the real directory. No error, no empty directory, no
// way to notice; `experiment/lib/arms.mjs` uses exactly this variable to keep an arm off
// real state.
//
// The whole suite passed before the fix AND after it, which is the reason this file exists:
// nothing anywhere asserted the variable did what its name says. A guard nobody would miss
// is a guard nobody is keeping.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { join, isAbsolute } from 'path';
import { tmpdir } from 'os';
import { resolveRuntimeDir } from '../lib/resolve-data-dir.mjs';
import { walkShipped, sweepShipped, relShipped } from './shipped-tree.mjs';

let sandbox;
let override;

beforeEach(() => {
  vi.resetModules();
  sandbox = mkdtempSync(join(tmpdir(), 'mem-runtimedir-'));
  override = join(sandbox, 'elsewhere-runtime');
});

afterEach(() => {
  delete process.env.CLAUDE_MEM_RUNTIME_DIR;
  delete process.env.CLAUDE_MEM_DIR;
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('resolveRuntimeDir', () => {
  it('defaults to <dataDir>/runtime when the override is unset', () => {
    expect(resolveRuntimeDir('/data', {})).toBe(join('/data', 'runtime'));
  });

  it('treats empty and undefined as unset, not as a relocation to ""', () => {
    // `env || join(...)` handled this by accident; an `in`-style check would not, and a
    // runtime dir of '' resolves to cwd — state scattered across whatever directory the
    // hook happened to start in.
    expect(resolveRuntimeDir('/data', { CLAUDE_MEM_RUNTIME_DIR: '' })).toBe(join('/data', 'runtime'));
    expect(resolveRuntimeDir('/data', { CLAUDE_MEM_RUNTIME_DIR: undefined })).toBe(join('/data', 'runtime'));
  });

  it('honours an absolute override', () => {
    expect(resolveRuntimeDir('/data', { CLAUDE_MEM_RUNTIME_DIR: '/tmp/rt' })).toBe('/tmp/rt');
  });

  it('makes a relative override absolute rather than rejecting it', () => {
    // Deliberately unlike CLAUDE_MEM_DIR, which throws. This variable is set by test
    // harnesses that predate that check, and turning a previously-working relative path
    // into a throw would break isolation setups to enforce tidiness. Resolving keeps the
    // value usable AND absolute by the time anything writes to it.
    const got = resolveRuntimeDir('/data', { CLAUDE_MEM_RUNTIME_DIR: 'rel/rt' });
    expect(isAbsolute(got)).toBe(true);
    expect(got.endsWith(join('rel', 'rt'))).toBe(true);
  });
});

describe('the override reaches the modules that ignored it', () => {
  it('hook-shared.mjs RUNTIME_DIR follows CLAUDE_MEM_RUNTIME_DIR', async () => {
    // The defect itself. hook.mjs / server.mjs / hook-context.mjs / hook-episode.mjs all
    // read RUNTIME_DIR from here, so this one module is most of the split.
    process.env.CLAUDE_MEM_DIR = sandbox;
    process.env.CLAUDE_MEM_RUNTIME_DIR = override;
    const { RUNTIME_DIR } = await import('../hook-shared.mjs');
    expect(RUNTIME_DIR).toBe(override);
  });

  it('hook-shared.mjs still defaults under the data dir when the override is absent', async () => {
    // Premise for the case above: it must be following the OVERRIDE, not merely reporting
    // a path that happens to sit inside the sandbox either way.
    process.env.CLAUDE_MEM_DIR = sandbox;
    const { RUNTIME_DIR } = await import('../hook-shared.mjs');
    expect(RUNTIME_DIR).toBe(join(sandbox, 'runtime'));
    expect(RUNTIME_DIR).not.toBe(override);
  });
});

describe('the rule has one home', () => {
  // TWO sweeps plus a per-SITE allowlist. Each shape here was earned by a defect.
  //
  // `INLINE_RE` catches a module that DID hear of the variable and wrote its own copy of the
  // rule. No module has that shape except the one declared exception.
  //
  // `CONSTRUCT_RE` catches the shape the defective modules ACTUALLY had — building the
  // runtime path themselves and never mentioning the variable. Invisible to INLINE_RE, which
  // is why `scripts/user-prompt-search.js` could resolve its RUNTIME_DIR and still build the
  // SHARED cross-hook marker from the data dir.
  //
  // `INVERSE_RE` catches the OTHER direction: deriving the data dir back out of the runtime
  // dir. `hook.mjs` did that seven times as `join(RUNTIME_DIR, '..')`, an identity that
  // stopped holding the moment the override was honoured — reverting those five metric sites
  // was invisible to both sweeps above (v3.93.0 post-release review, M5).
  //
  // THE ALLOWLIST IS PER SITE, NOT PER FILE, and that is the whole point. v3.93.0 shipped a
  // whole-file allowlist; three of its six entries hold BOTH stays-put and moves-with-the-
  // override sites, so inside those files the guard was simply off — and two live splits were
  // sitting in them, one created by that release. A file-level reason cannot express "this
  // file has both kinds". A constructing line now needs `// runtime-dir:stays-put — <reason>`
  // on the line itself.
  const INLINE_RE = /process\.env\.CLAUDE_MEM_RUNTIME_DIR\s*\|\|/;
  // `join` or `resolve`; `\s*\(`; TWO levels of nested parens in the first argument, because
  // `join(dirname(fileURLToPath(import.meta.url)), 'runtime')` is an idiom this repo uses and
  // one level cannot cross it. A JS regex cannot recurse, so this is a bounded depth, not a
  // parser — the residual forms are named in the NOT-BINDING list of the review that found
  // them, and the marker-reverse-guard below is what stops the allowlist rotting instead.
  const CONSTRUCT_RE = /\b(?:join|resolve)\s*\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*,\s*['"`]runtime['"`]/;
  // Template-literal and concatenation forms of the same construction.
  const CONSTRUCT_ALT_RE = /['"`][^'"`]*\/runtime(?:['"`/]|$)|\+\s*['"`]\/?runtime['"`]/;
  // `[\w$]*` and NOT `[A-Za-z_$][\w$]*`: the prefix is OPTIONAL. The first draft required at
  // least one character before RUNTIME_DIR, so it matched `NB_RUNTIME_DIR` and missed the bare
  // `join(RUNTIME_DIR, '..')` — which is the exact form of all seven sites it exists to catch.
  const INVERSE_RE = /\b(?:join|resolve)\s*\(\s*[\w$]*RUNTIME_DIR\b\s*,\s*['"`]\.\.['"`]/;
  const MARKER_RE = /\/\/\s*runtime-dir:stays-put\s*—\s*(\S.*)$/;

  const INLINE_ALLOWED = new Set(['scripts/hook-launcher.mjs']);

  /** Non-comment source lines of a shipped module, with 1-based numbers. */
  const codeLines = (file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .map((text, i) => ({ text, line: i + 1 }))
      .filter(({ text }) => !/^\s*(?:\/\/|\*|\/\*)/.test(text));

  /** Every constructing line in the shipped tree that carries no stays-put marker. */
  function unmarkedConstructions() {
    const out = [];
    for (const file of walkShipped()) {
      for (const { text, line } of codeLines(file)) {
        const constructs =
          CONSTRUCT_RE.test(text) ||
          (CONSTRUCT_ALT_RE.test(text) && /runtime/.test(text)) ||
          INVERSE_RE.test(text);
        if (constructs && !MARKER_RE.test(text)) out.push(`${relShipped(file)}:${line}`);
      }
    }
    return out;
  }

  /** Every stays-put marker in the tree, with the line it sits on. */
  function markers() {
    const out = [];
    for (const file of walkShipped()) {
      for (const { text, line } of codeLines(file)) {
        const m = text.match(MARKER_RE);
        if (m) out.push({ where: `${relShipped(file)}:${line}`, reason: m[1].trim(), text });
      }
    }
    return out;
  }

  it('the sweep walks a plausible number of shipped modules', () => {
    expect(walkShipped().length).toBeGreaterThan(60);
  });

  it('no shipped module re-derives the rule inline', () => {
    expect(sweepShipped(INLINE_RE, INLINE_ALLOWED)).toEqual([]);
  });

  it('every line that builds a runtime path is either resolved or marked stays-put', () => {
    expect(unmarkedConstructions()).toEqual([]);
  });

  it('every stays-put marker sits on a line that really constructs, and states a reason', () => {
    // A marker that stops matching is a stale exemption, and a stale exemption is how an
    // allowlist becomes a raised baseline that quietly re-admits the defect.
    const all = markers();
    expect(
      all.length,
      'premise: the tree must actually carry markers, or this asserts nothing',
    ).toBeGreaterThan(5);
    for (const { where, reason, text } of all) {
      const constructs =
        CONSTRUCT_RE.test(text) ||
        (CONSTRUCT_ALT_RE.test(text) && /runtime/.test(text)) ||
        INVERSE_RE.test(text);
      expect(constructs, `${where} is marked stays-put but no longer builds a runtime path`).toBe(true);
      expect(reason.length, `${where} carries no reason`).toBeGreaterThan(10);
    }
  });

  it('the sweeps can say NO — every shape that must fire, and every shape that must not', () => {
    // A sweep that cannot fire is indistinguishable from a clean tree.
    const fires = [
      "const d = join(DATA_DIR, 'runtime', 'marker');",
      'const d = join(DATA_DIR, "runtime");',
      "const d = join(resolveDataDir(process.env.CLAUDE_MEM_DIR), 'runtime');",
      "const d = join(resolveDataDir(env || fallback()), 'runtime');",
      "const d = join(dirname(fileURLToPath(import.meta.url)), 'runtime');",
      "const d = resolve(DATA_DIR, 'runtime');",
      "const d = join (DATA_DIR, 'runtime');",
      'const d = join(`${DIR}/runtime`, x);',
      "const d = DATA_DIR + '/runtime';",
      "recordMetric(join(RUNTIME_DIR, '..'), {});",
      "gcOldMetricShards(resolve(NB_RUNTIME_DIR, '..'));",
    ];
    for (const f of fires) {
      const hit =
        CONSTRUCT_RE.test(f) || (CONSTRUCT_ALT_RE.test(f) && /runtime/.test(f)) || INVERSE_RE.test(f);
      expect(hit, `sweep is blind to: ${f}`).toBe(true);
    }
    const quiet = [
      'const d = resolveRuntimeDir(DATA_DIR);',
      "const d = join(DB_DIR, 'managed');",
      'const d = join(RUNTIME_DIR, fileName);',
      "const d = join(DB_DIR, 'metrics');",
    ];
    for (const q of quiet) {
      const hit =
        CONSTRUCT_RE.test(q) || (CONSTRUCT_ALT_RE.test(q) && /runtime/.test(q)) || INVERSE_RE.test(q);
      expect(hit, `sweep falsely fires on: ${q}`).toBe(false);
    }
    // …and the marker must be what silences it, not the shape.
    expect(MARKER_RE.test("const d = join(X, 'runtime'); // runtime-dir:stays-put — because")).toBe(true);
    expect(MARKER_RE.test("const d = join(X, 'runtime'); // runtime-dir:stays-put —")).toBe(false);

    for (const rel of INLINE_ALLOWED) {
      expect(
        readFileSync(join(process.cwd(), rel), 'utf8'),
        `${rel} is allowlisted but no longer carries the inline rule`,
      ).toMatch(INLINE_RE);
    }
  });
});
