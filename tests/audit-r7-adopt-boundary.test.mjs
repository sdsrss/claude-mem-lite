// Regression pins for audit 2026-09-05 R7 P2-1 and P2-2 (docs/audits/20260905-225651.md).
// Both live on the write path into the USER's project tree, which SessionStart drives on
// every session (adopt-cli.mjs silentAutoAdopt).
//
// P2-1 — getDetailDoc() embedded CLI_INVOKE, which resolves to
//   `node /home/<user>/.claude/plugins/cache/sdsrss/claude-mem-lite/<VERSION>/cli.mjs`
// on a plugin install: machine-specific AND version-pinned. Measured on the live tree, the
// generated .claude/plugin_claude_mem_lite.md carried 24 occurrences of it. The sibling
// generator buildClaudeMdBlock() deliberately avoids CLI_INVOKE and says why — "it would make
// this committed/refreshed block churn across machines" — and the doc's exemption was written
// as "(.claude/, gitignored)", which is only true of THIS repo (.gitignore:42), not of user
// projects. `.claude/` is the standard home for project-scoped settings/commands/agents and is
// commonly committed. For those projects the file churned on every plugin version bump
// (needsRefresh sees doc drift) and handed teammates a $HOME path that exists on no other
// machine.
//
// P2-2 — removeManaged() unlinks CLAUDE.md when the remainder is whitespace-only. When that
// path is a SYMLINK into a dotfiles repo (chezmoi/stow/yadm) it deleted the LINK and orphaned
// the target. writeManaged goes the other way on purpose: lib/atomic-write.mjs lstats first and
// writes THROUGH the link, which is the audit 2026-09-02 P0-5 fix. Reachability is narrow — the
// file must be a symlink AND our block must be its entire content — but the invariant it broke
// was established by a P0, so the pin is about the invariant, not the frequency.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  existsSync,
  lstatSync,
  rmSync,
} from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { buildClaudeMdBlock, getDetailDoc, PLUGIN_SLUG } from '../adopt-content.mjs';
import { writeManaged, removeManaged } from '../claudemd.mjs';

let ROOT;

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'mem-audit-r7-adopt-'));
});

afterEach(() => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
});

describe('R7 P2-1 — generated project files carry no machine-specific path', () => {
  // Both generators write into the user's repo, so both must be byte-stable across installs.
  for (const [name, gen] of [
    ['managed CLAUDE.md block', buildClaudeMdBlock],
    ['detail doc', getDetailDoc],
  ]) {
    it(`${name} contains no absolute CLI path`, () => {
      const text = gen();
      // The exact shape CLI_INVOKE produces: `node ` + an absolute path ending in cli.mjs.
      expect(text).not.toMatch(/node\s+\/\S*cli\.mjs/);
    });

    it(`${name} contains no home directory prefix`, () => {
      expect(gen()).not.toContain(homedir());
    });

    it(`${name} contains no plugin-cache version segment`, () => {
      // `.../claude-mem-lite/3.95.0/cli.mjs` — the version is what made the file churn on
      // every release even when the prose did not change.
      expect(gen()).not.toMatch(/plugins\/cache\//);
    });
  }
});

describe('R7 P2-2 — unadopt preserves a symlinked CLAUDE.md', () => {
  const opts = () => ({ slug: PLUGIN_SLUG, version: 'v1', block: '## block', doc: 'doc body' });

  function symlinkedProject(targetContent) {
    const proj = join(ROOT, 'proj');
    const dotfiles = join(ROOT, 'dotfiles');
    mkdirSync(proj, { recursive: true });
    mkdirSync(dotfiles, { recursive: true });
    const target = join(dotfiles, 'CLAUDE.md');
    writeFileSync(target, targetContent);
    symlinkSync(target, join(proj, 'CLAUDE.md'));
    return { proj, target };
  }

  it('PREMISE: writeManaged writes THROUGH the link (P0-5 invariant)', () => {
    const { proj, target } = symlinkedProject('');
    writeManaged(proj, opts());
    expect(lstatSync(join(proj, 'CLAUDE.md')).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toContain('claude-mem-lite:begin');
  });

  it('keeps the symlink when our block was the whole file', () => {
    const { proj, target } = symlinkedProject('');
    writeManaged(proj, opts());
    removeManaged(proj, PLUGIN_SLUG);

    const link = join(proj, 'CLAUDE.md');
    expect(existsSync(link)).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    // Emptied through the link rather than deleted: the dotfiles entry stays a live target.
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf8').trim()).toBe('');
  });

  it('PREMISE: user content outside the block survives on a symlinked file', () => {
    const { proj, target } = symlinkedProject('# My project\n\nHand-written rules.\n');
    writeManaged(proj, opts());
    removeManaged(proj, PLUGIN_SLUG);

    expect(lstatSync(join(proj, 'CLAUDE.md')).isSymbolicLink()).toBe(true);
    const left = readFileSync(target, 'utf8');
    expect(left).toContain('Hand-written rules.');
    expect(left).not.toContain('claude-mem-lite:begin');
  });

  it('PREMISE: a REGULAR file we created is still deleted, not left at 0 bytes', () => {
    const proj = join(ROOT, 'regular');
    mkdirSync(proj, { recursive: true });
    writeManaged(proj, opts());
    removeManaged(proj, PLUGIN_SLUG);
    expect(existsSync(join(proj, 'CLAUDE.md'))).toBe(false);
  });
});
