// Class-level guard: every plugin write onto a USER-OWNED config file must write THROUGH
// a symlink, never replace it — audit 2026-09-02 P0-5 / P1-10.
//
// Three modules shipped a byte-identical private `atomicWrite` (temp + rename onto the
// PATH). `renameSync` onto a symlink NAME replaces the link with a regular file, so a
// CLAUDE.md or MEMORY.md symlinked into a dotfiles repo (chezmoi/stow/yadm) or a monorepo's
// shared root gets silently severed — the user's only signal is a git typechange, and
// edits to the shared source stop applying. `lib/atomic-write.mjs` was written FOR this
// failure mode (it says so in its own docblock) and install.mjs had been using it for
// ~/.claude/settings.json the whole time; the three copies never picked it up.
//
// Deliberately written per WRITE FACE rather than as one unit test of atomicWriteFileSync:
// a unit test of the shared writer stays green if a caller keeps its private twin, which is
// exactly the state this test exists to prevent recurring. Each case drives the module's
// real public entry point (#10716 — assert through the shipped path, don't re-encode the
// rule as a second literal).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { walkShipped, sweepShipped, sourceWithoutComments, REPO } from './shipped-tree.mjs';

let root;
// $TMPDIR in a Claude Code session lives under $HOME, and Node resolves node_modules up the
// tree — but nothing here imports through the sandbox, so os.tmpdir() is safe for this one
// (contrast reference_cc_tmpdir_under_home, which is about a harness that RUNS code there).
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mem-symlink-'));
});
afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/**
 * Build `<project>/CLAUDE.md` (or any basename) as a symlink pointing at a real file in a
 * sibling "dotfiles" directory, and return both paths plus a liveness assertion.
 */
function symlinkedConfig(basename, initialContent) {
  const project = join(root, 'project');
  const dotfiles = join(root, 'dotfiles');
  mkdirSync(project, { recursive: true });
  mkdirSync(dotfiles, { recursive: true });
  const real = join(dotfiles, basename);
  const link = join(project, basename);
  writeFileSync(real, initialContent);
  symlinkSync(real, link);
  // Premise: the fixture really is a symlink before the module touches it. Without this a
  // platform that silently copied instead of linking would make every case below vacuous.
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  return { project, real, link };
}

const stillLinked = (link, real, expectSubstring) => {
  expect(lstatSync(link).isSymbolicLink()).toBe(true); // link survived the write
  expect(readFileSync(real, 'utf8')).toContain(expectSubstring); // and the write landed on the target
};

describe('P0-5 claudemd.writeManaged writes through a symlinked CLAUDE.md', () => {
  it('keeps the link and updates the dotfiles target', async () => {
    const { writeManaged } = await import('../claudemd.mjs');
    const { project, real, link } = symlinkedConfig('CLAUDE.md', '# user prose\n');

    writeManaged(project, { slug: 'test-slug', version: 'v1', block: 'BLOCK BODY', doc: 'DOC BODY' });

    stillLinked(link, real, 'BLOCK BODY');
    expect(readFileSync(real, 'utf8')).toContain('# user prose'); // user content preserved
  });

  it('is still idempotent through the link (a second write does not sever it)', async () => {
    const { writeManaged } = await import('../claudemd.mjs');
    const { project, real, link } = symlinkedConfig('CLAUDE.md', '# user prose\n');
    const args = { slug: 'test-slug', version: 'v1', block: 'BLOCK BODY', doc: 'DOC BODY' };

    writeManaged(project, args);
    const afterFirst = readFileSync(real, 'utf8');
    writeManaged(project, args);

    expect(readFileSync(real, 'utf8')).toBe(afterFirst);
    stillLinked(link, real, 'BLOCK BODY');
  });
});

describe('P0-5 memdir.writePluginSection writes through a symlinked MEMORY.md', () => {
  it('keeps the link and updates the dotfiles target', async () => {
    const { writePluginSection } = await import('../memdir.mjs');
    const { project: memdir, real, link } = symlinkedConfig('MEMORY.md', '# my memories\n');

    writePluginSection(memdir, { slug: 'test-slug', version: 'v1', contentLine: '- SENTINEL LINE' });

    stillLinked(link, real, 'SENTINEL LINE');
    expect(readFileSync(real, 'utf8')).toContain('# my memories');
  });
});

describe('P0-5 hook-context.cleanupClaudeMdLegacyBlock writes through a symlinked CLAUDE.md', () => {
  const saved = {};
  beforeEach(() => {
    for (const k of ['CLAUDE_PROJECT_DIR', 'CLAUDE_MEM_DIR']) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of ['CLAUDE_PROJECT_DIR', 'CLAUDE_MEM_DIR']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('strips the legacy block without replacing the link', async () => {
    // A real legacy block, so the function reaches its write path rather than the
    // "nothing to strip" early return — the premise this case would otherwise pass on.
    const legacy = '# prose\n\n<claude-mem-context>\nstale snapshot\n</claude-mem-context>\n\n# more prose\n';
    const { project, real, link } = symlinkedConfig('CLAUDE.md', legacy);
    process.env.CLAUDE_PROJECT_DIR = project;
    // Point RUNTIME_DIR's parent at the sandbox so the idempotency marker never lands in
    // the real ~/.claude-mem-lite (and so a previous run's marker cannot short-circuit us).
    process.env.CLAUDE_MEM_DIR = join(root, 'memdir');

    const { cleanupClaudeMdLegacyBlock } = await import('../hook-context.mjs');
    cleanupClaudeMdLegacyBlock();

    const after = readFileSync(real, 'utf8');
    expect(after).not.toContain('<claude-mem-context>'); // premise: it really did rewrite
    expect(after).toContain('# more prose');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });
});

describe('no shipped module keeps a private temp+rename writer', () => {
  // The three cases above are per-FACE and behavioural, which is right — but the header
  // called them a "class-level guard" and they are not: they drive three named entry points
  // and a FOURTH face with its own private twin is invisible to them. The v3.92.0 pre-tag
  // review demonstrated it by adding one to `lib/cite-recall-path.mjs`; all four cases
  // stayed green. That is the same shape this repo recorded in v3.76.2 — the fix is a class
  // sweep, so here it is, alongside (not instead of) the behavioural cases.
  //
  // The predicate is the IDIOM, not `renameSync(` alone. A bare renameSync sweep reports
  // every file MOVE in the tree — the install/schema data-dir migrations, hook-update's
  // version swap, hook.mjs's episode-claim rename — none of which can replace a user's
  // symlink with a regular file, because none of them writes a temp first. What this guard
  // is about is `writeFileSync(tmp, …)` followed by `renameSync(tmp, target)`: the private
  // re-implementation of the shared writer. Same variable, within a short window.
  const PRIVATE_ATOMIC_RE = /writeFileSync\(\s*(\w+)[\s\S]{0,400}?renameSync\(\s*\1\b/;
  const ALLOWED = new Set([
    'lib/atomic-write.mjs', // the shared writer — the one legitimate home
    // RUNTIME-STATE writers, not user-owned config. These write into the plugin's own data
    // directory, where a torn write is fail-open, no user symlink can exist, and the write
    // is on a hot path whose import budget the shared writer would add to. Allowlisted by
    // NAME rather than by a directory rule, so adding a fourth means arguing for it here in
    // the open instead of inheriting a blanket exemption.
    'hook.mjs', // reads-<session> accumulator
    'hook-episode.mjs', // ep-<project>.json buffer
    'hook-shared.mjs', // session file — and it writes `mode: 0o600`, which the
    // shared writer has no parameter for; routing it there
    // would silently widen the permissions on session state
    'hook-update.mjs', // update-state.json
    'registry-recommend.mjs', // recommendation cooldown marker
    'lib/native-binding-hint.mjs', // ABI self-heal marker (runs when the DB cannot open)
    'scripts/user-prompt-search.js', // injected-ids marker, hot path, zero-import budget
  ]);

  it('the sweep walks a plausible number of shipped modules', () => {
    expect(walkShipped().length).toBeGreaterThan(60);
  });

  it('the private temp+rename idiom lives only in the shared writer and the declared runtime-state writers', () => {
    expect(sweepShipped(PRIVATE_ATOMIC_RE, ALLOWED)).toEqual([]);
  });

  it('the sweep can say NO and YES, and every allowlisted file really does carry the idiom', () => {
    // Arm 1: a regex matching nothing would report a clean tree. This is the exact shape
    // the three private twins shipped.
    expect('const tmp = p + ".tmp";\n  writeFileSync(tmp, data);\n  renameSync(tmp, p);').toMatch(
      PRIVATE_ATOMIC_RE,
    );
    // Arm 2: it must NOT fire on a plain file move, which is what a bare `renameSync` sweep
    // reported — six files, none of them this defect.
    expect('renameSync(oldDbPath, newDbPath);').not.toMatch(PRIVATE_ATOMIC_RE);
    // Arm 3: the allowlist could rot into names that no longer carry the idiom, leaving the
    // rule guarding an empty set while still reading as enforced.
    for (const rel of ALLOWED) {
      expect(sourceWithoutComments(join(REPO, rel)), `${rel} is allowlisted but has no temp+rename`).toMatch(
        PRIVATE_ATOMIC_RE,
      );
    }
  });
});
