// D#136: the error-recall surface was searching the COMMAND's topic, not the error.
//
// Root cause (diagnosed 2026-08-22 against the live DB, obs #10730): the surface fires
// on detectBashSignificance's isHardError, but that gate and the error-LINE filter use
// DIFFERENT pattern lists. HARD_ERROR_RE accepts `ERR!`, `enoent`, `traceback`; the
// line filter only matches the whole word `error`. npm's own failure output clears the
// trigger and yields ZERO error lines — `npm ERR! code ENOENT … no such file or
// directory` has no `error`, no `fail`, no `not found`. The keyword set then degraded
// to pure command words (['npm','run','build']) and the FTS query searched the
// COMMAND'S TOPIC rather than the failure. Same shape for a Python traceback's head.
//
// A second mechanism was diagnosed at the same time — command words and error tokens
// share ONE OR-query with equal weight, and `npm`/`run`/`grep` are generic enough to
// dominate BM25 — but demoting them was TRIED AND REJECTED on measurement (see the
// replay evidence on the second describe block below). Command words turned out to
// carry domain anchoring. Only the gate ships.
//
// planErrorRecall() is the decision seam (same discipline as formatErrorRecallHints
// in format-utils.mjs — pure, so the gate is testable without spawning the hook):
//   - no error-signal tokens → null, i.e. DO NOT inject
//   - otherwise → the same merged term list extractErrorKeywords already produced
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { planErrorRecall, extractErrorKeywords, detectBashSignificance } from '../bash-utils.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI_PATH = join(REPO, 'cli.mjs');
const HOOK_PATH = join(REPO, 'hook.mjs');

// npm's real ENOENT output — the highest-frequency shape that reaches this surface
// with no error-signal token in it.
const NPM_ENOENT_OUT = [
  'npm ERR! code ENOENT',
  'npm ERR! syscall open',
  'npm ERR! path /x/package.json',
  'npm ERR! errno -2',
  "npm ERR! enoent ENOENT: no such file or directory, open '/x/package.json'",
].join('\n');
const PY_TRACEBACK_HEAD =
  'Traceback (most recent call last):\n  File "train.py", line 42, in <module>\n    main()';
const NPM_BUILD_OUT =
  "Error: Cannot find module './lib/observation-write.mjs'\n    at Module._resolveFilename";

// The line filter is the TRIGGER's own pattern list OR'd with the prose one, so
// "isHardError fired but the extractor found nothing" is closed by construction rather
// than by enumerating failure shapes. Every case below is a shape that reaches this
// surface (isHardError true) and whose discriminative tokens live in a line the prose
// filter alone does not match.
describe('planErrorRecall — the selection filter is a superset of the trigger', () => {
  const reaches = (cmd, out) => {
    expect(
      detectBashSignificance({ command: cmd }, out).isHardError,
      'precondition: this shape must reach the surface, else the case proves nothing',
    ).toBe(true);
  };

  it('npm ENOENT queries the ERROR, not the command topic', () => {
    reaches('npm run build', NPM_ENOENT_OUT);
    // The defect was that every discriminative token got dropped and the query became
    // the command's own words (['npm','run','build']), so the surface searched for
    // observations about npm rather than about the failure.
    const terms = planErrorRecall('npm run build', NPM_ENOENT_OUT).terms;
    expect(terms).toContain('enoent');
    expect(terms).toContain('syscall');
    // Both entry points share one extractor — they must not drift into two dialects,
    // which is the class of defect this whole change is about.
    expect(terms).toEqual(extractErrorKeywords('npm run build', NPM_ENOENT_OUT));
  });

  it('a Go panic keeps recall — and does not depend on the word "error" appearing in it', () => {
    // Both are panics; only the second happens to contain the substring "error"
    // (in "runtime error"). Before this filter, the first was silenced and the second
    // was not — the same trigger/selection divergence, relocated to panic wording.
    const NIL_MAP =
      'panic: assignment to entry in nil map\n\ngoroutine 1 [running]:\nmain.main()\n\t/app/main.go:12 +0x1d\nexit status 2';
    const RUNTIME = 'panic: runtime error: index out of range [3] with length 2\n\ngoroutine 1 [running]:';
    reaches('go run main.go', NIL_MAP);
    reaches('go test ./...', RUNTIME);
    const a = planErrorRecall('go run main.go', NIL_MAP);
    const b = planErrorRecall('go test ./...', RUNTIME);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a.terms).toContain('panic');
    expect(a.terms).toContain('assignment');
    expect(b.terms).toContain('panic');
  });

  it('a truncated Python traceback keeps recall via the traceback anchor', () => {
    reaches('python train.py', PY_TRACEBACK_HEAD);
    expect(planErrorRecall('python train.py', PY_TRACEBACK_HEAD).terms).toContain('traceback');
  });
});

// The failure's NAME is prepended to the query (D#167). Review found that only the
// "namer on vs off" distinction was pinned: three of the four alternatives in
// ERROR_NAMER_RE could be deleted, and the count could be raised back to the value the
// release explicitly measured against, with the whole suite staying green.
describe('planErrorRecall — the failure NAMER', () => {
  it('errno-style codes (ENOENT/EACCES) are names, and they lead', () => {
    // Dropping the `E[A-Z]{3,}` alternative demotes `enoent` behind `code`; nothing
    // caught that before. `syscall` must survive too — prepending must not evict it.
    const terms = planErrorRecall('npm run build', NPM_ENOENT_OUT).terms;
    expect(terms.indexOf('enoent')).toBeGreaterThanOrEqual(0);
    expect(terms.indexOf('enoent')).toBeLessThan(terms.indexOf('code'));
    expect(terms).toContain('syscall');
  });

  it('a signal name is a name — SIGSEGV survives the scan that would drop it', () => {
    // `Segmentation fault (core dumped)` has no error-word tokens of its own worth
    // keeping; without the SIG alternative the failure's identity is lost entirely.
    const out = 'a.out: fatal signal SIGSEGV detected\nSegmentation fault (core dumped)';
    expect(planErrorRecall('./a.out --run', out).terms).toContain('sigsegv');
  });

  it("Rust's `panicked` is a name — the word-boundary miss that started this", () => {
    // `HARD_ERROR_RE`'s `\bpanic\b` famously does not match `panicked`; the namer must.
    const out = "thread 'main' panicked at src/lib.rs:42:\nassertion failed: unwrap on a None value";
    expect(planErrorRecall('cargo test', out).terms).toContain('panicked');
  });

  it('the uppercase literal ERROR is NOT a name — the stop-word interaction is load-bearing', () => {
    // `E[A-Z]{3,}` matches the bare word `ERROR`; ERROR_STOP_WORDS is what drops it.
    // Remove that check and `error` occupies a slot, evicting a real token — the
    // docblock calls the interaction load-bearing, so it gets an assertion.
    const terms = planErrorRecall('make build', 'ERROR: linker command failed, symbol not found').terms;
    expect(terms).not.toContain('error');
    expect(terms).toContain('linker');
  });

  it('only ONE name jumps the queue — the cap the sweep chose over the one it shipped with', () => {
    // ERROR_NAMER_MAX went 2 → 1 on measured data (22.4%/21.5% vs 22.8%/22.0% live).
    // A chained traceback carries two names, so it is the shape that distinguishes them:
    // at 2, `modulenotfounderror` also jumps in and evicts a scanned term.
    const chained = [
      'Traceback (most recent call last):',
      '  File "x.py", line 3, in <module>',
      "ValueError: invalid literal for int() with base 10: 'x'",
      '',
      'During handling of the above exception, another exception occurred:',
      '',
      'Traceback (most recent call last):',
      "ModuleNotFoundError: No module named 'clientlib'",
    ].join('\n');
    const terms = planErrorRecall('python3 x.py', chained).terms;
    expect(terms).toContain('valueerror');
    expect(
      terms,
      'a second name must not jump the queue — it evicts a scanned term for a duplicate class name',
    ).not.toContain('modulenotfounderror');
  });
});

describe('planErrorRecall — gate (nothing to recall ON ⇒ no injection)', () => {
  it('returns null when the output is empty or whitespace', () => {
    expect(planErrorRecall('npm run build', '')).toBeNull();
    expect(planErrorRecall('npm run build', '   \n  \n')).toBeNull();
  });

  it('does NOT fall back to command words when the error line yields only stop words', () => {
    // 'Error:' / 'failed' are in ERROR_STOP_WORDS and the rest are <=3 chars — the line
    // matches, but nothing discriminative survives, so there is still nothing to query.
    expect(planErrorRecall('npm run build', 'Error: it failed')).toBeNull();
  });
});

// Each case below pins a constant or an ordering that a mutation was shown to flip while
// the suite stayed green. They are here because a reviewer mutated them and nothing died.
describe('planErrorRecall — term-selection internals that mutation showed were unpinned', () => {
  it('honours every alternative of the line filter, not just "error"', () => {
    // Narrowing the filter to /error|fail|exception/i flips this from inject to silent,
    // and `command not found` is itself a trigger alternative — one of the shapes most
    // certain to arrive here.
    const out = 'deploy.sh: line 4: kubectl: command not found';
    expect(detectBashSignificance({ command: 'bash deploy.sh' }, out).isHardError).toBe(true);
    expect(planErrorRecall('bash deploy.sh', out).terms).toContain('kubectl');
    // `undefined` / `cannot` as the sole anchor must work too.
    expect(planErrorRecall('node x.mjs', 'result is undefined for scopeLabel').terms).toContain('scopelabel');
  });

  it('scans more than the first matching line for discriminative tokens', () => {
    // Line 1 carries only stop words; everything useful is on line 2. Narrowing the
    // per-response line budget to 1 flips this to silent.
    const out = 'Error: build failed\nTypeError: scopeLabel is undefined in observation-write.mjs';
    expect(detectBashSignificance({ command: 'npm run build' }, out).isHardError).toBe(true);
    expect(planErrorRecall('npm run build', out).terms).toContain('observation-write.mjs');
  });

  it('pins the merged ORDER, not just membership — the cap truncates by order', () => {
    // Golden list. Membership-only assertions let the two arrays swap places while the
    // suite stays green, and with >6 candidates that silently changes WHICH terms the
    // 6-cap keeps — i.e. it changes the query without changing any test.
    const out =
      'FAIL tests/scope-label.test.mjs\nAssertionError: expected observation-write.mjs to be defined';
    expect(planErrorRecall('npx vitest run tests/scope-label.test.mjs', out).terms).toEqual([
      'npx',
      'vitest',
      'run',
      'assertionerror',
      'fail',
      'tests',
    ]);
    // THE PRICE OF THE NAMER, recorded rather than smoothed over. This list used to end
    // `fail, tests, scope-label.test.mjs`; prepending the failure's name evicted the
    // tail, and the tail was the most discriminative token in it — a filename has far
    // higher IDF than the word `assertionerror`. On this shape the trade is a loss.
    // It ships anyway because the shapes it wins are both more common and worse off:
    // measured over 52 real failing commands, 25 of the 28 that name their failure were
    // querying pure boilerplate (`traceback, most, recent`) before this.
    // The follow-up it argues for — a cap that evicts the LEAST discriminative term
    // instead of the last one (D#169) — was BUILT AND MEASURED, and it is worse: on the
    // live DB, command-vocabulary-only injections went 22.6% -> 35.8% and top-1 21.3% ->
    // 33.4%. See the cap's docblock in bash-utils.mjs for the mechanism. So this case
    // records a real local loss inside a rule that wins globally; do not "fix" it with a
    // shape heuristic, because that specific fix has already been tried.
  });

  it('dedups ACROSS command and error classes so a repeat cannot burn a cap slot', () => {
    // 'build' appears in both the command and the error line; it must occupy one slot.
    const terms = planErrorRecall(
      'npm run build',
      'Error: build failed while bundling build.config.mjs',
    ).terms;
    expect(terms.filter((t) => t === 'build')).toHaveLength(1);
    expect(terms).toEqual(['npm', 'run', 'build', 'while', 'bundling']);
  });
});

// Dropping command words from the query was tried and REJECTED on measurement —
// replaying five real failures against the live DB, error-terms-only fixed the
// missing-module case but lost #8673 for a failed DB open (dropped `database`) and
// #8725 for a test failure (dropped `vitest`). These lock in that command words stay,
// so a future "obvious cleanup" has to re-measure rather than re-break it.
describe('planErrorRecall — term selection deliberately unchanged', () => {
  it('keeps the discriminative error token in the query', () => {
    const plan = planErrorRecall('npm run build', NPM_BUILD_OUT);
    expect(plan).not.toBeNull();
    expect(plan.terms).toContain('observation-write.mjs');
  });

  it('KEEPS command words — they carry domain anchoring, not just BM25 noise', () => {
    const plan = planErrorRecall(
      'npx vitest run tests/scope-label.test.mjs',
      'FAIL tests/scope-label.test.mjs\nError: expected 2 to be 3',
    );
    expect(plan).not.toBeNull();
    // `vitest` is exactly the anchor whose removal cost #8725 in the replay.
    expect(plan.terms).toContain('vitest');
  });

  it('emits the same merged term list as extractErrorKeywords when it fires', () => {
    // The gate changes WHETHER we query, never WITH WHAT — this is the invariant
    // that keeps the fix from silently becoming a retrieval change too.
    const plan = planErrorRecall('npm run build', NPM_BUILD_OUT);
    expect(plan.terms).toEqual(extractErrorKeywords('npm run build', NPM_BUILD_OUT));
  });

  it('caps the query so one noisy stack frame cannot explode the OR-query', () => {
    const noisy = Array.from({ length: 40 }, (_, i) => `Error: distinctToken${i}Failure at frame${i}`).join(
      '\n',
    );
    const plan = planErrorRecall('cmd', noisy);
    expect(plan).not.toBeNull();
    expect(plan.terms.length).toBeLessThanOrEqual(6);
  });
});

describe('extractErrorKeywords — existing contract unchanged (regression)', () => {
  it('still returns command words merged with error tokens', () => {
    const result = extractErrorKeywords('npm install express', 'Error: EACCES permission denied');
    expect(result).toContain('npm');
    expect(result).toContain('install');
    expect(result).toContain('express');
  });

  it('still returns null when nothing survives filtering', () => {
    expect(extractErrorKeywords('', '')).toBeNull();
  });
});

// ─── Wiring (the seam the unit tests above canNOT reach) ────────────────────
//
// planErrorRecall is pure, so nothing above proves hook.mjs actually consults it —
// deleting `if (!plan) return;` leaves every unit test green. That gap is not
// hypothetical: this same change first shipped with hook.mjs importing planErrorRecall
// from utils.mjs, which did not re-export it, and hook.mjs failed to load entirely.
// These two cases drive the real PostToolUse entry point.
describe('error-recall wiring: hook.mjs honours the gate', () => {
  let ROOT, HOME_DIR, BASE_ENV, dataDir, cwd;
  let baitCommandTopicId, baitErrorTopicId;

  beforeAll(async () => {
    ROOT = mkdtempSync(join(tmpdir(), 'mem-errgate-'));
    HOME_DIR = join(ROOT, 'home');
    mkdirSync(join(HOME_DIR, '.claude'), { recursive: true });
    dataDir = join(ROOT, 'data');
    cwd = join(ROOT, 'proj');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });

    BASE_ENV = { ...process.env };
    for (const k of Object.keys(BASE_ENV)) {
      if (/^(CLAUDE_MEM_|MEM_|CLAUDE_PLUGIN_)/.test(k)) delete BASE_ENV[k];
    }
    Object.assign(BASE_ENV, {
      HOME: HOME_DIR,
      CLAUDE_CODE_PATH: join(ROOT, 'no-such-claude-binary'), // no LLM spend, no network
      ANTHROPIC_API_KEY: '',
      OPENROUTER_API_KEY: '',
      CLAUDE_MEM_SKIP_UPDATE: '1',
      CLAUDE_MEM_SKIP_EPISODE_LLM: '1',
      CLAUDE_MEM_SKIP_COMPRESS: '1',
      CLAUDE_MEM_SKIP_OPTIMIZE: '1',
      CLAUDE_MEM_SKIP_MAINTAIN: '1',
      CLAUDE_MEM_SKIP_SAVE_ENRICH: '1',
      CLAUDE_MEM_SKIP_REPOS: '1',
      CLAUDE_MEM_NO_DELAY: '1',
      CLAUDE_MEM_DIR: dataDir,
    });
    delete BASE_ENV.CLAUDE_PROJECT_DIR;
    delete BASE_ENV.PWD;

    // Two rows that COMPETE: one matches the command's words, one matches the failure.
    // The whole point of the change is which of them a failed `npm run build` recalls,
    // so a test that seeds only one of them cannot tell the fix from the defect.
    const decoy = await fire(
      process.execPath,
      [
        CLI_PATH,
        'save',
        'Recovering an npm run build that fails during the bundle step',
        '--type',
        'bugfix',
        '--importance',
        '3',
        '--lesson',
        'npm run build recovery: clear the cache before rebuilding',
      ],
      { cwd },
    );
    expect(decoy.code, decoy.stderr).toBe(0);
    baitCommandTopicId = Number(decoy.stdout.match(/#(\d+)/)[1]);
    const real = await fire(
      process.execPath,
      [
        CLI_PATH,
        'save',
        'A missing package.json makes the launcher die with ENOENT on syscall open',
        '--type',
        'bugfix',
        '--importance',
        '3',
        '--lesson',
        'ENOENT from syscall open means the manifest is absent, not that a dependency is missing',
      ],
      { cwd },
    );
    expect(real.code, real.stderr).toBe(0);
    baitErrorTopicId = Number(real.stdout.match(/#(\d+)/)[1]);
    const vitestRow = await fire(
      process.execPath,
      [
        CLI_PATH,
        'save',
        'A vitest suite that fails only on the shared sqlite temp file',
        '--type',
        'bugfix',
        '--importance',
        '3',
        '--lesson',
        'vitest fail: run the suite alone, the shared temp file races',
      ],
      { cwd },
    );
    expect(vitestRow.code, vitestRow.stderr).toBe(0);
  });

  afterAll(async () => {
    await new Promise((r) => setTimeout(r, 300));
    try {
      rmSync(ROOT, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  function fire(cmd, args, { cwd: dir, stdin = '', timeout = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { cwd: dir, env: BASE_ENV, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '',
        stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('timeout'));
      }, timeout);
      child.stdout.on('data', (d) => {
        stdout += d;
      });
      child.stderr.on('data', (d) => {
        stderr += d;
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
      child.stdin.on('error', () => {});
      child.stdin.end(stdin);
    });
  }

  async function firePostTool(command, response) {
    const r = await fire(process.execPath, [HOOK_PATH, 'post-tool-use'], {
      cwd,
      stdin: JSON.stringify({
        session_id: 'cc-errgate',
        tool_name: 'Bash',
        tool_input: { command },
        tool_response: response,
      }),
    });
    expect(r.code, `post-tool-use exited ${r.code}\n${r.stderr}`).toBe(0);
    const block = r.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .map((e) => e?.hookSpecificOutput?.additionalContext)
      .find((c) => typeof c === 'string' && c.includes('Related memories found for this error'));
    return { block, stdout: r.stdout };
  }

  it('recalls the ERROR-topic row for npm ENOENT, not the command-topic row', async () => {
    const { block, stdout } = await firePostTool('npm run build', NPM_ENOENT_OUT);
    // Positive proof-of-life first: "nothing was injected" must not be able to satisfy
    // this case, which is exactly how the previous version of this test could pass for
    // the wrong reason.
    expect(block, `error-recall did not fire at all:\n${stdout}`).toBeTruthy();
    // The load-bearing assertion. That row's text carries no `npm`, `run` or `build`,
    // so the old command-word-only query could not reach it at all — its presence here
    // is only possible because `enoent`/`syscall` now enter the query.
    expect(block, 'the ENOENT/syscall row is the one that explains this failure').toContain(
      `#${baitErrorTopicId}`,
    );
    // The command-topic row is still recalled, and that is CORRECT, not a leak: command
    // words are kept on purpose (they carry domain anchoring — measured, see the commit
    // body), so the OR-query legitimately still matches it. Asserting its presence also
    // keeps the case honest — it proves the seeded store is reachable at all, so the
    // assertion above cannot pass on an empty or misrouted DB.
    expect(block, 'the command-topic row remains reachable — command words are retained').toContain(
      `#${baitCommandTopicId}`,
    );
  }, 40000);

  it('still injects for a failure that DOES carry error signal (the gate is not a mute button)', async () => {
    const { block, stdout } = await firePostTool(
      'npx vitest run tests/a.test.mjs',
      'FAIL tests/a.test.mjs > shared temp file\nAssertionError: expected 2 to be 3',
    );
    expect(block, `error-recall did not fire on a real error:\n${stdout}`).toBeTruthy();
  }, 40000);
});
