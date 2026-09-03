// Feature sweep: every entry of CLI_COMMANDS (cli.mjs:2) driven through the REAL
// entry point as a subprocess.
//
// WHY THIS FILE EXISTS (it is not a duplicate of cli-e2e.test.mjs):
// cli-e2e.test.mjs is a regression museum — it pins the specific bugs that were
// found and fixed, command by command, and only for the commands that ever broke.
// Nothing in the repo asserts that ALL 28 routed commands still route, parse their
// arguments, and emit their documented shape. That gap is exactly how v2.32.3
// shipped with `adopt`/`unadopt` missing from CLI_COMMANDS and v2.71.0 shipped
// without `import-jsonl`: the unit tests called the handler directly, so the broken
// wiring was invisible. One test case per command, named after the command, so a
// failure names the surface immediately.
//
// ISOLATION CONTRACT (all four are load-bearing — see the sandbox setup below):
//   1. CLAUDE_MEM_DIR → a mkdtempSync sandbox. vitest.config.mjs sets it to '' for
//      the runner, which makes children fall back to the LIVE ~/.claude DB unless
//      each child sets it explicitly. Every runCli() call does.
//   2. cwd + PWD + CLAUDE_PROJECT_DIR → a sandbox dir. adopt / unadopt /
//      memdir-audit write <cwd>/CLAUDE.md and <cwd>/.claude/. execFileSync's `cwd`
//      option does NOT update the inherited PWD env var, so PWD must be re-injected
//      or a drill launched from the repo would rewrite the repo's own CLAUDE.md.
//      afterAll asserts the repo CLAUDE.md is byte-identical as a regression net.
//   3. No LLM, no network. CLAUDE_CODE_PATH points at a path that does not exist,
//      so haiku-client's CLI mode (its default when no API key is set) fails fast
//      instead of spawning a real `claude`; the API keys stay empty (vitest global);
//      CLAUDE_MEM_SKIP_SAVE_ENRICH=1 stops `save` from queueing a background
//      enrichment worker. `import` is exercised only on its pre-fetch validation
//      path (parseGitHubUrl throws "Invalid GitHub URL" before the first fetch).
//   4. afterAll removes the sandbox. The dir prefix is `mem-` so global-setup.mjs
//      reaps it even if the run is SIGKILL'd before afterAll.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_PATH = join(REPO, 'cli.mjs');
const REPO_CLAUDE_MD = join(REPO, 'CLAUDE.md');

// The 28 routed commands, pinned here on purpose. The `help` case closes BOTH drift
// directions around this literal, which on its own proves nothing:
//   (a) router ↔ literal — the CLI_COMMANDS literal in cli.mjs must equal this list;
//   (b) literal ↔ coverage — the set of case names actually registered via itCmd()
//       below must equal this list too. Without (b), adding `foo` to the router and
//       to this array would go green with zero coverage for `foo`; with it, the only
//       way to green is an `itCmd('foo', …)` case that really drives the command.
const EXPECTED_CLI_COMMANDS = [
  'search', 'recent', 'recall', 'get', 'timeline', 'save', 'stats', 'context',
  'browse', 'citation-stats', 'delete', 'update', 'export', 'restore', 'compress',
  'maintain', 'optimize', 'fts-check', 'registry', 'import', 'import-jsonl',
  'enrich', 'activity', 'adopt', 'unadopt', 'memdir-audit', 'defer', 'help',
];

// Every per-command case registers through itCmd so the coverage guard reads the
// REAL registered set, not a third hand-maintained list. Collection runs every
// describe callback before the first test executes, so COVERED_COMMANDS is complete
// by the time any assertion runs, wherever the guard lives in the file.
const COVERED_COMMANDS = new Set();
function itCmd(command, fn, timeout) {
  if (COVERED_COMMANDS.has(command)) throw new Error(`duplicate sweep case for "${command}"`);
  COVERED_COMMANDS.add(command);
  return it(command, fn, timeout);
}

let ROOT, DATA_DIR, WORK_DIR, ADOPT_DIR, UNADOPT_DIR, repoClaudeMdSnapshot, BASE_ENV;

// inferProject() derives "<parent>--<dir>" from the project dir. WORK_DIR is
// <sandbox>/work/sweepproj, so this is deterministic; the `recent` case asserts it.
const PROJECT = 'work--sweepproj';

function runCli(args, { cwd = WORK_DIR, env = {} } = {}) {
  const merged = { ...BASE_ENV, PWD: cwd, CLAUDE_PROJECT_DIR: cwd, ...env };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  try {
    const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
      cwd, env: merged, encoding: 'utf8', timeout: 20000, stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (e) {
    return {
      stdout: e.stdout?.toString() || '',
      stderr: e.stderr?.toString() || '',
      exitCode: e.status ?? 1,
    };
  }
}

/** Run and require exit 0, surfacing stderr in the failure message. */
function ok(args, opts) {
  const r = runCli(args, opts);
  expect(r.exitCode, `\`${args.join(' ')}\` exited ${r.exitCode}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`).toBe(0);
  return r;
}

const jsonOf = (r) => JSON.parse(r.stdout);

/** Open the sandbox DB read-only-ish for independent verification of writes. */
function withDb(fn) {
  const db = new Database(join(DATA_DIR, 'claude-mem-lite.db'));
  try { return fn(db); } finally { try { db.close(); } catch { /* already closed */ } }
}

/** Backdate every row of a project so age-gated commands (compress/maintain) engage. */
function ageProject(project, days) {
  return withDb((db) => {
    const epoch = Date.now() - days * 86400000;
    return db.prepare('UPDATE observations SET created_at_epoch = ?, created_at = ? WHERE project = ?')
      .run(epoch, new Date(epoch).toISOString(), project).changes;
  });
}

const savedId = (r) => {
  const m = r.stdout.match(/\[mem\] Saved #(\d+)/);
  expect(m, `expected a "Saved #N" confirmation, got: ${r.stdout}`).toBeTruthy();
  return Number(m[1]);
};

/** Write a minimal but real Claude Code transcript (prompt + tool_use + tool_result). */
function writeTranscript(path, sessionId) {
  writeFileSync(path, [
    JSON.stringify({ type: 'user', sessionId, timestamp: '2026-08-01T10:00:00.000Z', message: { role: 'user', content: 'look into the retry backoff' } }),
    JSON.stringify({ type: 'assistant', sessionId, timestamp: '2026-08-01T10:00:01.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/p/retry.mjs' } }] } }),
    JSON.stringify({ type: 'user', sessionId, timestamp: '2026-08-01T10:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'contents' }] } }),
  ].join('\n') + '\n');
}

/** A local SKILL.md the registry can import without touching the network. */
/**
 * A skill fixture at an arbitrary path OUTSIDE the managed data dir.
 *
 * Fine for `registry import`, which only records the path. NOT what `enrich` reads —
 * see writeManagedSkill.
 */
function writeSkill(name) {
  const dir = join(ROOT, 'skills', name);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'SKILL.md');
  writeFileSync(p, `---\nname: ${name}\ndescription: sweep fixture skill for ${name}\n---\n\nBody.\n`);
  return p;
}

/**
 * The same fixture where a real imported resource actually lands: under
 * `<CLAUDE_MEM_DIR>/managed/`, which is what registry-importer writes.
 *
 * Audit P1-3 put the path-confinement gate on all four enrichment legs, so a fixture
 * parked next to the sandbox (ROOT/skills) is now refused before the enricher is called —
 * which is correct behaviour, and would silently turn the `enrich --all` case into an
 * assertion about refusals rather than about an unreachable LLM.
 */
function writeManagedSkill(name) {
  const dir = join(DATA_DIR, 'managed', 'skills', name);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'SKILL.md');
  writeFileSync(p, `---\nname: ${name}\ndescription: sweep fixture skill for ${name}\n---\n\nBody.\n`);
  return p;
}

// Seeded ids, filled in beforeAll.
let SEED_BUGFIX_ID, SEED_DECISION_ID, SEED_DISCOVERY_ID, SEED_DEFER_ID;
const SEED_LESSON = 'Invalidate the widget cache on write, never on read';

beforeAll(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'mem-featsweep-'));
  DATA_DIR = join(ROOT, 'data');
  WORK_DIR = join(ROOT, 'work', 'sweepproj');
  ADOPT_DIR = join(ROOT, 'work', 'adoptproj');
  // Separate dir so the `unadopt` case owns its own adopted state instead of consuming
  // the one `adopt` left behind — the case then passes or fails on its own merits under
  // -t unadopt / --sequence.shuffle, not on vitest's in-file ordering.
  UNADOPT_DIR = join(ROOT, 'work', 'unadoptproj');
  mkdirSync(join(ROOT, 'home', '.claude'), { recursive: true });
  mkdirSync(WORK_DIR, { recursive: true });
  mkdirSync(ADOPT_DIR, { recursive: true });
  mkdirSync(UNADOPT_DIR, { recursive: true });
  repoClaudeMdSnapshot = existsSync(REPO_CLAUDE_MD) ? readFileSync(REPO_CLAUDE_MD, 'utf8') : null;

  BASE_ENV = {
    ...process.env,
    HOME: join(ROOT, 'home'),
    CLAUDE_MEM_DIR: DATA_DIR,
    // haiku-client detectMode() falls back to 'cli' with no API key and would spawn
    // the real `claude`. Point it at a path that cannot exist → fail fast, no spend.
    CLAUDE_CODE_PATH: join(ROOT, 'no-such-claude-binary'),
    ANTHROPIC_API_KEY: '',
    OPENROUTER_API_KEY: '',
    CLAUDE_MEM_AUTO_DEEP: '0',
    CLAUDE_MEM_AUTO_DEEP_CLI: '0',
    CLAUDE_MEM_SKIP_SAVE_ENRICH: '1',
    CLAUDE_MEM_SKIP_REPOS: '1',
  };
  delete BASE_ENV.CLAUDE_MEM_HOOK_RUNNING;

  // ── Seed: three distinct observations in the default project. Distinct wording
  // matters — `save` dedups near-identical text within a 5 minute window.
  SEED_BUGFIX_ID = savedId(ok([
    'save', 'Fixed the widget cache invalidation race in lib/widget-cache.mjs',
    '--type', 'bugfix', '--importance', '3',
    '--lesson', SEED_LESSON, '--files', 'lib/widget-cache.mjs',
  ]));
  SEED_DECISION_ID = savedId(ok([
    'save', 'Chose a write-through widget layer over read-through for predictable latency',
    '--type', 'decision', '--importance', '2',
  ]));
  SEED_DISCOVERY_ID = savedId(ok([
    'save', 'Discovered the retry backoff timer resets on every redirect hop',
    '--type', 'discovery', '--importance', '2',
  ]));

  const deferAdd = ok(['defer', 'add', 'Benchmark the widget cache under load', '--priority', '3', '--detail', 'needs a load fixture first']);
  SEED_DEFER_ID = Number(deferAdd.stdout.match(/Deferred as D#(\d+)/)[1]);
}, 60000);

afterAll(() => {
  // Regression net for isolation contract #2: the sweep must never have touched the
  // repo's own CLAUDE.md (adopt/unadopt/memdir-audit write to <cwd>). The assertion
  // lives in the try so that FIRING it still removes the sandbox — cleanup must hold
  // on failure, which is exactly the run where a leaked drill dir is most likely.
  try {
    if (repoClaudeMdSnapshot !== null) {
      expect(readFileSync(REPO_CLAUDE_MD, 'utf8')).toBe(repoClaudeMdSnapshot);
    }
  } finally {
    try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// ─── Read surfaces ───────────────────────────────────────────────────────────

describe('CLI feature sweep: read commands', () => {
  itCmd('search', () => {
    const all = jsonOf(ok(['search', 'widget', '--project', PROJECT, '--json']));
    expect(all.total).toBeGreaterThanOrEqual(2);
    expect(all.results.map(r => r.id)).toContain(SEED_BUGFIX_ID);

    // --type must actually narrow, not be silently dropped.
    const narrowed = jsonOf(ok(['search', 'widget', '--project', PROJECT, '--type', 'decision', '--json']));
    expect(narrowed.results.map(r => r.id)).toEqual([SEED_DECISION_ID]);
    expect(narrowed.results.length).toBeLessThan(all.results.length);
  });

  itCmd('recent', () => {
    const data = jsonOf(ok(['recent', '2', '--project', PROJECT, '--json']));
    expect(data.project).toBe(PROJECT);   // pins inferProject()'s <parent>--<dir> shape
    expect(data.limit).toBe(2);
    expect(data.results).toHaveLength(2);
    expect(typeof data.results[0].id).toBe('number');
    expect(typeof data.results[0].created_at_epoch).toBe('number');
  });

  itCmd('recall', () => {
    const data = jsonOf(ok(['recall', 'widget-cache.mjs', '--json']));
    expect(data.file).toBe('widget-cache.mjs');
    expect(data.total).toBe(1);
    expect(data.results[0].id).toBe(SEED_BUGFIX_ID);
    expect(data.results[0].lesson_learned).toBe(SEED_LESSON);
  });

  itCmd('get', () => {
    const r = ok(['get', String(SEED_BUGFIX_ID)]);
    expect(r.stdout).toContain(`#${SEED_BUGFIX_ID} [bugfix]`);
    expect(r.stdout).toContain('Fixed the widget cache invalidation race');
    expect(r.stdout).toContain(`lesson_learned: ${SEED_LESSON}`);
    expect(r.stdout).toContain('importance: 3');
    expect(r.stdout).toContain('lib/widget-cache.mjs');

    // D# prefix routes to deferred_work, not observations (#5545: prefix-sensitive).
    const deferred = ok(['get', `D#${SEED_DEFER_ID}`]);
    expect(deferred.stdout).toContain(`D#${SEED_DEFER_ID}`);
    expect(deferred.stdout).toContain('deferred (open)');
    expect(deferred.stdout).toContain('needs a load fixture first');
  });

  itCmd('timeline', () => {
    // The three seeds were saved in order (bugfix → decision → discovery) by three
    // separate subprocesses, so their created_at_epoch values are strictly increasing
    // and the window around the middle one is fully determined: WHICH row lands in
    // `before` vs `after` is asserted, not just that both are arrays. A before/after
    // inversion (or a window leg dropping its project filter) fails here.
    const data = jsonOf(ok(['timeline', '--anchor', String(SEED_DECISION_ID), '--before', '1', '--after', '1', '--project', PROJECT, '--json']));
    expect(data.anchor.id).toBe(SEED_DECISION_ID);
    expect(data.before.map(r => r.id)).toEqual([SEED_BUGFIX_ID]);
    expect(data.after.map(r => r.id)).toEqual([SEED_DISCOVERY_ID]);
  });

  itCmd('stats', () => {
    const data = jsonOf(ok(['stats', '--days', '30', '--json']));
    expect(data.days).toBe(30);
    expect(data.totals.observations).toBeGreaterThanOrEqual(3);
    const types = data.type_distribution.map(t => t.type);
    expect(types).toEqual(expect.arrayContaining(['bugfix', 'decision', 'discovery']));
    expect(data.tier_distribution).toHaveProperty('working');
    // Data dir must name the sandbox, never the live DB (D#92 chain).
    expect(ok(['stats']).stdout).toContain(`Data dir: ${DATA_DIR}`);
  });

  itCmd('context', () => {
    const r = ok(['context', '--project', PROJECT]);
    expect(r.stdout).toContain('<claude-mem-context>');
    expect(r.stdout).toContain('</claude-mem-context>');
    expect(r.stdout).toContain('Fixed the widget cache invalidation race');
    expect(r.stdout).toContain(`D#${SEED_DEFER_ID}`);   // deferred work section is wired
  });

  itCmd('browse', () => {
    const data = jsonOf(ok(['browse', '--project', PROJECT, '--limit', '5', '--json']));
    expect(data.project).toBe(PROJECT);
    expect(data.totals.grand_total).toBeGreaterThanOrEqual(3);
    expect(data.tiers.working.count).toBeGreaterThanOrEqual(3);
    expect(data.tiers.working.results.length).toBeGreaterThan(0);
    expect(typeof data.tiers.working.results[0].id).toBe('number');

    const scoped = jsonOf(ok(['browse', '--tier', 'working', '--project', PROJECT, '--json']));
    expect(scoped.tier_filter).toBe('working');
    expect(scoped.tiers.active).toBeUndefined();
  });

  itCmd('citation-stats', () => {
    // Seed the two feedback-loop states the report is FOR, so the arrays carry a row
    // whose presence is provable rather than an empty [] that any broken query returns:
    //   at-risk → uncited_streak >= 2 → decay_queue
    //   cited   → cited_count >= 1 AND uncited_streak = 0 → promoted
    // The cited row deliberately does NOT get its importance raised. It used to (set to 3
    // alongside cited_count), which seeded the section's own gate and so could not observe
    // that D#179/D#198 had stopped the loop producing that state; the row is left at its
    // saved importance so only what the promote branch writes can put it in the array.
    const atRisk = savedId(ok(['save', 'Row parked in the citation decay queue by the sweep', '--project', 'sweep-citation']));
    const promotedId = savedId(ok(['save', 'Row promoted by repeated citation in the sweep', '--project', 'sweep-citation']));
    withDb((db) => {
      db.prepare('UPDATE observations SET uncited_streak = 3 WHERE id = ?').run(atRisk);
      db.prepare('UPDATE observations SET cited_count = 2, uncited_streak = 0 WHERE id = ?').run(promotedId);
    });

    const data = jsonOf(ok(['citation-stats', '--json']));
    expect(data.window_days).toBe(7);                  // documented default
    expect(data.decay_queue.map(r => r.id)).toContain(atRisk);
    expect(data.decay_queue.find(r => r.id === atRisk).uncited_streak).toBe(3);
    expect(data.decay_queue.map(r => r.id)).not.toContain(promotedId);   // streak 0 → not at risk
    expect(data.promoted.map(r => r.id)).toEqual([promotedId]);
    expect(data.per_project.find(p => p.project === 'sweep-citation').at_risk).toBe(1);
    expect(data.funnel).toHaveProperty('window');
    // --days must reach the window, not be dropped.
    expect(jsonOf(ok(['citation-stats', '--days', '14', '--json'])).window_days).toBe(14);
  });

  itCmd('help', () => {
    const r = ok(['help']);
    expect(r.stdout).toContain('claude-mem-lite CLI');

    // (a) The router's command set has not drifted from the pinned list.
    const routerSet = readFileSync(CLI_PATH, 'utf8').match(/const CLI_COMMANDS = new Set\(\[([^\]]*)\]\)/)[1];
    const routed = [...routerSet.matchAll(/'([^']+)'/g)].map(m => m[1]);
    expect(routed.sort()).toEqual([...EXPECTED_CLI_COMMANDS].sort());

    // (a2) …and the pinned list has not drifted from what this file actually EXERCISES.
    // COVERED_COMMANDS is the set of cases really registered with vitest (collection has
    // completed by the time any test body runs), so a command added to both cli.mjs and
    // EXPECTED_CLI_COMMANDS without a matching itCmd() case fails here — the literal
    // cannot be "fixed" into greenness without writing the case.
    expect([...COVERED_COMMANDS].sort()).toEqual([...EXPECTED_CLI_COMMANDS].sort());

    // (b) Every routed command is documented in help. `help` documents the others,
    // not itself — that single exemption is the whole allowance.
    const undocumented = routed.filter(c => c !== 'help' && !new RegExp(`^\\s{2}${c}\\b`, 'm').test(r.stdout));
    expect(undocumented).toEqual([]);
  });
});

// ─── Write / mutation surfaces (each creates the rows it acts on) ────────────

describe('CLI feature sweep: write commands', () => {
  itCmd('save', () => {
    const r = ok(['save', 'Traced a flaky upload to an unclosed multipart stream', '--type', 'bugfix', '--importance', '3', '--project', 'sweep-save', '--lesson', 'Close the stream in a finally block']);
    const id = savedId(r);
    expect(r.stdout).toContain('[bugfix]');
    expect(r.stdout).toContain('project: sweep-save');
    // Verify the row actually landed, with the flags applied.
    const row = withDb(db => db.prepare('SELECT type, importance, project, lesson_learned FROM observations WHERE id = ?').get(id));
    expect(row).toMatchObject({ type: 'bugfix', importance: 3, project: 'sweep-save', lesson_learned: 'Close the stream in a finally block' });
  });

  itCmd('update', () => {
    const id = savedId(ok(['save', 'Initial note about the nightly export job schedule', '--project', 'sweep-update']));
    const r = ok(['update', String(id), '--title', 'Nightly export job window moved', '--importance', '3', '--lesson', 'Coordinate window changes with the data team']);
    expect(r.stdout).toContain(`Updated #${id}`);
    const row = withDb(db => db.prepare('SELECT title, importance, lesson_learned FROM observations WHERE id = ?').get(id));
    expect(row).toMatchObject({
      title: 'Nightly export job window moved',
      importance: 3,
      lesson_learned: 'Coordinate window changes with the data team',
    });
  });

  itCmd('delete', () => {
    const id = savedId(ok(['save', 'Scratch row created only to be deleted by the sweep', '--project', 'sweep-delete']));

    const preview = ok(['delete', String(id)]);
    expect(preview.stdout).toContain('will be deleted');
    expect(preview.stdout).toContain('Run with --confirm');
    expect(withDb(db => db.prepare('SELECT COUNT(*) c FROM observations WHERE id = ?').get(id).c)).toBe(1);

    const confirmed = ok(['delete', String(id), '--confirm']);
    expect(confirmed.stdout).toContain('Deleted 1 observation');
    expect(withDb(db => db.prepare('SELECT COUNT(*) c FROM observations WHERE id = ?').get(id).c)).toBe(0);
  });

  itCmd('defer', () => {
    const added = ok(['defer', 'add', 'Split the retry helper out of the transport module', '--priority', '2', '--detail', 'blocked on the transport refactor', '--project', 'sweep-defer']);
    const id = Number(added.stdout.match(/Deferred as D#(\d+)/)[1]);

    const list = ok(['defer', 'list', '--project', 'sweep-defer']);
    expect(list.stdout).toContain('Split the retry helper');
    expect(list.stdout).toContain(`D#${id}`);

    const dropped = ok(['defer', 'drop', `D#${id}`, '--reason', 'covered elsewhere', '--project', 'sweep-defer']);
    expect(dropped.stdout).toContain(`Dropped D#${id}`);
    expect(ok(['defer', 'list', '--project', 'sweep-defer']).stdout).toContain('No open deferred items');
  });

  itCmd('activity', () => {
    const saved = jsonOf(ok(['activity', 'save', '--type', 'lesson', 'Sweep activity event', '--body', 'event body text', '--project', 'sweep-activity']));
    expect(saved).toMatchObject({ ok: true });
    expect(typeof saved.id).toBe('number');

    const shown = jsonOf(ok(['activity', 'show', String(saved.id)]));
    expect(shown).toMatchObject({ id: saved.id, event_type: 'lesson', title: 'Sweep activity event', body: 'event body text', project: 'sweep-activity' });
    // `show` reads back through the same module that wrote — cross-check the row in the
    // sandbox DB independently, so a write that never reaches `events` cannot pass.
    const row = withDb(db => db.prepare('SELECT event_type, title, body, project FROM events WHERE id = ?').get(saved.id));
    expect(row).toMatchObject({ event_type: 'lesson', title: 'Sweep activity event', body: 'event body text', project: 'sweep-activity' });

    expect(ok(['activity', 'search', 'Sweep activity', '--project', 'sweep-activity']).stdout).toContain(`#${saved.id} [lesson]`);
    expect(ok(['activity', 'recent', '5', '--project', 'sweep-activity']).stdout).toContain('Sweep activity event');
  });
});

// ─── Data movement: export / restore / import ───────────────────────────────

describe('CLI feature sweep: data commands', () => {
  itCmd('export', () => {
    const r = ok(['export', '--project', PROJECT, '--format', 'jsonl']);
    const rows = r.stdout.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.map(o => o.id)).toContain(SEED_BUGFIX_ID);
    const seeded = rows.find(o => o.id === SEED_BUGFIX_ID);
    expect(seeded.project).toBe(PROJECT);
    expect(seeded.lesson_learned).toBe(SEED_LESSON);
    expect(seeded.title).toContain('widget cache invalidation race');
  });

  itCmd('restore', () => {
    const id = savedId(ok(['save', 'Round-trip probe for the export and restore pair', '--type', 'decision', '--project', 'sweep-restore']));
    const dump = join(ROOT, 'restore.jsonl');
    writeFileSync(dump, ok(['export', '--project', 'sweep-restore', '--format', 'jsonl']).stdout);
    ok(['delete', String(id), '--confirm']);
    expect(withDb(db => db.prepare("SELECT COUNT(*) c FROM observations WHERE project='sweep-restore'").get().c)).toBe(0);

    const dry = ok(['restore', dump, '--dry-run']);
    expect(dry.stdout).toMatch(/Restore \(dry-run\): 1 would be restored/);
    expect(withDb(db => db.prepare("SELECT COUNT(*) c FROM observations WHERE project='sweep-restore'").get().c)).toBe(0);

    const real = ok(['restore', dump]);
    expect(real.stdout).toMatch(/Restore: 1 restored/);
    const back = withDb(db => db.prepare("SELECT title, type FROM observations WHERE project='sweep-restore'").all());
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ type: 'decision', title: 'Round-trip probe for the export and restore pair' });

    // Missing file is a real error, not a silent no-op.
    const missing = runCli(['restore', join(ROOT, 'no-such-dump.jsonl')]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout + missing.stderr).toContain('Cannot read');
  });

  itCmd('import-jsonl', () => {
    const transcript = join(ROOT, 'sweep.jsonl');
    writeTranscript(transcript, 'featsweep-session-1');

    const first = ok(['import-jsonl', transcript, '--project', 'sweep-jsonl']);
    expect(first.stdout).toMatch(/\+1 prompts, \+1 observations/);
    expect(jsonOf(ok(['recent', '5', '--project', 'sweep-jsonl', '--json'])).total).toBe(1);

    // Re-import is an idempotent no-op, and must NOT claim the file is the wrong shape.
    const second = ok(['import-jsonl', transcript, '--project', 'sweep-jsonl']);
    expect(second.stdout).toContain('no-op');
    expect(second.stdout).not.toContain('none matched');
    expect(jsonOf(ok(['recent', '5', '--project', 'sweep-jsonl', '--json'])).total).toBe(1);
  });

  itCmd('import', () => {
    // GitHub import is the one command that cannot be exercised end-to-end without
    // network. Its documented failure paths run entirely locally: the usage error,
    // and parseGitHubUrl rejecting a non-GitHub URL BEFORE the first fetch
    // (registry-importer.mjs:235). Both are asserted; the fetch path is not.
    const noArg = runCli(['import']);
    expect(noArg.exitCode).toBe(1);
    expect(noArg.stdout + noArg.stderr).toContain('Usage: claude-mem-lite import <github-url>');

    const badUrl = runCli(['import', 'https://example.com/not-github/repo']);
    expect(badUrl.exitCode).toBe(1);
    expect(badUrl.stdout + badUrl.stderr).toContain('Invalid GitHub URL');
    expect(badUrl.stdout + badUrl.stderr).not.toMatch(/ENOTFOUND|ETIMEDOUT|fetch failed/);
  });
});

// ─── Maintenance surfaces ───────────────────────────────────────────────────

describe('CLI feature sweep: maintenance commands', () => {
  itCmd('compress', () => {
    // Compression needs >=3 rows in one project-week that are >=30d old, importance<=1,
    // never accessed and lesson-free. Seed via the real save path, then backdate.
    for (const text of [
      'Renamed the changelog heading ahead of the quarterly audit',
      'Bumped the linter rule covering trailing commas in vendor files',
      'Removed an obsolete screenshot from the onboarding docs folder',
    ]) ok(['save', text, '--importance', '1', '--project', 'sweep-compress']);
    expect(ageProject('sweep-compress', 60)).toBe(3);

    const preview = ok(['compress', '--project', 'sweep-compress']);
    expect(preview.stdout).toContain('Total candidates: 3');
    expect(preview.stdout).toContain('Compressable groups (≥3 obs): 1');
    expect(preview.stdout).toContain('Observations to compress: 3');
    // Preview must not mutate.
    expect(withDb(db => db.prepare("SELECT COUNT(*) c FROM observations WHERE project='sweep-compress' AND COALESCE(compressed_into,0)=0").get().c)).toBe(3);

    const executed = ok(['compress', '--execute', '--project', 'sweep-compress']);
    expect(executed.stdout).toMatch(/Compressed 3 observations into 1 weekly summar/);
    // All three originals now point at a summary row, and exactly one uncompressed
    // row remains in the project: the weekly summary itself.
    expect(withDb(db => db.prepare("SELECT COUNT(*) c FROM observations WHERE project='sweep-compress' AND COALESCE(compressed_into,0)!=0").get().c)).toBe(3);
    const survivors = withDb(db => db.prepare("SELECT id, title FROM observations WHERE project='sweep-compress' AND COALESCE(compressed_into,0)=0").all());
    expect(survivors).toHaveLength(1);
    expect(ok(['compress', '--project', 'sweep-compress']).stdout).toContain('No candidates for compression');
  });

  itCmd('maintain', () => {
    for (const text of [
      'Tidied the stale feature flag list inside the deployment runbook',
      'Archived the legacy migration notes from the operations wiki space',
      'Dropped an unused gradle task from the android build configuration',
    ]) ok(['save', text, '--importance', '1', '--project', 'sweep-maintain']);

    const before = ok(['maintain', 'scan', '--project', 'sweep-maintain']);
    expect(before.stdout).toContain('Total active: 3');
    expect(before.stdout).toMatch(/Stale \(>30d, imp=1, no access, never injected\): 0/);

    expect(ageProject('sweep-maintain', 90)).toBe(3);
    expect(ok(['maintain', 'scan', '--project', 'sweep-maintain']).stdout)
      .toMatch(/Stale \(>30d, imp=1, no access, never injected\): 3/);

    const executed = ok(['maintain', 'execute', '--ops', 'decay', '--project', 'sweep-maintain']);
    expect(executed.stdout).toMatch(/marked 3 idle as pending-purge/);

    const after = ok(['maintain', 'scan', '--project', 'sweep-maintain']);
    expect(after.stdout).toContain('Total active: 0');
    // Converged with the MCP spelling (audit 2026-08-14 A4): the CLI used to print
    // "Pending purge: 3 (compressed originals awaiting cleanup)", which described the wrong
    // sentinel — these 3 rows were marked by the DECAY pass one line above
    // ("marked 3 idle as pending-purge"), not by compression. Same string on both surfaces
    // now (tests/feature-sweep-mcp.test.mjs:480 pins the twin).
    expect(after.stdout).toMatch(/Pending purge \(idle-marked\): 3/);
    expect(after.stdout).not.toMatch(/compressed originals/);
  });

  itCmd('optimize', () => {
    // Preview is the documented default and needs no LLM. `--run` is exercised too:
    // with CLAUDE_CODE_PATH pointing nowhere it must degrade, not spawn or hang.
    const preview = ok(['optimize', '--project', PROJECT]);
    expect(preview.stdout).toContain('LLM Optimization Preview');

    // The headline "Total: N items" must be the sum of the four per-task figures printed
    // right above it (optimizePreview: reenrich + clusterMerge + smartCompress + 1 when
    // the normalize gate is open AND has ≥5 concepts, which is exactly when that line
    // renders a non-zero count). A Total computed over a different scope — e.g. dropping
    // the --project filter on one leg — fails here; asserting "N parses as an integer"
    // could not.
    const num = (re) => {
      const m = preview.stdout.match(re);
      expect(m, `no line matching ${re} in:\n${preview.stdout}`).toBeTruthy();
      return Number(m[1]);
    };
    const reenrich = num(/^\s*Re-enrich candidates: (\d+)/m);
    // Same spelling as the MCP surface (audit 2026-08-14 F2 converged the CLI onto it);
    // tests/audit-findings-20260814.test.mjs pins that the two agree.
    const clusterMerge = num(/^\s*Cluster-merge candidates: (\d+) clusters/m);
    const smartCompress = num(/^\s*Smart-compress candidates: (\d+) clusters/m);
    const normalizeLine = preview.stdout.match(/^\s*Normalize: (?:(\d+) unique concepts|gate closed .*)$/m);
    expect(normalizeLine, `no parseable Normalize line in:\n${preview.stdout}`).toBeTruthy();
    const normalizeUnits = Number(normalizeLine[1] || 0) > 0 ? 1 : 0;
    const total = num(/^\s*Total: (\d+) items$/m);
    expect(total).toBe(reenrich + normalizeUnits + clusterMerge + smartCompress);
    expect(preview.stdout).toContain('Run with --run to execute');

    // The --run arm must DEGRADE (candidates picked up, every LLM call refused because
    // CLAUDE_CODE_PATH points nowhere), not quietly find nothing to do. The preview just
    // proved there is work queued, so `skipped` has to be non-zero: "0 processed, 0
    // skipped" — the shape an empty work queue and a never-invoked task both produce —
    // now fails.
    expect(reenrich).toBeGreaterThan(0);
    const executed = ok(['optimize', '--run', '--project', PROJECT, '--max', '1']);
    expect(executed.stdout).toContain('Running LLM optimization');
    expect(executed.stdout).toMatch(/Re-enrich: 0 processed, [1-9]\d* skipped/);
    expect(executed.stdout + executed.stderr).not.toMatch(/ENOTFOUND|ETIMEDOUT|fetch failed/);
  }, 40000);

  itCmd('fts-check', () => {
    const check = ok(['fts-check', 'check']);
    expect(check.stdout).toContain('FTS5 indexes are healthy');

    const rebuilt = ok(['fts-check', 'rebuild']);
    for (const table of ['observations_fts', 'session_summaries_fts', 'user_prompts_fts', 'events_fts']) {
      expect(rebuilt.stdout).toContain(table);
    }
    // Search still works against the rebuilt index.
    expect(jsonOf(ok(['search', 'widget', '--project', PROJECT, '--json'])).total).toBeGreaterThanOrEqual(2);
  });
});

// ─── Registry surfaces ──────────────────────────────────────────────────────

describe('CLI feature sweep: registry commands', () => {
  itCmd('registry', () => {
    const skill = writeSkill('sweep-registry-skill');
    const imported = ok(['registry', 'import', '--name', 'sweep-registry-skill', '--resource-type', 'skill', '--local-path', skill, '--use-cases', 'exercising the registry surface']);
    expect(imported.stdout).toMatch(/Imported: skill:sweep-registry-skill \(id=\d+\)/);

    expect(ok(['registry', 'list']).stdout).toContain('sweep-registry-skill');
    expect(ok(['registry', 'stats']).stdout).toMatch(/Total active: [1-9]\d*/);

    const found = ok(['registry', 'search', 'sweep-registry-skill']);
    expect(found.stdout).toContain('sweep-registry-skill');
    expect(found.stdout).toContain(skill);

    expect(ok(['registry', 'reindex']).stdout).toMatch(/FTS5 reindexed\. \d+ active resources/);

    expect(ok(['registry', 'remove', '--name', 'sweep-registry-skill', '--resource-type', 'skill']).stdout)
      .toContain('Removed: skill:sweep-registry-skill');
    // Positive post-removal assertion: the documented zero-result line, not a negative
    // coupled to the exact "  [✓] S " row prefix (which would go green on a mere
    // formatting change while the row was still being returned).
    expect(ok(['registry', 'search', 'sweep-registry-skill']).stdout)
      .toContain('No matching resources for: "sweep-registry-skill"');
  });

  itCmd('enrich', () => {
    const unknown = runCli(['enrich', 'no-such-resource-xyzzy']);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stdout + unknown.stderr).toContain('Resource not found: no-such-resource-xyzzy');

    // With a resource pending enrichment and no reachable LLM, --all must report an
    // honest failure count and exit 0 — not hang, not spawn a real `claude`. The fixture
    // has to live under the managed dir or the P1-3 confinement gate refuses it before
    // the enricher is reached, and this case would be asserting the wrong thing.
    const skill = writeManagedSkill('sweep-enrich-skill');
    ok(['registry', 'import', '--name', 'sweep-enrich-skill', '--resource-type', 'skill', '--local-path', skill]);
    const all = ok(['enrich', '--all']);
    expect(all.stdout).toMatch(/Done: 0 enriched, [1-9]\d* failed\./);
    expect(all.stdout, 'a managed path must not be refused').not.toMatch(/Refused/);
    ok(['registry', 'remove', '--name', 'sweep-enrich-skill', '--resource-type', 'skill']);

    // The other side of the same gate, on the shipped CLI: a resource whose local_path
    // sits outside the managed dir is refused rather than read. tests/registry-enrich-
    // confinement.test.mjs owns the detail; this one pins that the sweep's own surface
    // routes it, since `enrich` is the command this case is named after.
    const outside = writeSkill('sweep-enrich-outside');
    ok(['registry', 'import', '--name', 'sweep-enrich-outside', '--resource-type', 'skill', '--local-path', outside]);
    const refused = ok(['enrich', '--all']);
    expect(refused.stdout).toMatch(/Refused 1: local_path outside the managed directory/);
    expect(refused.stdout).toMatch(/Done: 0 enriched, 0 failed\./);
    ok(['registry', 'remove', '--name', 'sweep-enrich-outside', '--resource-type', 'skill']);
  }, 40000);
});

// ─── Project-adoption surfaces (cwd-scoped filesystem writes) ───────────────

describe('CLI feature sweep: adoption commands', () => {
  const userContent = '# adoptproj\n\nMy own project notes.\n\n## Conventions\n- use tabs\n';
  const claudeMd = () => join(ADOPT_DIR, 'CLAUDE.md');

  itCmd('adopt', () => {
    writeFileSync(claudeMd(), userContent);

    const dry = ok(['adopt', '--dry-run'], { cwd: ADOPT_DIR });
    expect(dry.stdout).toContain('[adopt --dry-run]');
    expect(dry.stdout).toContain(ADOPT_DIR);
    expect(readFileSync(claudeMd(), 'utf8')).toBe(userContent);   // dry-run wrote nothing
    expect(existsSync(join(ADOPT_DIR, '.claude', 'plugin_claude_mem_lite.md'))).toBe(false);

    const applied = ok(['adopt'], { cwd: ADOPT_DIR });
    expect(applied.stdout).toMatch(/\[adopt\].*→ (created|updated)/);
    const md = readFileSync(claudeMd(), 'utf8');
    expect((md.match(/<!-- claude-mem-lite:begin/g) || []).length).toBe(1);
    expect(md).toContain('use tabs');                              // user content preserved
    expect(existsSync(join(ADOPT_DIR, '.claude', 'plugin_claude_mem_lite.md'))).toBe(true);

    expect(ok(['adopt', '--status'], { cwd: ADOPT_DIR }).stdout).toMatch(/CLAUDE\.md:\s+✓ adopted/);
  });

  itCmd('unadopt', () => {
    // Seeds its OWN adopted state in a dedicated dir — no dependency on the `adopt`
    // case having run first, so this case still means something under -t unadopt.
    const md_ = join(UNADOPT_DIR, 'CLAUDE.md');
    writeFileSync(md_, userContent);
    ok(['adopt'], { cwd: UNADOPT_DIR });
    expect(readFileSync(md_, 'utf8')).toContain('<!-- claude-mem-lite:begin');
    expect(existsSync(join(UNADOPT_DIR, '.claude', 'plugin_claude_mem_lite.md'))).toBe(true);

    const dry = ok(['unadopt', '--dry-run'], { cwd: UNADOPT_DIR });
    expect(dry.stdout).toContain(UNADOPT_DIR);
    expect(readFileSync(md_, 'utf8')).toContain('<!-- claude-mem-lite:begin');   // dry-run is read-only

    const removed = ok(['unadopt'], { cwd: UNADOPT_DIR });
    expect(removed.stdout).toMatch(/\[unadopt\].*→ removed/);
    const md = readFileSync(md_, 'utf8');
    expect(md).not.toContain('<!-- claude-mem-lite:begin');
    expect(md).toContain('use tabs');                              // user content survives
    expect(existsSync(join(UNADOPT_DIR, '.claude', 'plugin_claude_mem_lite.md'))).toBe(false);
  });

  itCmd('memdir-audit', () => {
    const memdir = join(ROOT, 'memdir');
    mkdirSync(memdir, { recursive: true });
    writeFileSync(join(memdir, 'feedback_good.md'), '# Good\n\n**Why:** it matters\n\n**How to apply:** do this\n');
    writeFileSync(join(memdir, 'project_bad.md'), '# Bad\n\njust prose, no contract sections\n');

    // Documented non-zero: exit 1 when any file breaks the body-structure contract.
    const bad = runCli(['memdir-audit', '--memdir', memdir]);
    expect(bad.exitCode).toBe(1);
    expect(bad.stdout).toContain('Compliant (1)');
    expect(bad.stdout).toContain('feedback_good.md');
    expect(bad.stdout).toContain('Missing both (1)');
    expect(bad.stdout).toContain('project_bad.md');
    expect(bad.stdout).toContain('Total: 2 file(s) (1 compliant)');

    rmSync(join(memdir, 'project_bad.md'));
    const good = ok(['memdir-audit', '--memdir', memdir]);
    expect(good.stdout).toContain('Missing both (0)');
    expect(good.stdout).toContain('Total: 1 file(s) (1 compliant)');
  });
});
