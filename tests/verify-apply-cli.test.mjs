// `claude-mem-lite verify-apply` — the CLI face of lib/verify-apply-core.mjs, end to end in a
// subprocess against a real file DB under a sandboxed HOME / CLAUDE_MEM_DIR. The core's
// properties are pinned in verify-apply-core.test.mjs; this file pins what only the face can
// get wrong: dry run is the default and writes NOTHING (not even a backup), --apply writes the
// backup BEFORE the change and prints the undo command, exit codes carry the outcome.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { insertSession, insertObs } from './test-helpers.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_PATH = join(REPO, 'cli.mjs');
const PROJECT = 'parent--testproj';

let tmpHome;
let dataDir;
let projectDir;
let db;

function runCli(args) {
  const env = {
    ...process.env,
    HOME: tmpHome,
    CLAUDE_MEM_DIR: dataDir,
    CLAUDE_PROJECT_DIR: projectDir,
    MEM_NO_AUTO_ADOPT: '1',
  };
  delete env.CLAUDE_MEM_HOOK_RUNNING;
  // spawnSync, not execFileSync: stderr is needed on SUCCESS too — a flag this command reads
  // but the CLI's flag catalogue lacks prints "Unknown flag … ignored" on an exit-0 run.
  const r = spawnSync(process.execPath, [CLI_PATH, ...args], {
    timeout: 15000,
    encoding: 'utf8',
    env,
    cwd: projectDir,
  });
  return { stdout: r.stdout || '', stderr: r.stderr || '', exitCode: r.status ?? 1 };
}

function snapshot() {
  const obs = db.prepare('SELECT * FROM observations ORDER BY id').all();
  const files = db.prepare('SELECT obs_id, filename FROM observation_files ORDER BY obs_id, filename').all();
  return JSON.stringify({ obs, files });
}

function seed(over = {}) {
  return Number(
    insertObs(db, {
      sessionId: 'manual-t',
      project: PROJECT,
      type: 'bugfix',
      title: 'Old title',
      narrative: 'The bug is still open.',
      text: 'The bug is still open.',
      importance: 2,
      lessonLearned: 'Old lesson',
      filesModified: '["lib/foo.mjs"]',
      ...over,
    }).lastInsertRowid,
  );
}

function writeProposals(entries) {
  const p = join(tmpHome, `proposals-${randomUUID().slice(0, 6)}.json`);
  writeFileSync(p, JSON.stringify(entries));
  return p;
}

const backupsDir = () => join(dataDir, 'backups');
const digestOf = (stdout) => (stdout.match(/--digest ([0-9a-f]{16})/) || [])[1];

beforeEach(() => {
  tmpHome = join(tmpdir(), `mem-verify-cli-${randomUUID().slice(0, 8)}`);
  dataDir = join(tmpHome, '.claude-mem-lite');
  projectDir = join(tmpHome, 'parent', 'testproj');
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  db = new Database(join(dataDir, 'claude-mem-lite.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  initSchema(db);
  insertSession(db, { id: 'manual-t', project: PROJECT });
  insertSession(db, { id: 'manual-o', project: 'parent--other' });
});

afterEach(() => {
  db.close();
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('verify-apply CLI', () => {
  it('without a file prints usage and exits 1', () => {
    const r = runCli(['verify-apply']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/Usage: claude-mem-lite verify-apply/);
  });

  it('dry run is the default: prints the plan, exits 0, writes nothing — not even a backup', () => {
    const a = seed();
    const b = seed({ title: 'second' });
    const file = writeProposals([
      {
        id: a,
        action: 'edit',
        verdict: 'PARTIAL',
        set: { narrative: 'The bug was fixed in abc123.' },
        evidence: 'abc123',
      },
      { id: b, action: 'retire', verdict: 'STALE', evidence: 'def456' },
    ]);
    const before = snapshot();
    const r = runCli(['verify-apply', file]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`#${a}\\b.*edit`));
    expect(r.stdout).toMatch(new RegExp(`#${b}\\b.*retire`));
    expect(r.stdout).toMatch(/Dry run/);
    // The user approves what they SEE: the new text itself, not a length or a field name.
    expect(r.stdout).toContain('The bug was fixed in abc123.');
    expect(digestOf(r.stdout)).toMatch(/^[0-9a-f]{16}$/);
    expect(r.stdout).toContain(`--project ${PROJECT} --apply --digest ${digestOf(r.stdout)}`);
    expect(r.stderr).not.toMatch(/Unknown flag/);
    expect(snapshot()).toBe(before);
    expect(existsSync(backupsDir())).toBe(false);
  });

  it('an invalid document exits 1 and writes nothing', () => {
    const a = seed();
    const file = writeProposals([
      { id: a, action: 'retire', verdict: 'STALE', evidence: 'x', note: 'extra' },
    ]);
    const before = snapshot();
    const r = runCli(['verify-apply', file, '--apply']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/unknown key "note"/);
    expect(snapshot()).toBe(before);
    expect(existsSync(backupsDir())).toBe(false);
  });

  it('a target in another project exits 1 and writes nothing, even with --apply', () => {
    const foreign = seed({ sessionId: 'manual-o', project: 'parent--other' });
    const file = writeProposals([{ id: foreign, action: 'retire', verdict: 'STALE', evidence: 'x' }]);
    const before = snapshot();
    const r = runCli(['verify-apply', file, '--apply']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/parent--other/);
    expect(snapshot()).toBe(before);
  });

  it('--apply backs up first, applies, reads back ok, and --undo restores the rows', () => {
    const a = seed();
    const b = seed({ title: 'second' });
    const c = seed({ title: 'third' });
    const originals = [a, b, c].map((id) => db.prepare('SELECT * FROM observations WHERE id = ?').get(id));
    const file = writeProposals([
      {
        id: a,
        action: 'replace',
        verdict: 'STALE',
        narrative: 'The bug was fixed in abc123.',
        evidence: 'abc123',
      },
      {
        id: b,
        action: 'edit',
        verdict: 'PARTIAL',
        set: { narrative: 'line 12 now' },
        evidence: 'foo.mjs:12',
      },
      { id: c, action: 'retire', verdict: 'STALE', evidence: 'def456' },
    ]);

    const dry = runCli(['verify-apply', file]);
    const r = runCli(['verify-apply', file, '--apply', '--digest', digestOf(dry.stdout)]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stderr).not.toMatch(/Unknown flag/);
    const backups = readdirSync(backupsDir()).filter((f) => f.startsWith('verify-') && f.endsWith('.json'));
    expect(backups).toHaveLength(1);
    const backupPath = join(backupsDir(), backups[0]);
    const backup = JSON.parse(readFileSync(backupPath, 'utf8'));
    expect(backup.rows.map((x) => x.row)).toEqual(originals);
    expect(r.stdout.match(/\bok\b/g) || []).toHaveLength(3);
    expect(r.stdout).toContain(`verify-apply --undo ${backupPath}`);
    expect(
      db.prepare('SELECT superseded_at FROM observations WHERE id = ?').get(a).superseded_at,
    ).not.toBeNull();
    expect(db.prepare('SELECT narrative FROM observations WHERE id = ?').get(b).narrative).toBe(
      'line 12 now',
    );

    const u = runCli(['verify-apply', '--undo', backupPath]);
    expect(u.exitCode, u.stderr).toBe(0);
    expect(u.stderr).not.toMatch(/Unknown flag/);
    for (const row of originals) {
      expect(db.prepare('SELECT * FROM observations WHERE id = ?').get(row.id)).toEqual(row);
    }

    // A second undo of the same backup is refused: the file now records that it was undone.
    expect(JSON.parse(readFileSync(backupPath, 'utf8')).undone_at).toEqual(expect.any(String));
    const again = runCli(['verify-apply', '--undo', backupPath]);
    expect(again.exitCode).toBe(1);
    expect(again.stderr).toMatch(/already undone/);
  });

  it('an apply that was undone cannot be replayed with its old digest; a fresh dry run can be approved', () => {
    // Undo restores the rows exactly, so a digest of "plan + row state" alone comes back true
    // after an undo, and the earlier approval would re-apply what the user just took back.
    const a = seed();
    const file = writeProposals([
      { id: a, action: 'edit', verdict: 'STALE', set: { narrative: 'fixed in abc123' }, evidence: 'abc123' },
    ]);
    const d1 = digestOf(runCli(['verify-apply', file]).stdout);
    expect(runCli(['verify-apply', file, '--apply', '--digest', d1]).exitCode).toBe(0);
    const [backup] = readdirSync(backupsDir());
    expect(runCli(['verify-apply', '--undo', join(backupsDir(), backup)]).exitCode).toBe(0);
    const before = snapshot();

    const replay = runCli(['verify-apply', file, '--apply', '--digest', d1]);
    expect(replay.exitCode).toBe(1);
    expect(replay.stderr).toMatch(/digest mismatch/);
    expect(snapshot()).toBe(before);
    expect(readdirSync(backupsDir())).toEqual([backup]);

    const d2 = digestOf(runCli(['verify-apply', file]).stdout);
    expect(d2).toMatch(/^[0-9a-f]{16}$/);
    expect(d2).not.toBe(d1);
    const again = runCli(['verify-apply', file, '--apply', '--digest', d2]);
    expect(again.exitCode, again.stderr).toBe(0);
    expect(db.prepare('SELECT narrative FROM observations WHERE id = ?').get(a).narrative).toBe(
      'fixed in abc123',
    );
  });

  it('the printed apply and undo commands run as printed when a path contains a space', () => {
    const a = seed();
    const spaced = join(tmpHome, 'my proposals');
    mkdirSync(spaced);
    const file = join(spaced, 'p.json');
    writeFileSync(file, JSON.stringify([{ id: a, action: 'retire', verdict: 'STALE', evidence: 'x' }]));
    const env = {
      ...process.env,
      HOME: tmpHome,
      CLAUDE_MEM_DIR: dataDir,
      CLAUDE_PROJECT_DIR: projectDir,
      MEM_NO_AUTO_ADOPT: '1',
    };
    delete env.CLAUDE_MEM_HOOK_RUNNING;
    const sh = (cmd) =>
      spawnSync('bash', ['-c', cmd], { encoding: 'utf8', env, cwd: projectDir, timeout: 15000 });
    const dry = runCli(['verify-apply', file]);
    const applyCmd = dry.stdout
      .split('\n')
      .find((l) => l.includes('--apply --digest'))
      .trim();
    const applied = sh(applyCmd);
    expect(applied.status, applied.stderr).toBe(0);
    const undoCmd = applied.stdout.match(/To undo[^:]*: (.*)$/m)[1];
    const undone = sh(undoCmd);
    expect(undone.status, undone.stderr).toBe(0);
    expect(undone.stdout).toMatch(/Undo complete/);
  });

  it("--apply refuses without the dry run's digest, or with a stale one, and writes nothing", () => {
    const a = seed();
    const file = writeProposals([{ id: a, action: 'retire', verdict: 'STALE', evidence: 'x' }]);
    const digest = digestOf(runCli(['verify-apply', file]).stdout);
    const before = snapshot();

    const none = runCli(['verify-apply', file, '--apply']);
    expect(none.exitCode).toBe(1);
    expect(none.stderr).toMatch(/--digest/);

    // The proposals file edited after the dry run the user approved.
    writeFileSync(
      file,
      JSON.stringify([{ id: a, action: 'retire', verdict: 'STALE', evidence: 'changed after approval' }]),
    );
    const stale = runCli(['verify-apply', file, '--apply', '--digest', digest]);
    expect(stale.exitCode).toBe(1);
    expect(stale.stderr).toMatch(/digest/);

    expect(snapshot()).toBe(before);
    expect(existsSync(backupsDir())).toBe(false);
  });

  it('rejects --apply=false and --undo mixed with an apply, writing nothing', () => {
    const a = seed();
    const file = writeProposals([{ id: a, action: 'retire', verdict: 'STALE', evidence: 'x' }]);
    const digest = digestOf(runCli(['verify-apply', file]).stdout);
    const before = snapshot();
    const f = runCli(['verify-apply', file, '--apply=false', '--digest', digest]);
    expect(f.exitCode).toBe(1);
    const mixed = runCli(['verify-apply', file, '--apply', '--digest', digest, '--undo', file]);
    expect(mixed.exitCode).toBe(1);
    expect(mixed.stderr).toMatch(/Usage/);
    expect(snapshot()).toBe(before);
  });

  it('the dry run shows the whole new text — the tail too, however long', () => {
    const a = seed();
    const long =
      'Fixed in abc123. ' +
      'Context sentence to pad the correction. '.repeat(14) +
      'HIDDEN-TAIL: the last clause.';
    expect(long.length).toBeGreaterThan(500); // premise: past any display cap
    const file = writeProposals([
      { id: a, action: 'replace', verdict: 'STALE', narrative: long, evidence: 'abc123' },
    ]);
    const r = runCli(['verify-apply', file]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain('HIDDEN-TAIL: the last clause.');
  });

  it('another command given a verify-apply flag says it was ignored, instead of accepting it in silence', () => {
    const before = snapshot();
    const r = runCli(['recent', '--apply', '--digest', 'abc']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toMatch(/--apply is read only by verify-apply; recent does not read it/);
    expect(r.stderr).toMatch(/--digest is read only by verify-apply; recent does not read it/);
    // No "it had no effect": a value-taking flag can swallow the next word (P3-1).
    expect(r.stderr).not.toMatch(/--apply[^\n]*no effect/);
    expect(snapshot()).toBe(before);
  });

  it('--print-project prints the project verify-apply resolves from the working directory, and writes nothing', () => {
    const before = snapshot();
    const r = runCli(['verify-apply', '--print-project']);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(PROJECT);
    expect(snapshot()).toBe(before);
  });

  it('prints runnable commands (node + this cli.mjs), not a bare binary that may not be on PATH', () => {
    const a = seed();
    const file = writeProposals([{ id: a, action: 'retire', verdict: 'STALE', evidence: 'x' }]);
    const r = runCli(['verify-apply', file]);
    expect(r.stdout).toContain(`node ${CLI_PATH} verify-apply ${file} --project ${PROJECT} --apply --digest`);
  });

  it('an undo whose backup cannot be marked still succeeds, warns, and cannot run a second time', () => {
    const a = seed();
    const file = writeProposals([{ id: a, action: 'retire', verdict: 'STALE', evidence: 'x' }]);
    const digest = digestOf(runCli(['verify-apply', file]).stdout);
    const applied = runCli(['verify-apply', file, '--apply', '--digest', digest]);
    expect(applied.exitCode, applied.stderr).toBe(0);
    const backupPath = join(backupsDir(), readdirSync(backupsDir())[0]);
    chmodSync(backupsDir(), 0o555); // the mark (an atomic rename into this dir) will fail
    try {
      const u = runCli(['verify-apply', '--undo', backupPath]);
      expect(u.exitCode, u.stderr).toBe(0);
      expect(u.stderr).toMatch(/could not be marked as undone/);
      expect(
        db.prepare('SELECT superseded_at FROM observations WHERE id = ?').get(a).superseded_at,
      ).toBeNull();
      const again = runCli(['verify-apply', '--undo', backupPath]);
      expect(again.exitCode).toBe(1);
      expect(again.stderr).toMatch(/changed since the apply/);
    } finally {
      chmodSync(backupsDir(), 0o755);
    }
  });
});
