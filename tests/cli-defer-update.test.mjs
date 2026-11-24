// `defer update` (D#934 T3, R4 §8.3): the CLI had add / list / drop and no way to change an item,
// so 41 of 131 drops in 11-04..11-23 were a drop followed by a re-add of the same item rewritten,
// and one dated calendar item was rebuilt five times (D#849 → 858 → 874 → 876 → 882 → 888), each
// under a new D# id. `defer update` rewrites an open item's title, detail or priority in place.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs');
// Assembled, so the source holds no credential-shaped literal (push protection).
const SECRET = 'sk-ant-' + 'api03-' + 'A'.repeat(47);

let root, dataDir, projectDir;
function cli(...args) {
  const env = {
    ...process.env,
    HOME: join(root, 'home'),
    CLAUDE_MEM_DIR: dataDir,
    CLAUDE_PROJECT_DIR: projectDir,
    PWD: projectDir,
    CLAUDE_MEM_SKIP_SAVE_ENRICH: '1',
    MEM_NO_AUTO_ADOPT: '1',
  };
  delete env.CLAUDE_MEM_HOOK_RUNNING;
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 20000,
    cwd: projectDir,
    env,
  });
}
function row(id) {
  const db = new Database(join(dataDir, 'claude-mem-lite.db'), { readonly: true });
  const r = db
    .prepare('SELECT project, title, detail, priority, status FROM deferred_work WHERE id = ?')
    .get(id);
  db.close();
  return r;
}
function add(title, ...rest) {
  const r = cli('defer', 'add', title, ...rest);
  expect(r.status, r.stderr).toBe(0);
  return Number(/D#(\d+)/.exec(r.stdout)[1]);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mem-defer-update-'));
  dataDir = join(root, 'data');
  projectDir = join(root, 'work', 'invoice-app');
  mkdirSync(join(root, 'home'), { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 'claude-mem-lite.db'));
  initSchema(db);
  db.close();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('defer update', () => {
  it('rewrites the title, detail and priority of an open item in place, under the same id', () => {
    const id = add('recapture the baseline ~11-25', '--priority', '2', '--detail', 'old plan');
    const r = cli(
      'defer',
      'update',
      `D#${id}`,
      '--title',
      'recapture the baseline before 12-01',
      '--detail',
      'new plan',
      '--priority',
      '3',
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`Updated D#${id} "recapture the baseline before 12-01"`);
    expect(row(id)).toEqual({
      project: 'work--invoice-app',
      title: 'recapture the baseline before 12-01',
      detail: 'new plan',
      priority: 3,
      status: 'open',
    });
  });

  it('changes only the fields given; an ordinal works; an empty --detail clears it', () => {
    const a = add('item A', '--priority', '1', '--detail', 'keep me');
    const b = add('item B', '--priority', '3', '--detail', 'drop me');
    // Ordinals follow priority: B (3) is item 1.
    expect(cli('defer', 'update', '1', '--priority', '2').status).toBe(0);
    expect(row(b)).toMatchObject({ title: 'item B', detail: 'drop me', priority: 2 });
    expect(cli('defer', 'update', `D#${b}`, '--detail=').status).toBe(0);
    expect(row(b).detail).toBeNull();
    expect(row(a)).toMatchObject({ title: 'item A', detail: 'keep me', priority: 1 });
  });

  it('scrubs a secret in the new title and detail, as defer add does', () => {
    const id = add('rotate the key');
    expect(
      cli('defer', 'update', `D#${id}`, '--title', `rotate ${SECRET}`, '--detail', `was ${SECRET}`).status,
    ).toBe(0);
    const r = row(id);
    expect(r.title).not.toContain(SECRET);
    expect(r.detail).not.toContain(SECRET);
  });

  it('refuses, and changes nothing, on every malformed request', () => {
    const id = add('item A', '--priority', '2', '--detail', 'd');
    const before = row(id);
    const cases = [
      ['defer', 'update', `D#${id}`], // no field
      ['defer', 'update', '--title', 'x'], // no item
      ['defer', 'update', `D#${id}`, '--priority', '4'],
      ['defer', 'update', `D#${id}`, '--priority', '3x'],
      ['defer', 'update', `D#${id}`, '--title', '   '],
      ['defer', 'update', `D#${id}`, '--title', 'x'.repeat(201)],
      ['defer', 'update', `D#${id}`, '--title'], // bare flag
      ['defer', 'update', `D#${id},D#${id}`, '--priority', '3'], // one item at a time
      ['defer', 'update', `D#${id}`, 'new title as text', '--priority', '3'],
      ['defer', 'update', 'D#999', '--priority', '3'],
      ['defer', 'update', `D#${id}`, '--priority', '3', '--reason', 'x'], // a flag update does not read
      ['defer', 'update', `D#${id}`, '--priority', '3', '--dry-run'], // it has no preview
    ];
    for (const args of cases) {
      const r = cli(...args);
      expect(r.status, `${args.join(' ')}\n${r.stdout}${r.stderr}`).toBe(1);
      expect(r.stdout + r.stderr, args.join(' ')).toMatch(/\S/);
    }
    expect(row(id)).toEqual(before);
  });

  it('refuses an item that is no longer open, and one from another project', () => {
    const dropped = add('item A');
    expect(cli('defer', 'drop', `D#${dropped}`, '--reason', 'not needed').status).toBe(0);
    const r = cli('defer', 'update', `D#${dropped}`, '--priority', '3');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/status is "dropped"/);
    expect(row(dropped).priority).toBe(2);

    const other = add('elsewhere', '--project', 'work--billing');
    const o = cli('defer', 'update', `D#${other}`, '--title', 'hijacked');
    expect(o.status).toBe(1);
    expect(o.stderr).toMatch(/belongs to project "work--billing"/);
    expect(row(other).title).toBe('elsewhere');
    // With the item's own project named, the same update goes through.
    expect(
      cli('defer', 'update', `D#${other}`, '--title', 'renamed', '--project', 'work--billing').status,
    ).toBe(0);
    expect(row(other).title).toBe('renamed');
  });

  it('is listed in help and in the defer usage line', () => {
    expect(cli('help').stdout).toMatch(/^\s+update <D#N\|ordinal>/m);
    expect(cli('defer').stderr).toContain('defer <add|list|update|drop>');
  });
});
