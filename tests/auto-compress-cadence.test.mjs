// v3.75.0 regression, caught by post-tag review: moving markAutoCompressible onto the
// auto-maintain worker (P2-11) silently cut its coverage from "every project, every
// SessionStart" to "ONE project per 24 hours".
//
// The move itself was right — nothing about opening a session makes a 30-day-old row
// newly compressible. What was missed is that the worker sits behind
// `last-auto-maintain.json`, a SINGLE gate file under the one global RUNTIME_DIR. There
// is no per-project key. So whichever project's SessionStart wins the 24h gate is the
// only project whose rows get marked; with N projects in daily rotation, N-1 of them
// never get the 7-day ACCELERATED noise pass.
//
// Precise about the blast radius, because the first framing of this overstated it: the
// losing projects' rows are not left untouched forever — the whole-DB decay still
// reaches them at 30 days and marks them COMPRESSED_PENDING_PURGE. What they lose is the
// 7-to-30-day window, and the AUTO (compressible) disposition inside it. That is exactly
// why the fixture below ages rows **10 days**: at 40 days the 30-day decay marks them
// first and the two mechanisms become indistinguishable — a fixture that hides the very
// regression it is meant to pin.
//
// The v3.75.0 release notes assert "this moves *when* the marking runs, not *what* it
// marks". These cases are what makes that sentence true.
//
// Both existing tests stayed green through the regression because each drives exactly
// one auto-maintain for one project — a second project is the thing neither could see.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const COMPRESSED_AUTO = -1;

let dataDir;

const seed = () => {
  const db = new Database(join(dataDir, 'claude-mem-lite.db'));
  const old = Date.now() - 10 * 86400000;
  const sess = db.prepare(
    "INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status) VALUES (?,?,?,?,?,'active')",
  );
  const ins = db.prepare(
    'INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, related_ids, access_count, created_at, created_at_epoch)' +
      " VALUES (?, ?, '', 'change', ?, '', '', '', '', '[]', '[]', 1, '[]', 0, ?, ?)",
  );
  for (const p of ['projA', 'projB']) {
    sess.run(`s-${p}`, `s-${p}`, p, new Date(old).toISOString(), old);
    for (let i = 0; i < 3; i++) ins.run(`s-${p}`, p, `Modified thing ${i}`, new Date(old).toISOString(), old);
  }
  db.close();
};

const runAutoMaintain = (project) =>
  execFileSync(process.execPath, [join(REPO, 'hook.mjs'), 'auto-maintain', project], {
    cwd: REPO,
    env: {
      ...process.env,
      CLAUDE_MEM_DIR: dataDir,
      CLAUDE_MEM_SKIP_COMPRESS: '1',
      CLAUDE_MEM_SKIP_OPTIMIZE: '1',
      CLAUDE_MEM_SKIP_EPISODE_LLM: '1',
    },
    stdio: 'pipe',
    timeout: 60_000,
  });

const markedCount = (project) => {
  const db = new Database(join(dataDir, 'claude-mem-lite.db'), { readonly: true });
  const row = db
    .prepare('SELECT COUNT(*) c FROM observations WHERE project = ? AND compressed_into = ?')
    .get(project, COMPRESSED_AUTO);
  db.close();
  return row.c;
};

describe('auto-compress marking cadence across projects', () => {
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cadence-'));
    // Materialize the schema through the real path, then seed.
    execFileSync(process.execPath, [join(REPO, 'cli.mjs'), 'stats'], {
      cwd: REPO,
      env: { ...process.env, CLAUDE_MEM_DIR: dataDir },
      stdio: 'pipe',
      timeout: 60_000,
    });
    seed();
  });
  afterEach(() => {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* gone */
    }
  });

  it('marks the SECOND project too, even though the global 24h gate is already stamped', () => {
    runAutoMaintain('projA');
    runAutoMaintain('projB');
    // Pre-fix: projA 3, projB 0 — projB's rows only ever reached COMPRESSED_PENDING_PURGE
    // via the whole-DB decay pass, which is a different (30d) mechanism.
    expect(markedCount('projA')).toBe(3);
    expect(markedCount('projB')).toBe(3);
  });

  it('keeps the heavy pass global — the marking gate is per project, the maintain gate is not', () => {
    runAutoMaintain('projA');
    runAutoMaintain('projB');
    const runtime = join(dataDir, 'runtime');
    const files = existsSync(runtime) ? readdirSync(runtime) : [];
    // Exactly one global maintain stamp: the expensive work (VACUUM snapshot, purge,
    // decay, dedup) must NOT run once per project.
    expect(files.filter((f) => f === 'last-auto-maintain.json')).toHaveLength(1);
    // …and one marking stamp per project that ran.
    const markStamps = files.filter((f) => f.startsWith('last-mark-compressible-'));
    expect(markStamps.sort()).toEqual([
      'last-mark-compressible-projA.json',
      'last-mark-compressible-projB.json',
    ]);
  });

  it('does not re-mark the same project twice within the window', () => {
    runAutoMaintain('projA');
    // Pin the absolute count first: `before === after` is satisfied by 0 === 0, so
    // without this the case would pass even with the marking entirely broken.
    expect(markedCount('projA')).toBe(3);
    runAutoMaintain('projA');
    // The per-project gate has to actually gate, or this is just "no gate at all".
    expect(markedCount('projA')).toBe(3);
    expect(existsSync(join(dataDir, 'runtime', 'last-mark-compressible-projA.json'))).toBe(true);
  });
});
