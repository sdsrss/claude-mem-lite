// Repo-wide invariant lock for the observation `type` vocabulary (audit 2026-07-17 MED-3).
//
// Three locks, each catching a different drift direction:
//  1. Zod enum (MCP surface) derives from OBS_TYPES — options equality.
//  2. SQL CHECK constraint (schema.mjs DDL literal) accepts exactly OBS_TYPES —
//     both behaviorally (:memory: insert) and textually (DDL source parse), so adding
//     a type to the module without editing the CHECK fails here, not in production.
//  3. No NEW hardcoded copy of the list may appear in runtime source — the historical
//     failure mode was 11 verbatim copies edited out of lockstep. Only lib/obs-types.mjs
//     (the source of truth) and schema.mjs (the DDL literal) may contain it.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { OBS_TYPES, OBS_TYPE_SET } from '../lib/obs-types.mjs';
import { OBS_TYPE_ENUM } from '../tool-schemas.mjs';
import { createTestDb, insertSession } from './test-helpers.mjs';

const ROOT = resolve(import.meta.dirname, '..');

describe('obs-types single source of truth', () => {
  it('Zod OBS_TYPE_ENUM derives from OBS_TYPES (options equality)', () => {
    expect(OBS_TYPE_ENUM.options).toEqual([...OBS_TYPES]);
  });

  it('OBS_TYPE_SET mirrors OBS_TYPES exactly', () => {
    expect([...OBS_TYPE_SET].sort()).toEqual([...OBS_TYPES].sort());
    expect(OBS_TYPE_SET.size).toBe(OBS_TYPES.length);
  });

  it('SQL CHECK accepts every OBS_TYPES value and rejects an off-enum one (behavioral)', () => {
    const db = createTestDb();
    try {
      // observations.memory_session_id FK → sdk_sessions (enforced even in :memory: tests)
      insertSession(db, { id: 'inv-cs', project: 'inv-p', memoryId: 'inv-s' });
      const insert = db.prepare(`
        INSERT INTO observations (memory_session_id, project, type, title, created_at, created_at_epoch)
        VALUES ('inv-s', 'inv-p', ?, 'invariant probe', datetime('now'), ?)
      `);
      for (const t of OBS_TYPES) {
        expect(() => insert.run(t, Date.now())).not.toThrow();
      }
      expect(() => insert.run('bogus-type', Date.now())).toThrow(/CHECK/);
    } finally {
      db.close();
    }
  });

  it('schema.mjs DDL CHECK list textually equals OBS_TYPES', () => {
    const src = readFileSync(join(ROOT, 'schema.mjs'), 'utf8');
    const m = src.match(/type TEXT NOT NULL CHECK\(type IN \(([^)]+)\)\)/);
    expect(m, 'observations CHECK(type IN …) not found in schema.mjs').toBeTruthy();
    const ddlTypes = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    expect(ddlTypes.sort()).toEqual([...OBS_TYPES].sort());
  });

  // The literal signature of the historical hardcopies. Allowed only in the source of
  // truth and the DDL literal. Tests/benchmark/docs are out of scope — they don't
  // validate production writes.
  const SIGNATURE = /'decision',\s*'bugfix',\s*'feature',\s*'refactor',\s*'discovery',\s*'change'/;

  // Hoisted so the tmp/-exclusion case below drives the SAME walker rather than a copy
  // of it. A second copy would be free to disagree with this one, which is the exact
  // defect class this whole file exists to lock down.
  const scanOffenders = () => {
    const ALLOWED = new Set(['lib/obs-types.mjs', 'schema.mjs']);
    // `tmp` (D#168): the repo's scratch dir, gitignored and a §5 safe-path. Not runtime
    // source — scanning it lets an unrelated harness parked there fail this suite with a
    // message pointing at a file nobody touched. Kept in sync with the sibling scanner in
    // tests/time-constants.test.mjs; both are pinned by a probe case below.
    const SKIP_DIRS = new Set([
      'node_modules',
      'tests',
      'benchmark',
      'docs',
      'coverage',
      'tasks',
      'tmp',
      '.tmp',
      '.git',
      '.claude',
      '.claude-plugin',
    ]);
    const offenders = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const rel = p.slice(ROOT.length + 1);
        const st = statSync(p);
        if (st.isDirectory()) {
          if (!SKIP_DIRS.has(name)) walk(p);
        } else if (/\.(mjs|js)$/.test(name)) {
          if (ALLOWED.has(rel)) continue;
          if (SIGNATURE.test(readFileSync(p, 'utf8'))) offenders.push(rel);
        }
      }
    };
    walk(ROOT);
    return offenders;
  };

  it('no runtime source file carries a NEW hardcoded copy of the list', () => {
    const offenders = scanOffenders();
    expect(
      offenders,
      `hardcoded obs-type list found in: ${offenders.join(', ')} — import lib/obs-types.mjs instead`,
    ).toEqual([]);
  });

  it('a scratch file under tmp/ cannot turn this scan red (D#168)', () => {
    // Asserting SKIP_DIRS contains 'tmp' would pass even if the walker ignored the set.
    // Write a file that WOULD be reported if scanned, and prove it is not.
    const dir = join(ROOT, 'tmp');
    const probe = join(dir, 'd168-obs-probe.mjs');
    // Remember whether tmp/ was ours to create, so a fresh clone is not left with an
    // empty scratch dir by a test that only meant to write one file into it.
    const dirWasAbsent = !existsSync(dir);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(
        probe,
        "export const T = ['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change'];\n",
      );
      // Precondition: this really is an offender, so a green result means "excluded".
      expect(SIGNATURE.test(readFileSync(probe, 'utf8'))).toBe(true);
      expect(
        scanOffenders().filter((f) => f.startsWith('tmp/')),
        'the walker descended into tmp/ — any scratch file there can now fail this suite',
      ).toEqual([]);
    } finally {
      try {
        rmSync(probe, { force: true });
      } catch {
        /* best-effort */
      }
      // Only if this case created it, and only if nothing else landed there meanwhile.
      if (dirWasAbsent) {
        try {
          rmSync(dir, { recursive: false });
        } catch {
          /* not empty — leave it */
        }
      }
    }
  });
});
