// Numeric env overrides must fail loudly, not become NaN.
//
// The defect (2026-09-04): every UPS knob was `Number(process.env.X || DEFAULT)`.
// `Number('abc')` is NaN, so a typo did not fall back — it propagated NaN into the
// consumer, where the behaviour depends on which consumer it was:
//
//   MAX_RESULTS           → `rows.slice(0, NaN)` === []          face goes dark
//   PROMPT_FALLBACK_LIMIT → `LIMIT ?` bound NaN                  SqliteError
//   TOP_REL_FLOOR         → `Math.abs(rel) < NaN` is false       floor stops firing
//   OR_TOP_BM25_FLOOR     → `orFloor > 0` is false               floor stops firing
//
// i.e. one typo either silences the injection face or disables the gates that keep
// it quiet, with no error either way.
//
// Three layers here, deliberately different in kind:
//   1. the helper's own contract (unit),
//   2. a SOURCE sweep so the idiom cannot come back anywhere in the tree (class-level),
//   3. one END-TO-END case driving the real hook in a subprocess, because (1) and (2)
//      together still do not prove the call sites were rewired.

import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { saveObservation } from '../lib/save-observation.mjs';
import { envNumber } from '../lib/env-number.mjs';

// join(), never `new URL('../x.mjs', import.meta.url)`: the URL form drops whatever
// module it names out of knip's unused-export report entirely (CLAUDE.md knip rule 4).
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('envNumber — the contract lib/cli-flags.mjs already has for CLI flags', () => {
  const capture = () => {
    const seen = [];
    return { warn: (m) => seen.push(m), seen };
  };

  it('returns the parsed value for a well-formed number', () => {
    expect(envNumber('7', { name: 'X', defaultValue: 3 })).toBe(7);
    expect(envNumber('1e-5', { name: 'X', defaultValue: 3 })).toBe(1e-5);
    expect(envNumber(' 12 ', { name: 'X', defaultValue: 3 })).toBe(12);
    expect(envNumber('-2.5', { name: 'X', defaultValue: 3 })).toBe(-2.5);
  });

  it('accepts scientific notation, which parseInt would silently misread', () => {
    // Not decoration: BM25_MIN_SCORE / FOLLOWUP_BM25_MIN_SCORE default to 1e-5 / 5e-6,
    // so a helper built on parseInt would turn a user's own documented value into 1
    // and 5 — a 10^5 error with no warning. This pins the choice of primitive.
    expect(envNumber('5e-6', { name: 'X', defaultValue: 1 })).toBe(5e-6);
    expect(parseInt('5e-6', 10)).toBe(5); // the shape being ruled out
  });

  it('falls back SILENTLY when unset or empty — that is not a mistake', () => {
    const c = capture();
    expect(envNumber(undefined, { name: 'X', defaultValue: 3, warn: c.warn })).toBe(3);
    expect(envNumber(null, { name: 'X', defaultValue: 3, warn: c.warn })).toBe(3);
    expect(envNumber('', { name: 'X', defaultValue: 3, warn: c.warn })).toBe(3);
    expect(envNumber('   ', { name: 'X', defaultValue: 3, warn: c.warn })).toBe(3);
    expect(c.seen, 'unset must not warn — `CLAUDE_MEM_X=` is how a shell clears it').toEqual([]);
  });

  it('falls back LOUDLY on the values that used to become NaN', () => {
    for (const bad of ['abc', '2abc', 'NaN', 'Infinity', '-Infinity', 'null', '1,5']) {
      const c = capture();
      expect(
        envNumber(bad, { name: 'CLAUDE_MEM_X', defaultValue: 3, warn: c.warn }),
        `"${bad}" did not fall back`,
      ).toBe(3);
      expect(c.seen.length, `"${bad}" fell back without warning`).toBe(1);
      expect(c.seen[0]).toContain('CLAUDE_MEM_X');
      expect(c.seen[0]).toContain(bad);
    }
  });

  it('honours an explicit 0 — the `|| DEFAULT` idiom swallowed it', () => {
    // CLAUDE_MEM_UPS_TOP_MIN=0 is the documented seed-mode kill switch for the
    // absolute floors, and CLAUDE_MEM_CITE_NUDGE_MIN_INJECTED=0 means "no volume
    // requirement". Both were unreachable through `Number(env || d)` / `Number(env) || d`.
    const c = capture();
    expect(envNumber('0', { name: 'X', defaultValue: 50, min: 0, warn: c.warn })).toBe(0);
    expect(c.seen).toEqual([]);
  });

  it('enforces the range and says what the range was', () => {
    const c = capture();
    expect(envNumber('-1', { name: 'X', defaultValue: 8, min: 0, max: 50, warn: c.warn })).toBe(8);
    expect(envNumber('51', { name: 'X', defaultValue: 8, min: 0, max: 50, warn: c.warn })).toBe(8);
    expect(c.seen.length).toBe(2);
    for (const m of c.seen) expect(m).toContain('between 0 and 50');
  });

  it('enforces integrality only when asked', () => {
    const c = capture();
    expect(envNumber('3.7', { name: 'X', defaultValue: 3, integer: true, warn: c.warn })).toBe(3);
    expect(c.seen[0]).toContain('an integer');
    expect(envNumber('3.7', { name: 'X', defaultValue: 3 })).toBe(3.7);
  });
});

// ─── Class-level sweep: the idiom must not come back ────────────────────────────
//
// A count of fixed sites is not a fix — this repo's own record is that the
// same shape reappears on a face nobody swept (CLAUDE.md, "修好的那份不是唯一那份").
// The rule is derived from the source, so a site written tomorrow is covered.
//
// What it catches: a numeric parse whose argument folds a fallback into the parse
// (`Number(process.env.X || 3)`), which is exactly the shape that yields NaN.
// What it deliberately does NOT catch, and why: `const raw = process.env.X;` followed
// by `parseInt(raw, 10)` and an explicit `Number.isFinite`/`Number.isInteger` gate.
// Six sites in this tree are written that way and are correct; a rule broad enough to
// flag them would need an allowlist, and an allowlist rots into a raised baseline.
// Being a text rule it is also blind to aliasing (`const e = process.env; Number(e.X || 3)`);
// that is the ceiling of a source guard, not a claim that the class is impossible.

const SWEEP_DIRS = ['lib', 'scripts', 'cli', 'server', 'benchmark'];
const SWEEP_EXT = /\.(mjs|js)$/;

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (SWEEP_EXT.test(e)) out.push(p);
  }
  return out;
}

/** Every production source file the sweep covers (root modules + SWEEP_DIRS). */
export function sweepFiles() {
  const rootFiles = readdirSync(ROOT)
    .filter((f) => /\.mjs$/.test(f))
    .map((f) => join(ROOT, f))
    .filter((f) => statSync(f).isFile());
  const nested = SWEEP_DIRS.flatMap((d) => walk(join(ROOT, d)));
  return [...rootFiles, ...nested];
}

/**
 * Blank out comment LINES, preserving line count so reported line numbers stay true.
 *
 * Needed because lib/env-number.mjs's own docblock QUOTES the banned idiom in order to
 * explain it, and the first version of this sweep flagged that quote. A guard a comment
 * can trip is a guard someone will weaken.
 *
 * PURELY LINE-BASED, and the reason is a measured failure. The first cut also ran
 * `src.replace(/\/\*[\s\S]*?\*\//g, blank)` over raw source with no string awareness, so
 * any slash-star INSIDE A STRING opened a phantom comment that swallowed everything to the
 * next star-slash. That text is not exotic — it is glob patterns and URL replacements: the
 * node_modules exclude glob in vitest.config.mjs, the `'$1://***'` replacement in
 * secret-scrub.mjs (both contain a slash immediately followed by a star). It blanked
 * **346 lines of real code across 11 files** (214 of them in scripts/audit-metrics.mjs),
 * and the v3.94.0 pre-tag test-effectiveness review planted the banned idiom inside one of
 * those spans: the suite stayed green and the sweep reported zero offenders. The same line
 * in a clean file was caught, so the blinding was the whole cause.
 *
 * A line is a comment line iff its first non-space characters are `//`, `*` (a JSDoc
 * continuation or closer) or `/*`. Consequence, stated because it is the trade: a block
 * comment TRAILING real code on one line is no longer stripped, so the banned idiom
 * written there would be a false positive. That fails loudly — somebody rewords a comment
 * — which is the direction to err in. Blanking code silently does not.
 *
 * @param {string} src
 * @returns {string}
 */
export function stripComments(src) {
  return src
    .split('\n')
    .map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l))
    .join('\n');
}

/** An env read, either syntactically or by this repo's env-name convention. */
const ENV_READ_RE = /(^|[^A-Za-z0-9_$])env\s*[.[]|process\.env|\bCLAUDE_MEM_[A-Z0-9_]+|\bMEM_[A-Z][A-Z0-9_]*/;

/**
 * The TERNARY form: `env.X !== undefined ? Number(env.X) : DEFAULT`. NaN-unsafe, and it is
 * one of the two idioms v3.94.0 removed from lib/cite-back-hint.mjs, so it is a shape that
 * gets written here rather than a hypothetical.
 */
const TERNARY_RES = [
  /(?:process\.env|(?:^|[^A-Za-z0-9_$])env)\s*[.[][A-Za-z0-9_$.'"[\]]{1,60}\s*!==\s*undefined\s*\?[\s\S]{0,160}?\b(?:Number|parseInt|parseFloat)\s*\(/g,
  /\b(?:CLAUDE_MEM_[A-Z0-9_]+|MEM_[A-Z][A-Z0-9_]*)\s*!==\s*undefined\s*\?[\s\S]{0,160}?\b(?:Number|parseInt|parseFloat)\s*\(/g,
];

/**
 * Numeric parses of an env value that carry an inline default. THREE shapes, because the
 * first cut covered one of them and the v3.94.0 pre-tag review reverted the other two in a
 * shipped module with the whole tree still green:
 *
 *   Number(env.X || D)                          folded into the argument
 *   Number(env.X) || D                          trailing — the shape that swallows a 0
 *   env.X !== undefined ? Number(env.X) : D     ternary — NaN-unsafe
 *
 * Scans to the matching close paren rather than regexing the whole call, so a nested call
 * (`Number(foo(a || b))`) is measured on its real argument text. The env read is matched
 * syntactically OR by name convention (`CLAUDE_MEM_*` / `MEM_*`), which is what catches a
 * destructured `const { CLAUDE_MEM_X } = process.env`.
 *
 * NOT caught, stated as the technique's ceiling rather than as a claim of completeness:
 * an env object aliased to a name this repo does not use (`const e = process.env;
 * Number(e.X || 3)`), and unary-plus coercion (`+(process.env.X || 3)`), which is not this
 * codebase's style. A source guard cannot follow bindings; that is what the behavioural
 * cases below are for.
 *
 * @param {string} raw File source.
 * @returns {Array<{line:number, text:string}>}
 */
export function findFoldedEnvParses(raw) {
  const src = stripComments(raw);
  const hits = [];
  const lineOf = (idx) => src.slice(0, idx).split('\n').length;

  const re = /\b(Number|parseInt|parseFloat)\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
    }
    const arg = src.slice(m.index + m[0].length, i - 1);
    if (!ENV_READ_RE.test(arg)) continue;
    const folded = /\|\||\?\?/.test(arg);
    const trailing = /^\s*(\|\||\?\?)/.test(src.slice(i));
    if (folded || trailing) {
      hits.push({ line: lineOf(m.index), text: `${m[1]}(${arg})${trailing ? ' || …' : ''}` });
    }
  }

  // Deduped by where the match ENDS (always just past the `Number(`), because the two
  // ternary patterns overlap by design: the syntactic one and the name-convention one both
  // fire on `env.CLAUDE_MEM_X !== undefined ? Number(…)`. Reporting one offender twice is
  // not a false positive, but it makes the sweep's output lie about how many there are.
  const seen = new Set();
  for (const tre of TERNARY_RES) {
    tre.lastIndex = 0;
    let t;
    while ((t = tre.exec(src)) !== null) {
      const end = t.index + t[0].length;
      if (seen.has(end)) continue;
      seen.add(end);
      hits.push({ line: lineOf(t.index), text: t[0].replace(/\s+/g, ' ').slice(0, 90) });
    }
  }
  return hits;
}

describe('no numeric env parse may fold its own fallback into the parse', () => {
  it('the scanner can actually say yes — otherwise a clean sweep proves nothing', () => {
    // The sweep below reports zero. A scanner that always returned [] would look
    // identical, which is how this repo has shipped a guard that could not fail.
    expect(findFoldedEnvParses('const a = Number(process.env.X || 3);')).toHaveLength(1);
    expect(findFoldedEnvParses('const a = Number(env.X ?? 3);')).toHaveLength(1);
    expect(findFoldedEnvParses('const a = parseInt(process.env.X || 3, 10);')).toHaveLength(1);
    // ...and no on the correct shapes, so it is not just "always yes".
    expect(findFoldedEnvParses('const r = process.env.X; const a = Number(r);')).toHaveLength(0);
    expect(findFoldedEnvParses('const a = Number(x || 3);')).toHaveLength(0);
    expect(findFoldedEnvParses('const a = Number(process.env.X);')).toHaveLength(0);
  });

  it('catches the other two idioms — the ones a shipped module actually used', () => {
    // The first cut caught only the folded form. The v3.94.0 pre-tag review reverted
    // lib/cite-back-hint.mjs's three sites to these two shapes and the whole tree stayed
    // green, so these are the shapes most likely to be written here again, not exotica.
    expect(
      findFoldedEnvParses('const a = Number(process.env.CLAUDE_MEM_X) || 3;'),
      'trailing-default form missed',
    ).toHaveLength(1);
    expect(findFoldedEnvParses('const a = Number(env.CLAUDE_MEM_X) ?? 3;')).toHaveLength(1);
    expect(
      findFoldedEnvParses('const a = env.CLAUDE_MEM_X !== undefined ? Number(env.CLAUDE_MEM_X) : 3;'),
      'ternary form missed',
    ).toHaveLength(1);
    expect(
      findFoldedEnvParses('const { CLAUDE_MEM_X } = process.env; const a = Number(CLAUDE_MEM_X || 3);'),
      'destructured env missed — name-convention arm not firing',
    ).toHaveLength(1);
  });

  it('a code line containing a glob is not blanked by the comment stripper', () => {
    // The regression that made the sweep blind over 346 lines: a glob and a URL-replacement
    // string both contain a slash immediately followed by a star, and a regex-based
    // block-comment stripper read that as an opener and swallowed to the next star-slash.
    // Driven on the two real shapes, taken from vitest.config.mjs and secret-scrub.mjs.
    const glob =
      "const exclude = ['**/node_modules/**'];\nconst a = Number(process.env.CLAUDE_MEM_X || 3);\n";
    expect(stripComments(glob).split('\n')[0], 'a glob line was blanked').toContain('node_modules');
    expect(findFoldedEnvParses(glob), 'offender after a glob line is invisible').toHaveLength(1);

    const url = "const R = '$1://***';\nconst a = Number(process.env.CLAUDE_MEM_Y || 3);\n";
    expect(stripComments(url).split('\n')[0]).toContain('***');
    expect(findFoldedEnvParses(url)).toHaveLength(1);
  });

  it('ignores the idiom when it appears in a comment, but not one line below it', () => {
    // lib/env-number.mjs quotes the banned form to explain it; the tree sweep must not
    // fire on documentation. The second half is the half that matters — a stripper that
    // over-reached would blank real code and the sweep would pass by seeing nothing.
    expect(findFoldedEnvParses('// bad: Number(process.env.X || 3)\n')).toHaveLength(0);
    expect(findFoldedEnvParses('/* bad: Number(process.env.X || 3) */\n')).toHaveLength(0);
    const mixed = '// bad: Number(process.env.X || 3)\nconst a = Number(process.env.Y || 4);\n';
    const hits = findFoldedEnvParses(mixed);
    expect(hits).toHaveLength(1);
    expect(hits[0].line, 'line numbers must survive comment blanking').toBe(2);
  });

  it('the sweep covers the files that carried the defect', () => {
    // Premise assertion: a sweep over an empty or mis-rooted file list passes vacuously.
    const files = sweepFiles();
    expect(files.length).toBeGreaterThan(80);
    for (const must of [
      'scripts/user-prompt-search.js',
      'lib/relevance-floor.mjs',
      'lib/cite-back-hint.mjs',
      'benchmark/adoption-rankers.mjs',
    ]) {
      expect(files, `sweep does not reach ${must}`).toContain(join(ROOT, must));
    }
  });

  it('finds none in the tree', () => {
    const offenders = [];
    for (const f of sweepFiles()) {
      for (const h of findFoldedEnvParses(readFileSync(f, 'utf8'))) {
        offenders.push(`${f.slice(ROOT.length + 1)}:${h.line}  ${h.text}`);
      }
    }
    expect(offenders, `use envNumber() from lib/env-number.mjs:\n${offenders.join('\n')}`).toEqual([]);
  });
});

// ─── End-to-end: the real hook, a real corpus, a malformed knob ─────────────────

const SCRIPT_PATH = resolve(ROOT, 'scripts/user-prompt-search.js');
const PROJECT = 'x--envnum';
const PROMPT = 'why does refreshSessionToken keep throwing after the deploy';
const dirs = [];

function seed() {
  const dir = mkdtempSync(join(tmpdir(), 'env-number-'));
  dirs.push(dir);
  const db = new Database(join(dir, 'claude-mem-lite.db'));
  initSchema(db);
  db.prepare(
    `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch)
              VALUES ('cc-seed','mem-seed', ?, datetime('now'), ?)`,
  ).run(PROJECT, Date.now());
  const base = Date.now();
  let target;
  db.transaction(() => {
    target = saveObservation(db, {
      content:
        'refreshSessionToken threw after every deploy because the rotated signing key ' +
        'was read once at module load instead of per call',
      type: 'bugfix',
      importance: 3,
      project: PROJECT,
      lesson_learned: 'read refreshSessionToken signing keys per call, not at module load',
      now: new Date(base),
    });
    for (let i = 1; i < 12; i++) {
      saveObservation(db, {
        content: `unrelated cleanup pass ${i} over the deploy scripts and their logging`,
        type: 'change',
        importance: 1,
        project: PROJECT,
        now: new Date(base - i * 10 * 60_000),
      });
    }
  })();
  db.close();
  return { dir, targetId: target.id };
}

function runHook(dir, extraEnv, sessionId) {
  return new Promise((done) => {
    const proc = spawn(process.execPath, [SCRIPT_PATH], {
      env: {
        ...process.env,
        CLAUDE_MEM_DIR: dir,
        CLAUDE_PROJECT_DIR: '/x/envnum',
        PWD: '/x/envnum',
        CLAUDE_MEM_SKIP_UPDATE: '1',
        MEM_QUIET_HOOKS: '1',
        ...extraEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    const killer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* gone */
      }
    }, 20_000);
    proc.on('close', () => {
      clearTimeout(killer);
      done({ stdout, stderr });
    });
    proc.stdin.write(JSON.stringify({ session_id: sessionId, prompt: PROMPT, cwd: '/x/envnum' }));
    proc.stdin.end();
  });
}

describe('a malformed numeric env must not silence the UserPromptSubmit face', () => {
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* gone */
      }
    }
  });

  it('injects with the knob unset — the premise every case below rests on', async () => {
    const { dir, targetId } = seed();
    const { stdout } = await runHook(dir, {}, 'env-baseline');
    expect(stdout, 'baseline injects nothing — the cases below would pass vacuously').toContain(
      `#${targetId}`,
    );
  });

  it('still injects with CLAUDE_MEM_UPS_MAX_RESULTS set to garbage', async () => {
    // Pre-fix this returned '' : NaN reached `rows.slice(0, MAX_RESULTS)`, which is
    // `slice(0, 0)`, and the face emitted nothing at all with no error anywhere.
    const { dir, targetId } = seed();
    const { stdout, stderr } = await runHook(dir, { CLAUDE_MEM_UPS_MAX_RESULTS: 'abc' }, 'env-garbage');
    expect(stdout, 'garbage cap silenced the face').toContain(`#${targetId}`);
    expect(stderr, 'fell back without telling anyone').toContain('CLAUDE_MEM_UPS_MAX_RESULTS');
  });

  it('still injects with every UPS numeric knob set to garbage at once', async () => {
    const { dir, targetId } = seed();
    const { stdout } = await runHook(
      dir,
      {
        CLAUDE_MEM_UPS_MAX_RESULTS: 'abc',
        CLAUDE_MEM_UPS_PROMPT_FALLBACK_LIMIT: 'abc',
        CLAUDE_MEM_UPS_BM25_MIN: 'abc',
        CLAUDE_MEM_UPS_BM25_MIN_FOLLOWUP: 'abc',
        CLAUDE_MEM_UPS_TOP_MIN: 'abc',
        CLAUDE_MEM_UPS_OR_BM25_MIN: 'abc',
        CLAUDE_MEM_UPS_FLOOR_REF_CORPUS: 'abc',
      },
      'env-garbage-all',
    );
    expect(stdout).toContain(`#${targetId}`);
  });

  it('the LOW values these knobs are documented to take are not "invalid"', async () => {
    // Earned, not hypothetical: the first cut of this guard gave FLOOR_REF_CORPUS a
    // `min: 2` on the reasoning that maxIdf is 0 below n=2. corpusFloorScale already
    // handles that (`ref <= 1` returns 1, and so does `!(refIdf > 0)`), and 1 is the
    // documented way to pin the corpus ramp OFF — two cases in user-prompt-search.test
    // depend on it. min 2 silently replaced it with 584 and unfired both floor gates.
    // A range bound is a behaviour change; it has to be read off the consumer, not
    // reasoned about from the name.
    const { dir } = seed();
    const { stderr } = await runHook(
      dir,
      {
        CLAUDE_MEM_UPS_FLOOR_REF_CORPUS: '1',
        CLAUDE_MEM_UPS_PROMPT_FALLBACK_LIMIT: '0',
        CLAUDE_MEM_UPS_MAX_RESULTS: '0',
        // The POSITIVE premise, and it is load-bearing: every other assertion here is a
        // `not.toContain`, which a process that died before parsing any env satisfies just
        // as well as one that accepted all three. The pre-tag review proved it — with
        // `process.exit(0)` at the top of the hook, four of the five e2e cases went red and
        // this one stayed green. A garbage knob cannot be swapped for one of the three above
        // (MAX_RESULTS='0' makes stdout empty by design, so stdout is no use here); a fourth
        // one that MUST warn is what shows the process reached env parsing at all.
        CLAUDE_MEM_UPS_BM25_MIN: 'zzz',
      },
      'env-low',
    );
    expect(
      stderr,
      'the hook never reached env parsing — the negative assertions below are vacuous',
    ).toContain('CLAUDE_MEM_UPS_BM25_MIN');
    for (const knob of [
      'CLAUDE_MEM_UPS_FLOOR_REF_CORPUS',
      'CLAUDE_MEM_UPS_PROMPT_FALLBACK_LIMIT',
      'CLAUDE_MEM_UPS_MAX_RESULTS',
    ]) {
      expect(stderr, `${knob} rejected a value the code documents as meaningful`).not.toContain(knob);
    }
  });

  it('an explicit 0 on the floor knob still means "kill the absolute floors"', async () => {
    // The documented seed-mode switch. Guards against a fix that treats 0 as invalid.
    const { dir, targetId } = seed();
    const { stdout, stderr } = await runHook(dir, { CLAUDE_MEM_UPS_TOP_MIN: '0' }, 'env-zero');
    expect(stdout).toContain(`#${targetId}`);
    expect(stderr, '0 is a valid value and must not warn').not.toContain('CLAUDE_MEM_UPS_TOP_MIN');
  });
});
