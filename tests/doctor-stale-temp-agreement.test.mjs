// doctor's stale-temp COUNT and cleanup's stale-temp DELETION are the same question asked
// twice, and they have drifted twice: v3.93.0 on the directory, D#53 on the age gate. Both
// times the fix was to align one copy with the other, and both times nothing stopped the
// next divergence.
//
// So the guard here is BEHAVIOURAL and end-to-end rather than a source scan. The two faces
// are now wired to one classifier in lib/doctor-stale-temp.mjs, which makes agreement
// structural — but "structural" is exactly what the previous two fixes also believed, and a
// source scan would pass the moment someone re-implements the gate inline with the same
// spelling. Running both faces over one fixture cannot be fooled that way.
//
// Measured pre-fix on this fixture shape: doctor said 3, cleanup removed 0 and printed
// "No stale files found."
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  scanStaleTempFiles,
  classifyEpisodeFile,
  classifyUpdateResidue,
  isUpdateResidue,
  isEpisodeResidue,
  EPISODE_AGE_LABEL,
  SWAP_JOURNAL_NAME,
} from '../lib/doctor-stale-temp.mjs';
import { ORPHAN_EPISODE_AGE_MS } from '../lib/time-constants.mjs';

const REPO = resolve(import.meta.dirname, '..');
const INSTALLER = join(REPO, 'install.mjs');
const homes = [];

afterEach(() => {
  for (const h of homes.splice(0)) {
    try {
      rmSync(h, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

const HOURS = 60 * 60 * 1000;

/**
 * data dir holding `fresh` in-flight episode files and `stale` ones aged past the gate. Update
 * residue goes in the CODE dir, $HOME/.claude-mem-lite: that is where hook-update's swap writes
 * it, and CLAUDE_MEM_DIR (set by runFace) does not move it (D#289).
 */
function fixture({ fresh = 0, stale = 0, updateResidue = 0 } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'doctor-stale-'));
  homes.push(home);
  const dataDir = join(home, 'data');
  const codeDir = join(home, '.claude-mem-lite');
  const runtimeDir = join(dataDir, 'runtime');
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(codeDir, { recursive: true });
  for (let i = 0; i < fresh; i++) {
    writeFileSync(join(runtimeDir, `ep-flush-fresh-${i}.json`), '{}');
  }
  for (let i = 0; i < stale; i++) {
    const f = join(runtimeDir, `ep-flush-stale-${i}.json`);
    writeFileSync(f, '{}');
    const old = new Date(Date.now() - 3 * HOURS);
    utimesSync(f, old, old);
  }
  for (let i = 0; i < updateResidue; i++) {
    mkdirSync(join(codeDir, `.update-staging-${i}`), { recursive: true });
  }
  return { home, dataDir, codeDir, runtimeDir };
}

function runFace(face, { home, dataDir }) {
  const env = {
    ...process.env,
    HOME: home,
    CLAUDE_MEM_DIR: dataDir,
    CLAUDE_MEM_SKIP_UPDATE: '1',
    MEM_QUIET_HOOKS: '1',
    MEM_NO_AUTO_ADOPT: '1',
  };
  const args = face === 'doctor' ? ['doctor', '--json'] : ['cleanup', '--dry-run'];
  try {
    return execFileSync(process.execPath, [INSTALLER, ...args], {
      env,
      encoding: 'utf8',
      timeout: 60_000,
    });
  } catch (e) {
    // doctor exits non-zero when it finds issues; the output is what we grade.
    return `${e.stdout || ''}${e.stderr || ''}`;
  }
}

function doctorStaleCount(out) {
  const json = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
  const line = (json.checks || []).find((c) => /^Stale temp files:/.test(c.message || ''));
  if (!line) return null;
  const m = line.message.match(/Stale temp files: (\d+) found/);
  return { count: m ? Number(m[1]) : 0, level: line.level, details: line.details || [] };
}

const cleanupRemovals = (out) => (out.match(/Would remove:/g) || []).length;

describe('doctor and cleanup agree about what is stale', () => {
  it('a purely in-flight runtime dir: doctor does not warn, cleanup removes nothing', () => {
    // The D#53 shape verbatim. Pre-fix doctor printed "3 found" and sent the user to a
    // command that answered "No stale files found."
    const f = fixture({ fresh: 3 });
    const d = doctorStaleCount(runFace('doctor', f));
    expect(d, 'doctor never reported on stale temp files at all').not.toBeNull();
    expect(d.count, 'doctor counted in-flight episode files as stale').toBe(0);
    expect(d.level, 'a healthy machine mid-episode was warned at ⚠').toBe('ok');
    expect(cleanupRemovals(runFace('cleanup', f))).toBe(0);
    // Not hidden, though: a bare "none" beside a runtime dir holding three files is the
    // green line that ends the reader's search.
    expect(d.details.join(' ')).toMatch(/3 episode file\(s\) newer than 1h .*in flight/);
  });

  it('genuinely stale files: the count doctor prints is the count cleanup removes', () => {
    const f = fixture({ fresh: 3, stale: 2 });
    const d = doctorStaleCount(runFace('doctor', f));
    expect(d.count).toBe(2);
    expect(d.level).toBe('warn');
    expect(cleanupRemovals(runFace('cleanup', f)), 'cleanup did not remove what doctor counted').toBe(
      d.count,
    );
  });

  it('update residue counts on both faces, and is NOT age-gated', () => {
    // The asymmetry is deliberate: cleanup guards update residue with install.lock, not by
    // age, so a freshly written .update-staging-* is still stale. A future "apply the age
    // gate everywhere" tidy-up would break recovery, and this case says so.
    const f = fixture({ updateResidue: 2 });
    const d = doctorStaleCount(runFace('doctor', f));
    expect(d.count).toBe(2);
    expect(cleanupRemovals(runFace('cleanup', f))).toBe(2);
  });
});

describe('scanStaleTempFiles / classifyEpisodeFile', () => {
  it('splits fresh from aged at the gate, and counts update residue regardless of age', () => {
    const f = fixture({ fresh: 2, stale: 3, updateResidue: 1 });
    expect(scanStaleTempFiles({ codeDir: f.codeDir, runtimeDir: f.runtimeDir })).toEqual({
      stale: 4, // 3 aged episodes + 1 update residue
      inFlight: 2,
      unfinishedSwaps: 0,
    });
  });

  it('an unreadable mtime counts as in flight, because failing open costs an episode', () => {
    const f = fixture({});
    expect(classifyEpisodeFile(f.runtimeDir, 'ep-flush-does-not-exist.json')).toBe('in-flight');
  });

  it('respects an injected clock rather than reading the wall only', () => {
    // Premise for the case above it: without a movable `now`, "aged" is untestable without
    // sleeping an hour, which is why the gate had no unit coverage before.
    const f = fixture({ fresh: 2 });
    expect(scanStaleTempFiles({ codeDir: f.codeDir, runtimeDir: f.runtimeDir }).inFlight).toBe(2);
    expect(
      scanStaleTempFiles({
        codeDir: f.codeDir,
        runtimeDir: f.runtimeDir,
        now: Date.now() + 5 * HOURS,
      }).stale,
    ).toBe(2);
  });

  it('honours an injected episodeAgeMs, not just an injected clock', () => {
    // Kills the mutant that drops the `episodeAgeMs` argument on the way to
    // classifyEpisodeFile: the injected-clock case above pins `now` but would not notice a
    // caller's window being silently replaced by the default.
    // Files aged 3h: stale under the default 1h window, in flight under a 5h one. Both arms
    // hold `now` at its default, so only episodeAgeMs can move the reading.
    const f = fixture({ stale: 2 });
    expect(
      scanStaleTempFiles({ codeDir: f.codeDir, runtimeDir: f.runtimeDir }).stale,
      'premise: 3h-old files are stale under the default 1h gate',
    ).toBe(2);
    expect(
      scanStaleTempFiles({ codeDir: f.codeDir, runtimeDir: f.runtimeDir, episodeAgeMs: 5 * HOURS }).inFlight,
      'a 5h window should keep 3h-old files in flight',
    ).toBe(2);
  });

  it('a file exactly at the gate is in flight, on the same side as both hook-side sweeps', () => {
    // The tie is not arbitrary. hook-shared.mjs deletes only `mtimeMs < cutoff` and
    // hook-llm.mjs counts `mtimeMs >= cutoff` as live, so both KEEP a file aged exactly
    // ORPHAN_EPISODE_AGE_MS. This classifier first spelled it `>` — faithfully, because
    // v6.10.3's cleanup gated on `mtimeMs > epCutoff` — which put the tie on the DELETE
    // side: cleanup's rmSync runs on anything not classified in-flight. So a manual cleanup
    // was more aggressive than the automatic sweep, against the comment above that very
    // gate ("same window the automatic sweep uses") and install.mjs's "a MANUAL cleanup is
    // the conservative one". Pre-existing, then, and carried over by the extraction.
    //
    // A pre-ship pass left that mutant alive on purpose, reasoning that a one-millisecond tie
    // is unreachable in practice so a guard costs more than it buys. The first half is true
    // of a real clock; the conclusion asked the wrong question — which SIDE of the tie the
    // other two sites chose — and `now` is injectable, so the tie is reachable here.
    const f = fixture({ fresh: 1 });
    const name = 'ep-flush-fresh-0.json';
    const file = join(f.runtimeDir, name);
    // Whole seconds, so mtimeMs is an integer and `now - episodeAgeMs` lands on it exactly;
    // a fractional mtime would turn the tie into a floating-point question.
    const secs = Math.floor(Date.now() / 1000) - 60;
    utimesSync(file, secs, secs);
    const mtimeMs = statSync(file).mtimeMs;
    expect(mtimeMs, 'premise: the filesystem kept a whole-second mtime').toBe(secs * 1000);
    expect(
      classifyEpisodeFile(f.runtimeDir, name, { now: mtimeMs + HOURS + 1 }),
      'premise: one millisecond past the gate is stale',
    ).toBe('stale');
    expect(
      classifyEpisodeFile(f.runtimeDir, name, { now: mtimeMs + HOURS }),
      'a file aged exactly the gate was put on the delete side',
    ).toBe('in-flight');
  });

  it('ignores files that are neither shape', () => {
    const f = fixture({});
    writeFileSync(join(f.runtimeDir, 'install.lock'), '');
    writeFileSync(join(f.runtimeDir, 'reads-proj.txt'), '');
    expect(scanStaleTempFiles({ codeDir: f.codeDir, runtimeDir: f.runtimeDir })).toEqual({
      stale: 0,
      inFlight: 0,
      unfinishedSwaps: 0,
    });
  });

  it('a data dir that does not exist yet is not an error — a fresh install has no runtime/', () => {
    // The else-arm of both existsSync gates. Reachable in the field (first run, before any
    // hook has written) and the only branch the other cases could not take.
    expect(
      scanStaleTempFiles({
        codeDir: join(tmpdir(), 'mem-absent-xyz'),
        runtimeDir: join(tmpdir(), 'mem-absent-xyz', 'runtime'),
      }),
    ).toEqual({ stale: 0, inFlight: 0, unfinishedSwaps: 0 });
  });

  it('the window both faces print is exactly the gate they apply', () => {
    // EPISODE_AGE_LABEL rounds to whole hours, so it is only "derived from the gate" while
    // the gate IS a whole number of hours: a 20-minute gate would print "0h" to the user
    // beside a rule of 20 minutes. Parse the label back and require equality, so that day
    // fails here instead of in someone's terminal.
    const m = /^(\d+)h$/.exec(EPISODE_AGE_LABEL);
    expect(m, `label is not in whole hours: ${EPISODE_AGE_LABEL}`).not.toBeNull();
    expect(Number(m[1]) * HOURS, 'the printed window differs from the gate').toBe(ORPHAN_EPISODE_AGE_MS);
  });

  it('a backup dir that still holds its journal is an unfinished swap, not stale temp (D#289)', () => {
    const f = fixture({});
    mkdirSync(join(f.codeDir, '.update-backup-2'), { recursive: true });
    writeFileSync(join(f.codeDir, '.update-backup-2', SWAP_JOURNAL_NAME), '{"backedUp":[],"installed":[]}');
    mkdirSync(join(f.codeDir, '.update-backup-1'), { recursive: true }); // its swap is over
    mkdirSync(join(f.codeDir, '.update-staging-1'), { recursive: true });
    expect(classifyUpdateResidue(f.codeDir, '.update-backup-2')).toBe('unfinished-swap');
    expect(classifyUpdateResidue(f.codeDir, '.update-backup-1')).toBe('stale');
    expect(classifyUpdateResidue(f.codeDir, '.update-staging-1')).toBe('stale');
    expect(classifyUpdateResidue(f.codeDir, 'server.mjs')).toBe(null);
    // A journal in a STAGING dir means nothing: staging holds copies, nothing was moved out of it.
    writeFileSync(join(f.codeDir, '.update-staging-1', SWAP_JOURNAL_NAME), '{}');
    expect(classifyUpdateResidue(f.codeDir, '.update-staging-1')).toBe('stale');
    expect(scanStaleTempFiles({ codeDir: f.codeDir, runtimeDir: f.runtimeDir })).toEqual({
      stale: 2,
      inFlight: 0,
      unfinishedSwaps: 1,
    });
  });

  it('the two prefix families do not overlap, so nothing is counted twice', () => {
    for (const n of ['.update-staging-1', '.update-backup-1']) {
      expect(isUpdateResidue(n)).toBe(true);
      expect(isEpisodeResidue(n)).toBe(false);
    }
    for (const n of ['pending-1.json', 'ep-flush-1.json']) {
      expect(isEpisodeResidue(n)).toBe(true);
      expect(isUpdateResidue(n)).toBe(false);
    }
  });
});
