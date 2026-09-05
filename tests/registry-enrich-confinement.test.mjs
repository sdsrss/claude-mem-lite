// Audit 2026-09-02 P1-3: `resources.local_path` is a filesystem path stored in a DB row, and
// every enrichment leg ends in `readFileSync(local_path)`. The confinement gate guarded
// exactly ONE of the four legs — the MCP `enrich` action — while MCP `import_url --enrich`,
// CLI `enrich <name>` and CLI `enrich --all` read the path bare.
//
// What this file pins, in the order the defect could come back:
//   1. the gate itself refuses an outside path AND never calls the enricher on a refusal
//      (a gate that denies but has already read + shipped the file is not a gate);
//   2. the escape hatch opens on exactly `off` and on nothing else — a typo must fail CLOSED;
//   3. `confineTo` is REQUIRED at all three entry points, so a fifth leg written without it
//      throws instead of silently running ungated;
//   4. every call site in both faces actually passes it (static sweep, with a self-check
//      that the matcher can return false — an always-true sweep would report the original
//      defect as absent);
//   5. end-to-end through the shipped CLI, for the two legs that need no network.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { ensureRegistryDb } from '../registry.mjs';
import {
  enrichResourceRow,
  enrichImportedResources,
  enrichNamedResource,
  registryConfineEnabled,
  REGISTRY_CONFINE_ENV,
} from '../lib/registry-core.mjs';

// join(), never new URL('../x.mjs', import.meta.url): the URL form silently drops the named
// module out of knip's unused-export report for the whole tree (CLAUDE.md knip rule 4).
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI_PATH = resolve(REPO, 'cli.mjs');

function makeTmpDir(tag) {
  const dir = join(tmpdir(), `mem-confine-${tag}-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function runCli(args, dataDir) {
  try {
    const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
      encoding: 'utf8',
      timeout: 20000,
      env: {
        ...process.env,
        CLAUDE_MEM_DIR: dataDir,
        CLAUDE_PROJECT_DIR: dataDir,
        CLAUDE_MEM_HOOK_RUNNING: undefined,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { out: stdout, exitCode: 0 };
  } catch (e) {
    return { out: (e.stdout?.toString() || '') + (e.stderr?.toString() || ''), exitCode: e.status ?? 1 };
  }
}

describe('registry enrichment confinement gate', () => {
  let base, outside, insidePath, outsidePath, db, calls;

  beforeEach(() => {
    base = makeTmpDir('base');
    outside = makeTmpDir('outside');
    insidePath = join(base, 'managed', 'skills', 'inside.md');
    outsidePath = join(outside, 'secret.md');
    mkdirSync(dirname(insidePath), { recursive: true });
    writeFileSync(insidePath, '# inside\n');
    writeFileSync(outsidePath, '# outside — must never be read\n');

    db = ensureRegistryDb(':memory:');
    calls = [];
  });
  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    for (const d of [base, outside]) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  // Records what it was handed so a "denied" result can be checked for NOT having read.
  const spyEnricher = (calls) => async (_db, name, type, content) => {
    calls.push({ name, type, content });
    return true;
  };

  function seed(name, localPath) {
    db.prepare(
      "INSERT INTO resources (name, type, status, source, local_path) VALUES (?, 'skill', 'active', 'user', ?)",
    ).run(name, localPath);
    return db.prepare('SELECT name, type, local_path FROM resources WHERE name = ?').get(name);
  }

  // ── 1. the gate ───────────────────────────────────────────────────────────
  it('refuses a local_path outside the base and does NOT call the enricher', async () => {
    const row = seed('evil', outsidePath);
    const res = await enrichResourceRow(db, row, {
      confineTo: base,
      enrichResource: spyEnricher(calls),
      env: {},
    });
    expect(res.status).toBe('denied');
    // The whole point of a confinement gate is that the bytes never leave the disk. Asserting
    // only the status would still pass if the read moved above the check.
    expect(calls).toEqual([]);
  });

  it('allows a local_path inside the base and passes its content through', async () => {
    const row = seed('good', insidePath);
    const res = await enrichResourceRow(db, row, {
      confineTo: base,
      enrichResource: spyEnricher(calls),
      env: {},
    });
    expect(res.status).toBe('enriched');
    expect(calls).toHaveLength(1);
    expect(calls[0].content).toContain('# inside');
  });

  it('refuses a ../ traversal that textually starts with the base', async () => {
    const row = seed('traverse', join(base, 'managed', '..', '..', 'secret.md'));
    const res = await enrichResourceRow(db, row, {
      confineTo: base,
      enrichResource: spyEnricher(calls),
      env: {},
    });
    expect(res.status).toBe('denied');
    expect(calls).toEqual([]);
  });

  it('separates a missing path, an unreadable file and a refusal', async () => {
    // `resources.local_path` is NOT NULL, so "no path" is the empty string the import path
    // actually writes (`fields[f] = flags[...] || ''`), not NULL.
    const noPath = await enrichResourceRow(db, seed('nopath', ''), {
      confineTo: base,
      enrichResource: spyEnricher(calls),
      env: {},
    });
    expect(noPath.status).toBe('no-path');

    const gone = await enrichResourceRow(db, seed('gone', join(base, 'managed', 'does-not-exist.md')), {
      confineTo: base,
      enrichResource: spyEnricher(calls),
      env: {},
    });
    expect(gone.status).toBe('unreadable');
    // The errno is the whole diagnosis for a stale local_path — losing it in the refactor
    // would have been a silent diagnosability regression on the one leg that surfaced it.
    expect(gone.error?.message).toMatch(/ENOENT/);
    expect(calls).toEqual([]);
  });

  it('reports an enricher throw as failed, distinguishable from a refusal', async () => {
    const row = seed('boom', insidePath);
    const res = await enrichResourceRow(db, row, {
      confineTo: base,
      enrichResource: async () => {
        throw new Error('API 429');
      },
      env: {},
    });
    expect(res.status).toBe('failed');
    expect(res.error?.message).toBe('API 429');
  });

  // ── 2. the escape hatch fails closed ──────────────────────────────────────
  it('opens on exactly "off" (case/space-insensitive) and stays shut on anything else', () => {
    for (const v of ['off', 'OFF', ' off ', 'Off']) {
      expect(registryConfineEnabled({ [REGISTRY_CONFINE_ENV]: v })).toBe(false);
    }
    // A typo, a plausible synonym, and the two shapes people reach for must all keep the
    // gate ON: the failure mode of a mistyped switch must be "refuses a path it could have
    // read", never "reads a path it should have refused".
    for (const v of [undefined, '', 'offf', 'of', '0', 'false', 'no', 'disable', 'on', 'true']) {
      expect(registryConfineEnabled({ [REGISTRY_CONFINE_ENV]: v })).toBe(true);
    }
  });

  it('the escape hatch actually admits the outside path', async () => {
    const row = seed('evil', outsidePath);
    const res = await enrichResourceRow(db, row, {
      confineTo: base,
      enrichResource: spyEnricher(calls),
      env: { [REGISTRY_CONFINE_ENV]: 'off' },
    });
    expect(res.status).toBe('enriched');
    expect(calls).toHaveLength(1);
  });

  // ── 3. confineTo is required at every entry point ─────────────────────────
  it('throws rather than running ungated when confineTo is omitted — at all three entries', async () => {
    const row = seed('x', insidePath);
    await expect(enrichResourceRow(db, row, { enrichResource: spyEnricher(calls) })).rejects.toThrow(
      /confineTo is required/,
    );
    // Empty inputs are the ones a careless test would use, so the wrappers must throw ABOVE
    // their short-circuits rather than delegating the check.
    await expect(enrichImportedResources(db, [], { enrichResource: spyEnricher(calls) })).rejects.toThrow(
      /confineTo is required/,
    );
    await expect(
      enrichNamedResource(db, 'no-such-name', { enrichResource: spyEnricher(calls) }),
    ).rejects.toThrow(/confineTo is required/);
    expect(calls).toEqual([]);
  });

  it('enrichNamedResource and enrichImportedResources carry the gate through', async () => {
    seed('evil', outsidePath);
    const named = await enrichNamedResource(db, 'evil', {
      confineTo: base,
      enrichResource: spyEnricher(calls),
      env: {},
    });
    expect(named.status).toBe('denied');

    const inside = seed('good', insidePath);
    const imported = await enrichImportedResources(
      db,
      [
        { id: db.prepare('SELECT id FROM resources WHERE name = ?').get('evil').id },
        { id: db.prepare('SELECT id FROM resources WHERE name = ?').get('good').id },
      ],
      { confineTo: base, enrichResource: spyEnricher(calls), env: {} },
    );
    expect(imported).toEqual({ ok: 1, denied: 1, total: 2 });
    expect(calls.map((c) => c.name)).toEqual([inside.name]);
  });
});

// ── 4. static sweep: every call site in both faces passes confineTo ─────────
describe('every enrichment call site in both faces is gated', () => {
  const GATED_FNS = ['enrichResourceRow', 'enrichImportedResources', 'enrichNamedResource'];

  /**
   * Find calls to the gated functions and report whether each passes `confineTo`.
   * Deliberately NOT a whole-file grep for the word: `confineTo` appearing anywhere in the
   * file would let an ungated call site hide behind a gated neighbour.
   */
  function scanCallSites(src) {
    const sites = [];
    for (const fn of GATED_FNS) {
      const re = new RegExp(`\\b${fn}\\s*\\(`, 'g');
      let m;
      while ((m = re.exec(src))) {
        // Balanced-paren scan from the opening bracket so only THIS call's arguments count.
        let depth = 0,
          i = m.index + m[0].length - 1;
        for (; i < src.length; i++) {
          if (src[i] === '(') depth++;
          else if (src[i] === ')') {
            depth--;
            if (depth === 0) break;
          }
        }
        const args = src.slice(m.index, i + 1);
        // Declarations/imports are not call sites; skip the definition itself.
        if (/^\s*(export\s+)?(async\s+)?function\s/.test(src.slice(Math.max(0, m.index - 30), m.index)))
          continue;
        sites.push({ fn, gated: /\bconfineTo\s*:/.test(args), args });
      }
    }
    return sites;
  }

  it('the scanner can return false — otherwise a green sweep proves nothing', () => {
    const ungated = scanCallSites('await enrichNamedResource(rdb, name, { enrichResource });');
    expect(ungated).toHaveLength(1);
    expect(ungated[0].gated).toBe(false);
    const gated = scanCallSites(
      'await enrichNamedResource(rdb, name, { confineTo: DB_DIR, enrichResource });',
    );
    expect(gated[0].gated).toBe(true);
    // A nested call must not let an inner argument list satisfy the outer one.
    const nested = scanCallSites(
      'await enrichNamedResource(rdb, pick({ confineTo: X }), { enrichResource })',
    );
    expect(nested[0].args).toContain('pick(');
  });

  for (const face of ['server.mjs', 'mem-cli.mjs']) {
    it(`${face}: every call site passes confineTo, and there is at least one`, () => {
      const src = readFileSync(join(dirname(dirname(fileURLToPath(import.meta.url))), face), 'utf8');
      const sites = scanCallSites(src);
      // "at least one" kills the vacuous pass: deleting every leg would otherwise be green.
      expect(sites.length).toBeGreaterThan(0);
      expect(sites.filter((s) => !s.gated).map((s) => `${s.fn}: ${s.args.slice(0, 120)}`)).toEqual([]);
    });
  }

  it('all four legs are present across the two faces', () => {
    const repo = dirname(dirname(fileURLToPath(import.meta.url)));
    const all = ['server.mjs', 'mem-cli.mjs'].flatMap((f) =>
      scanCallSites(readFileSync(join(repo, f), 'utf8')),
    );
    // MCP import_url --enrich · MCP enrich · CLI import --enrich · CLI enrich <name> ·
    // CLI enrich --all = 5 call sites over 4 user-facing legs (the CLI's two enrich legs
    // share one command). Raise this deliberately when a leg is added; the per-file check
    // above is the rule, this is the count that stops a leg from vanishing unnoticed.
    expect(all).toHaveLength(5);
  });
});

// ── 5. end-to-end through the shipped CLI ──────────────────────────────────
describe('CLI enrich refuses an out-of-base local_path (end to end)', () => {
  let dataDir, outside;
  beforeEach(() => {
    dataDir = makeTmpDir('cli');
    outside = makeTmpDir('cli-out');
  });
  afterEach(() => {
    for (const d of [dataDir, outside]) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('enrich <name> and enrich --all both refuse, naming the escape hatch', () => {
    const secret = join(outside, 'secret.md');
    writeFileSync(secret, '# must not be read\n');
    const imported = runCli(
      ['registry', 'import', '--name', 'outside-skill', '--resource-type', 'skill', '--local-path', secret],
      dataDir,
    );
    // Premise first: without this the two assertions below pass on an empty registry.
    expect(imported.out).toContain('Imported: skill:outside-skill');

    const named = runCli(['enrich', 'outside-skill'], dataDir);
    expect(named.out).toContain('outside the managed directory');
    expect(named.out).toContain(REGISTRY_CONFINE_ENV);
    // Reaching the enricher would produce an API-shaped message instead; assert we did not.
    expect(named.out).not.toContain('Enriched: outside-skill');

    const all = runCli(['enrich', '--all', '--batch'], dataDir);
    expect(all.out).toMatch(/Refused 1/);
  });
});
