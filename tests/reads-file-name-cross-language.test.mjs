// `reads-<project>.txt` is written by bash, read by Node, and reaped by a third site — and
// no accessor can be shared across the language boundary.
//
// R12 gave the episode buffer a single spelling by routing every site through
// `episodeFile()`. Its sibling cannot be fixed that way: `scripts/post-tool-use.sh` appends
// the Read fast-path's file paths to this file without ever starting Node, so the name is
// necessarily written twice, once per language. What CAN be checked is that the two spellings
// agree — which is the only thing that makes them safe.
//
// The harm is already recorded in the writer's own comments, twice, from when it happened:
// a runtime dir resolved differently on the two sides "made flushEpisode read a DIFFERENT
// reads-<project>.txt, silently dropping this session's Read context AND orphaning the
// bash-named file (nothing ever collects it)". Note both halves: the reader goes quiet AND
// the writer's file becomes garbage nobody reaps.
//
// THREE SITES, NOT TWO, and the third is why this guard checks the sweeper as well:
//
//   scripts/post-tool-use.sh   writes   "${runtime_dir}/reads-${project}.txt"
//   hook.mjs                   reads    join(RUNTIME_DIR, `reads-${…}.txt`)
//   hook-shared.mjs            reaps    f.startsWith('reads-') && f.endsWith('.txt')
//
// The sweeper matches on a PREFIX and a SUFFIX rather than constructing the name, so a
// renamed file is not merely unread — it is also never collected, and grows without bound in
// the user's runtime directory. A guard that compared only the writer and the reader would
// pass while that third site silently stopped reaping.
//
// POPULATION: this is one of the four shipped bash hooks that `walkShipped` (".mjs/.js") is
// structurally blind to — the blind spot that hid two setup.sh defects for twelve audit
// rounds. Both shipped languages are named explicitly here rather than swept.

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataDir, resolveRuntimeDir } from '../lib/resolve-data-dir.mjs';

// D#207: join(), never new URL('../x.mjs', import.meta.url).
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(REPO, p), 'utf8');

/** Strip whole-line comments so a docblock quoting the name is not mistaken for a site. */
const codeLines = (src, commentRe) => src.split('\n').filter((l) => !commentRe.test(l));

/** `reads-<something>.txt` built in bash: `"${dir}/reads-${var}.txt"`. */
function bashConstructions() {
  const lines = codeLines(read('scripts/post-tool-use.sh'), /^\s*#/);
  return lines
    .map((l) => /\/(reads-)\$\{[^}]+\}(\.[a-z]+)"/.exec(l))
    .filter(Boolean)
    .map((m) => ({ prefix: m[1], suffix: m[2] }));
}

/** `reads-<something>.txt` built in a shipped Node module. */
function nodeConstructions() {
  const out = [];
  for (const f of ['hook.mjs', 'hook-shared.mjs', 'hook-episode.mjs', 'hook-llm.mjs']) {
    for (const l of codeLines(read(f), /^\s*(\/\/|\*|\/\*)/)) {
      const m = /`(reads-)\$\{[^`]*\}(\.[a-z]+)`/.exec(l);
      if (m) out.push({ file: f, prefix: m[1], suffix: m[2] });
    }
  }
  return out;
}

/** The reaper's predicate: a prefix test and a suffix test on the same line. */
function sweeperPredicate() {
  for (const l of codeLines(read('hook-shared.mjs'), /^\s*(\/\/|\*|\/\*)/)) {
    const m = /startsWith\('(reads-)'\)\s*&&\s*[\w.]*\.endsWith\('(\.[a-z]+)'\)/.exec(l);
    if (m) return { prefix: m[1], suffix: m[2] };
  }
  return null;
}

describe('the reads-file name means the same thing in bash and in Node', () => {
  it('every extractor found its site', () => {
    // Premise before criteria. Three empty lists agree with each other perfectly, so without
    // this the guard is loudest exactly when it has stopped looking at anything.
    expect(bashConstructions(), 'no reads-file construction found in post-tool-use.sh').toHaveLength(1);
    expect(nodeConstructions().length, 'no reads-file construction found in the Node hooks').toBe(1);
    expect(sweeperPredicate(), 'no prefix/suffix reaper predicate found in hook-shared.mjs').not.toBeNull();
  });

  it('the writer and the reader agree', () => {
    const [bash] = bashConstructions();
    const [node] = nodeConstructions();
    expect(
      { prefix: node.prefix, suffix: node.suffix },
      `${node.file} builds ${node.prefix}…${node.suffix} while scripts/post-tool-use.sh writes ` +
        `${bash.prefix}…${bash.suffix}. The bash fast path never starts Node, so these two ` +
        'spellings are the whole contract: when they diverge the reader goes silent AND the ' +
        'written file is never collected. Change both, or neither.',
    ).toEqual({ prefix: bash.prefix, suffix: bash.suffix });
  });

  // The NAME is only half the contract. A guard that pinned the name alone passed while the
  // two sides disagreed about the DIRECTORY — which is the same defect in a different
  // coordinate, and produces exactly the two harms quoted at the top of this file. So the
  // directory is checked behaviourally: run the real bash hook, then ask the Node resolver
  // where it would look. No restatement of the rule sits between the two.
  describe('and the two sides put it in the same DIRECTORY', () => {
    /** Runs the shipped bash prefilter on a Read event; returns where the file landed. */
    function writeAndLocate(extraEnv) {
      const root = mkdtempSync(join(tmpdir(), 'reads-dir-'));
      try {
        const home = join(root, 'home');
        const data = join(root, 'data');
        const proj = join(root, 'proj');
        for (const d of [home, data, proj]) mkdirSync(d, { recursive: true });
        const env = { ...process.env };
        for (const k of Object.keys(env)) if (/^CLAUDE_MEM_/.test(k)) delete env[k];
        const full = { ...env, HOME: home, CLAUDE_MEM_DIR: data, CLAUDE_PROJECT_DIR: proj, ...extraEnv };
        const r = spawnSync('bash', [join(REPO, 'scripts/post-tool-use.sh')], {
          input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/x/y/z.mjs' } }),
          env: full,
          encoding: 'utf8',
          timeout: 30000,
        });
        expect(r.status, `prefilter exited ${r.status}: ${r.stderr}`).toBe(0);
        // Where Node would look, asked of the resolver the hooks themselves use.
        const nodeDir = resolveRuntimeDir(resolveDataDir(full.CLAUDE_MEM_DIR), full);
        const wrote = (dir) =>
          existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith('reads-')) : [];
        return { nodeDir, inNodeDir: wrote(nodeDir), inDataRuntime: wrote(join(data, 'runtime')) };
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }

    it('premise: with no override the prefilter really does write a reads- file', () => {
      // Without this the override case below could pass by the hook writing nothing at all.
      const r = writeAndLocate({});
      expect(r.inNodeDir, 'the bash prefilter wrote no reads- file on the default path').toHaveLength(1);
    });

    it('honours CLAUDE_MEM_RUNTIME_DIR, which is the directory Node reads', () => {
      const rt = mkdtempSync(join(tmpdir(), 'reads-rt-'));
      try {
        const r = writeAndLocate({ CLAUDE_MEM_RUNTIME_DIR: rt });
        expect(r.nodeDir).toBe(rt); // the resolver, not my restatement of it
        expect(
          r.inNodeDir,
          `bash wrote to ${r.inDataRuntime.length ? join('<data>', 'runtime') : 'nowhere'} while ` +
            `hook.mjs reads ${r.nodeDir}. resolveRuntimeDir() honours CLAUDE_MEM_RUNTIME_DIR and ` +
            'the bash side must mirror it: otherwise every Read is dropped from the episode AND ' +
            "the file lands outside the reaper's directory, so it grows forever.",
        ).toHaveLength(1);
        expect(r.inDataRuntime, 'the file was also written to the un-overridden default').toHaveLength(0);
      } finally {
        rmSync(rt, { recursive: true, force: true });
      }
    });
  });

  it('the reaper matches what the writer produces', () => {
    const [bash] = bashConstructions();
    const sweep = sweeperPredicate();
    expect(
      sweep,
      `hook-shared.mjs reaps ${sweep.prefix}*${sweep.suffix} but the writer produces ` +
        `${bash.prefix}*${bash.suffix}. A file outside the reaper's predicate is written ` +
        "forever and never swept — it does not fail, it accumulates in the user's runtime dir.",
    ).toEqual({ prefix: bash.prefix, suffix: bash.suffix });
  });
});
