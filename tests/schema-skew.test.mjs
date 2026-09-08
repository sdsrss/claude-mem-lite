// Schema skew = the DB on disk carries a HIGHER schema_version than the code trying to
// open it. It is a one-way ratchet: an old binary cannot read a new schema, so the only
// real repair is getting newer code. schema.mjs has thrown on this since long before this
// module — what was missing is everything that happens NEXT.
//
// Measured on this machine 2026-09-08: DB v49, live plugin 5.6.0 (supports v48). Result was
// >=648 identical entries in runtime/hook-errors/2026-09-08.jsonl in one day, still growing;
// the MCP server died at boot so the host reported only `-32000 Connection closed`; and
// hook.mjs's `const db = openDb(); if (!db) return;` made SessionStart return in silence.
// The user's only signal was that memory had quietly stopped working.
//
// Two things this file pins that are easy to get wrong:
//
// 1. THE REMEDY MUST MATCH THE INSTALL SHAPE. The message schema.mjs has always thrown
//    says `npm i -g claude-mem-lite@latest` — which does nothing for a plugin-cache
//    install, and a plugin-cache install is exactly the shape that hits this (the cache is
//    advanced by Claude Code's marketplace updater, so it lags whatever else wrote the DB).
//    Sending a user down a repair that cannot work is worse than saying nothing.
//
// 2. THREE OUTCOMES, NEVER TWO. "this home is fine" and "I could not determine this home's
//    version" must not print in the same voice — the v6.2.0 doctor check shipped with
//    exactly that bug (a green "no hook command needs bash" on the shape where they are
//    live). A count of zero is only reportable when something was actually read.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import Database from 'better-sqlite3';

import {
  SCHEMA_SKEW_CODE,
  isSchemaSkewError,
  schemaSkewFromError,
  schemaSkewRemedy,
  formatSchemaSkewNotice,
  schemaCompatProbeSource,
  probeSchemaCompatInFreshProcess,
  probeSchemaCompat,
} from '../lib/schema-skew.mjs';

const REPO = resolve(import.meta.dirname, '..');
const fixtures = [];

afterEach(() => {
  for (const d of fixtures.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* gone */
    }
  }
});

function tmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  fixtures.push(d);
  return d;
}

/** A DB carrying exactly one schema_version row. */
function dbAtVersion(version) {
  const dir = tmp('skew-db-');
  const path = join(dir, 'claude-mem-lite.db');
  const db = new Database(path);
  db.exec('CREATE TABLE schema_version (version INTEGER)');
  db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version);
  db.close();
  return path;
}

/**
 * A code home that reports `supported` as its CURRENT_SCHEMA_VERSION, sharing the repo's
 * real node_modules so better-sqlite3 resolves. Deliberately NOT a copy of the real
 * schema.mjs: the probe's contract is "ask the module what it supports", and a stub proves
 * the probe reads the module rather than the repo it happens to live next to.
 */
function codeHomeSupporting(supported) {
  const dir = tmp('skew-home-');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'stub', version: '0.0.0' }));
  writeFileSync(join(dir, 'schema.mjs'), `export const CURRENT_SCHEMA_VERSION = ${supported};\n`);
  symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

describe('isSchemaSkewError / schemaSkewFromError', () => {
  it('recognises the coded error and reads both versions off it', () => {
    const err = new Error('DB schema is v49 but this claude-mem-lite binary supports up to v48.');
    err.code = SCHEMA_SKEW_CODE;
    err.dbVersion = 49;
    err.binaryVersion = 48;

    expect(isSchemaSkewError(err)).toBe(true);
    expect(schemaSkewFromError(err)).toEqual({ dbVersion: 49, binaryVersion: 48 });
  });

  it('falls back to the message when the error carries no fields', () => {
    // The shipped message is the contract older builds throw; the code field is new.
    const err = new Error(
      'DB schema is v49 but this claude-mem-lite binary supports up to v48. A newer version wrote this DB;',
    );
    expect(isSchemaSkewError(err)).toBe(true);
    expect(schemaSkewFromError(err)).toEqual({ dbVersion: 49, binaryVersion: 48 });
  });

  it('says no to unrelated failures, including the native-binding family', () => {
    expect(isSchemaSkewError(new Error('NODE_MODULE_VERSION 127 ... requires 137'))).toBe(false);
    expect(isSchemaSkewError(new Error('database disk image is malformed'))).toBe(false);
    expect(isSchemaSkewError(null)).toBe(false);
    expect(isSchemaSkewError('DB schema is v49')).toBe(true); // a thrown string still classifies
    expect(schemaSkewFromError(new Error('nope'))).toBeNull();
  });
});

describe('schemaSkewRemedy — the command must match the install shape', () => {
  it('sends a plugin install to the plugin updater, NOT to npm', () => {
    const r = schemaSkewRemedy({
      managed: false,
      activePluginVersion: { version: '5.6.0' },
      marketplace: 'sdsrss',
    });
    expect(r.kind).toBe('plugin');
    expect(r.commands.join('\n')).toContain('/plugin marketplace update sdsrss');
    expect(r.commands.join('\n')).toContain('/plugin update claude-mem-lite@sdsrss');
    // The RED case: this is the string schema.mjs has always printed, and it repairs nothing here.
    expect(r.commands.join('\n')).not.toContain('npm i -g');
  });

  it('sends a managed install to the CLI updater', () => {
    const r = schemaSkewRemedy({ managed: true, activePluginVersion: null });
    expect(r.kind).toBe('managed');
    expect(r.commands.join('\n')).toContain('self-update');
  });

  it('tells a dev checkout to move its own tree', () => {
    const r = schemaSkewRemedy({ managed: true, activePluginVersion: null, dev: true });
    expect(r.kind).toBe('dev');
    expect(r.commands.join('\n')).toMatch(/git pull/);
  });

  it('answers UNKNOWN rather than inventing a repair when no shape is detectable', () => {
    const r = schemaSkewRemedy({ managed: false, activePluginVersion: null });
    expect(r.kind).toBe('unknown');
    expect(r.commands).toEqual([]);
    // Must name what it looked at — "I could not look" and "nothing to do" are different answers.
    expect(r.note).toMatch(/~\/\.claude-mem-lite|plugin cache/);
  });
});

describe('formatSchemaSkewNotice', () => {
  it('carries both versions and only the shape-correct command', () => {
    const notice = formatSchemaSkewNotice({
      dbVersion: 49,
      binaryVersion: 48,
      remedy: schemaSkewRemedy({
        managed: false,
        activePluginVersion: { version: '5.6.0' },
        marketplace: 'sdsrss',
      }),
    });
    expect(notice).toContain('49');
    expect(notice).toContain('48');
    expect(notice).toContain('/plugin update claude-mem-lite@sdsrss');
    expect(notice).not.toContain('npm i -g');
    // One block, not a wall: the SessionStart envelope shares stdout with the dashboard.
    expect(notice.split('\n').length).toBeLessThanOrEqual(8);
  });

  it('still renders when the shape is unknown, without printing a command', () => {
    const notice = formatSchemaSkewNotice({
      dbVersion: 49,
      binaryVersion: 48,
      remedy: schemaSkewRemedy({ managed: false, activePluginVersion: null }),
    });
    expect(notice).toContain('49');
    expect(notice).not.toMatch(/\/plugin update|self-update/);
  });
});

describe('schemaCompatProbeSource — a path cannot break out of the -e script', () => {
  // This function interpolates three filesystem paths into JavaScript source that is then
  // handed to `node -e`. A plugin cache root or a CLAUDE_MEM_DIR is user-controlled, so
  // every one goes through JSON.stringify — the same discipline binding-probe.mjs states
  // for its own probe. Pinned here because the export exists for exactly this reason.
  const hostile = '/tmp/a"; process.exit(42); //';

  it('stays syntactically valid when the paths carry quotes and backslashes', () => {
    const src = schemaCompatProbeSource(hostile, '/tmp/b\\"c.db');
    // Parses without executing. A naive interpolation produces source that either fails to
    // parse or parses into something else entirely; both are caught here.
    expect(() => new Function(src)).not.toThrow();
  });

  it('embeds each path as a quoted string literal, not as code', () => {
    const src = schemaCompatProbeSource(hostile, '/tmp/x.db');
    expect(src).toContain(JSON.stringify(join(hostile, 'package.json')));
    expect(src).toContain(JSON.stringify('/tmp/x.db'));
    // The payload must never appear as bare source.
    expect(src).not.toContain('"; process.exit(42); //');
  });
});

describe('probeSchemaCompatInFreshProcess — asks the module, does not parse it', () => {
  it('reports ok when the home supports the DB version', () => {
    const r = probeSchemaCompatInFreshProcess(codeHomeSupporting(49), dbAtVersion(49));
    expect(r).toMatchObject({ status: 'ok', supported: 49, dbVersion: 49 });
  });

  it('reports skew when the home is behind the DB', () => {
    const r = probeSchemaCompatInFreshProcess(codeHomeSupporting(48), dbAtVersion(49));
    expect(r).toMatchObject({ status: 'skew', supported: 48, dbVersion: 49 });
  });

  it('reports unknown — not ok — when the home has no readable schema.mjs', () => {
    const dir = tmp('skew-empty-');
    writeFileSync(join(dir, 'package.json'), '{"name":"stub","version":"0.0.0"}');
    const r = probeSchemaCompatInFreshProcess(dir, dbAtVersion(49));
    expect(r.status).toBe('unknown');
    expect(r.error).toBeTruthy();
  });

  it('reports unknown when the child produced no parseable stdout', () => {
    // The native-crash shape: exit non-zero, stdout empty, the diagnosis only on stderr.
    // Unreachable without a seam, and a defensive branch nothing drives is a dead guard.
    const r = probeSchemaCompatInFreshProcess('/root', '/db', {
      spawn: () => ({ stdout: '', stderr: 'Segmentation fault\n', status: null, signal: 'SIGSEGV' }),
    });
    expect(r).toEqual({ status: 'unknown', error: 'Segmentation fault' });
  });

  it('falls back to the exit status when the child leaves nothing on either stream', () => {
    const r = probeSchemaCompatInFreshProcess('/root', '/db', {
      spawn: () => ({ stdout: '', stderr: '', status: 3 }),
    });
    expect(r.status).toBe('unknown');
    expect(r.error).toMatch(/exited 3/);
  });

  it('reports unknown when the DB is unreadable, rather than calling the home fine', () => {
    const r = probeSchemaCompatInFreshProcess(codeHomeSupporting(49), join(tmp('skew-nodb-'), 'absent.db'));
    expect(r.status).toBe('unknown');
  });
});

describe('probeSchemaCompat over several homes', () => {
  it('names the home that cannot open the DB and leaves the others alone', () => {
    const roots = [
      { label: 'managed install (~/.claude-mem-lite)', root: '/m' },
      { label: 'plugin cache v5.6.0', root: '/p' },
    ];
    const results = probeSchemaCompat(roots, '/db', {
      probe: (root) =>
        root === '/p'
          ? { status: 'skew', supported: 48, dbVersion: 49 }
          : { status: 'ok', supported: 49, dbVersion: 49 },
    });
    expect(results).toHaveLength(2);
    expect(results.find((r) => r.root === '/p')).toMatchObject({
      status: 'skew',
      label: 'plugin cache v5.6.0',
    });
    expect(results.find((r) => r.root === '/m').status).toBe('ok');
  });
});
