// v6.32.0 pre-release defects review F1: the steering sync reads instruction files in every directory
// above the project (D#509(4), D#760). A FIFO planted there — /tmp is writable by every local user —
// blocked the read, and SessionStart hung until the host cancelled it, with no steering. Claude Code
// itself skips anything that is not a regular file. A blocked synchronous read cannot be interrupted
// from inside the worker, so each case runs in a child process with a deadline, and with its data
// segment capped at 1 GiB, so an endless device read fails in a fraction of a second instead of
// filling memory.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { execFileSync, spawnSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { mkdtempWithoutInstructionAncestors } from './test-helpers.mjs';
import { holdsOnlyOwnLines, holdsOnlyPluginLines, readBlockAt, writeManaged } from '../claudemd.mjs';
import {
  PLUGIN_SLUG,
  CURRENT_SENTINEL_VERSION,
  buildClaudeMdBlock,
  getDetailDoc,
} from '../adopt-content.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const ADOPT = pathToFileURL(join(REPO, 'adopt-cli.mjs')).href;

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const initRepo = (dir) => {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  writeFileSync(join(dir, 'README.md'), '# app\n');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
};
const mkfifo = (p) => execFileSync('mkfifo', [p]);

describe('a FIFO or a device where an instruction file would sit above the project', () => {
  let home;
  beforeEach(() => {
    home = mkdtempWithoutInstructionAncestors('cml-fifo-');
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  // The session's sync in a child: its result, or how it ended.
  const sessionIn = (cwd) => {
    const env = { ...process.env, HOME: home };
    for (const k of [
      'CLAUDE_CONFIG_DIR',
      'CLAUDE_MEM_DIR',
      'MEM_NO_AUTO_ADOPT',
      'CLAUDE_MEM_NO_TEMPLATE_REFRESH',
    ])
      delete env[k];
    const r = spawnSync(
      'sh',
      [
        '-c',
        'ulimit -d 1048576; exec "$0" "$@"',
        process.execPath,
        '--input-type=module',
        '-e',
        `const { silentAutoAdopt } = await import(${JSON.stringify(ADOPT)});` +
          `const r = silentAutoAdopt({ cwd: ${JSON.stringify(cwd)} });` +
          'process.stdout.write(JSON.stringify({ r, rssKb: process.resourceUsage().maxRSS }));',
      ],
      { env, encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' },
    );
    const out = r.status === 0 ? JSON.parse(r.stdout) : null;
    return { signal: r.signal, status: r.status, result: out?.r ?? null, rssKb: out?.rssKb ?? null };
  };

  it('a FIFO CLAUDE.local.md above a git repository counts as nothing', () => {
    const app = join(home, 'work', 'app');
    initRepo(app);
    mkfifo(join(home, 'work', 'CLAUDE.local.md'));
    const s = sessionIn(app);
    expect(s.signal, 'the sync must not block on the FIFO').toBeNull();
    expect(s.result).toMatchObject({ action: 'local', written: 'created' });
  });

  it('outside git, a FIFO CLAUDE.md above counts as nothing and the text is injected', () => {
    const deep = join(home, 'work', 'notes');
    mkdirSync(deep, { recursive: true });
    mkfifo(join(home, 'work', 'CLAUDE.md'));
    const s = sessionIn(deep);
    expect(s.signal, 'the sync must not block on the FIFO').toBeNull();
    expect(s.result).toMatchObject({ action: 'inject' });
  });

  it('a FIFO in place of the detail doc beside a CLAUDE.md block above: that block is not current', () => {
    const work = join(home, 'work');
    const app = join(work, 'app');
    initRepo(app);
    writeManaged(work, {
      slug: PLUGIN_SLUG,
      version: CURRENT_SENTINEL_VERSION,
      block: buildClaudeMdBlock(),
      doc: getDetailDoc(),
    });
    const doc = join(work, '.claude', 'plugin_claude_mem_lite.md');
    rmSync(doc);
    mkfifo(doc);
    const s = sessionIn(app);
    expect(s.signal, 'the sync must not block on the FIFO').toBeNull();
    expect(s.result).toMatchObject({ action: 'local', written: 'created' });
  });

  // Not a FIFO but a character device: read to the end, it never ends (the regular-file check).
  it('a symlink to /dev/zero as CLAUDE.local.md above counts as nothing', () => {
    const app = join(home, 'work', 'app');
    initRepo(app);
    symlinkSync('/dev/zero', join(home, 'work', 'CLAUDE.local.md'));
    const s = sessionIn(app);
    expect(s.signal).toBeNull();
    expect(s.status).toBe(0);
    expect(s.result).toMatchObject({ action: 'local', written: 'created' });
    // Read, the device fills the capped data segment before the read fails and is caught: the
    // outcome alone cannot tell, the peak memory can.
    expect(s.rssKb, 'the sync must not read the device').toBeLessThan(400_000);
  });

  // Delta review R2-2: the AGENTS.md check above the project read the same files with a plain read.
  it('beside an AGENTS.md, a FIFO CLAUDE.md above does not stall the AGENTS.md check', () => {
    const app = join(home, 'work', 'app');
    initRepo(app);
    writeFileSync(join(app, 'AGENTS.md'), '# agents\n');
    mkfifo(join(home, 'work', 'CLAUDE.md'));
    const s = sessionIn(app);
    expect(s.signal, 'the sync must not block on the FIFO').toBeNull();
    expect(s.result).toMatchObject({ action: 'inject', reason: 'local-agents-md' });
  });
});

describe('the instruction-file readers', () => {
  // A file Claude Code would not load (over 4,194,304 bytes) is not read whole, and is never taken for
  // one holding only plugin text: unadopt deletes a file that holds nothing else.
  it('an over-limit file holding only the block is not plugin-only text', () => {
    const dir = mkdtempWithoutInstructionAncestors('cml-big-');
    try {
      const p = join(dir, 'CLAUDE.local.md');
      writeFileSync(
        p,
        `<!-- ${PLUGIN_SLUG}:begin ${CURRENT_SENTINEL_VERSION} -->\n${'x'.repeat(4194304)}\n<!-- ${PLUGIN_SLUG}:end -->\n`,
      );
      expect(holdsOnlyOwnLines(p, PLUGIN_SLUG)).toBe(false);
      expect(holdsOnlyPluginLines(p, PLUGIN_SLUG)).toBe(false);
      expect(readBlockAt(p, PLUGIN_SLUG).body).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Delta review R2-6: every read opens a descriptor; a long-lived process (the MCP server) must not
  // leak them.
  it('closes the descriptor it opens', () => {
    const dir = mkdtempWithoutInstructionAncestors('cml-fd-');
    try {
      const p = join(dir, 'CLAUDE.md');
      writeFileSync(p, '# notes\n');
      const open = () => readdirSync('/proc/self/fd').length;
      const before = open();
      for (let i = 0; i < 200; i++) readBlockAt(p, PLUGIN_SLUG);
      expect(open() - before).toBeLessThan(10);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
