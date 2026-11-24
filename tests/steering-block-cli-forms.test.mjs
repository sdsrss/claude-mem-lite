// D#934 T4 (R4 §8.3): help lookups per write were 0.27 against the O6 target of 0.1, and the help
// greps were for the forms the always-loaded text did not carry — close / closes 16, defer 32,
// supersede 2, --reason 1. The CLAUDE.md block now carries those CLI forms. Each is run here
// exactly as the block spells it (placeholders filled, the install's CLI prefixed), against a
// sandbox store, so the block cannot advertise a flag the CLI does not read.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { buildClaudeMdBlock } from '../adopt-content.mjs';
import { CLI_INVOKE } from '../cli-path.mjs';

const FORMS = {
  update: 'defer update D#N --title "<t>" --detail "<d>" --priority <1-3>',
  close: 'save "<fix>" --closes-deferred D#N',
  drop: 'defer drop D#N --reason "<why>"',
  supersede: 'save "<correction>" --supersedes NN,E#NN',
};

let root, env;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mem-block-cli-'));
  mkdirSync(join(root, 'home', '.claude'), { recursive: true });
  mkdirSync(join(root, 'proj'), { recursive: true });
  env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CLAUDE_MEM_|MEM_|CLAUDE_PLUGIN_)/.test(k)) delete env[k];
  Object.assign(env, {
    HOME: join(root, 'home'),
    CLAUDE_MEM_DIR: join(root, 'data'),
    CLAUDE_PROJECT_DIR: join(root, 'proj'),
    PWD: join(root, 'proj'),
    MEM_NO_AUTO_ADOPT: '1',
    CLAUDE_MEM_SKIP_SAVE_ENRICH: '1',
    CLAUDE_CODE_PATH: join(root, 'no-claude'),
    ANTHROPIC_API_KEY: '',
    OPENROUTER_API_KEY: '',
  });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const run = (cmd) => spawnSync('bash', ['-c', cmd], { cwd: join(root, 'proj'), env, encoding: 'utf8' });
const ok = (cmd) => {
  const r = run(cmd);
  expect(r.status, `${cmd}\n${r.stdout}${r.stderr}`).toBe(0);
  return r.stdout;
};
const db = () => new Database(join(root, 'data', 'claude-mem-lite.db'), { readonly: true });
/** The block's form with its placeholders filled, run through this install's CLI. */
function filled(name, fill) {
  let cmd = FORMS[name];
  for (const [a, b] of [
    ['"<t>"', '"probe new title"'],
    ['"<d>"', '"probe new detail"'],
    ['<1-3>', '3'],
    ['"<fix>"', '"probe fix that closed it"'],
    ['"<why>"', '"probe: not needed"'],
    ['"<correction>"', '"probe correction"'],
    ...fill,
  ])
    cmd = cmd.split(a).join(b);
  expect(cmd, 'every placeholder is filled').not.toMatch(/[<>]|D#N\b|\bNN\b/);
  return `${CLI_INVOKE} ${cmd}`;
}
const deferId = (title) => Number(/D#(\d+)/.exec(ok(`${CLI_INVOKE} defer add "${title}" --priority 2`))[1]);

describe('the CLI forms in the CLAUDE.md block run as written', () => {
  it('the block carries every form', () => {
    const block = buildClaudeMdBlock();
    for (const form of Object.values(FORMS)) expect(block).toContain(`\`${form}\``);
  });

  it('defer update rewrites the item in place', () => {
    const id = deferId('probe item to update');
    ok(filled('update', [['D#N', `D#${id}`]]));
    const h = db();
    expect(h.prepare('SELECT title, detail, priority FROM deferred_work WHERE id = ?').get(id)).toEqual({
      title: 'probe new title',
      detail: 'probe new detail',
      priority: 3,
    });
    h.close();
  });

  it('save --closes-deferred closes the item, and defer drop drops one', () => {
    const closed = deferId('probe item to close');
    const dropped = deferId('probe item to drop');
    ok(filled('close', [['D#N', `D#${closed}`]]));
    ok(filled('drop', [['D#N', `D#${dropped}`]]));
    const h = db();
    const status = (id) => h.prepare('SELECT status FROM deferred_work WHERE id = ?').get(id).status;
    expect([status(closed), status(dropped)]).toEqual(['done', 'dropped']);
    h.close();
  });

  it('save --supersedes retires an observation and an event', () => {
    const obs = Number(
      /#(\d+)/.exec(ok(`${CLI_INVOKE} save "probe stale note about rounding" --type discovery`))[1],
    );
    ok(`${CLI_INVOKE} activity save --type discovery --title "probe stale event"`);
    const h0 = db();
    const ev = h0.prepare("SELECT id FROM events WHERE title = 'probe stale event'").get().id;
    h0.close();
    ok(
      filled('supersede', [
        ['NN,E#NN', `${obs},E#${ev}`],
        ['NN', String(obs)],
      ]),
    );
    const h = db();
    expect(
      h.prepare('SELECT superseded_at FROM observations WHERE id = ?').get(obs).superseded_at,
    ).not.toBeNull();
    expect(
      h.prepare('SELECT superseded_at_epoch FROM events WHERE id = ?').get(ev).superseded_at_epoch,
    ).not.toBeNull();
    h.close();
  });
});
