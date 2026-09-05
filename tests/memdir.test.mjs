// Phase B (Invited-Memory plan, T5–T9): memdir.mjs primitives.
// Covers: project-path encoding, sentinel IO (read/write/remove), plugin
// doc file IO, adoption detection, hash-guard and 180-line budget.
// See docs/plans/2026-04-16-invited-memory-pattern.md.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import {
  encodeProjectPath,
  memdirPath,
  readMemoryIndex,
  writePluginSection,
  removePluginSection,
  writePluginDoc,
  removePluginDoc,
  isAdopted,
  auditMemdir,
  UserEditedError,
  BudgetExceededError,
} from '../memdir.mjs';

// ─── T5: encodeProjectPath ───────────────────────────────────────────────────

describe('encodeProjectPath', () => {
  it('matches ground-truth for the mem project itself (#7687)', () => {
    expect(encodeProjectPath('/mnt/data_ssd/dev/projects/mem')).toBe('-mnt-data-ssd-dev-projects-mem');
  });

  it('mangles dots and underscores', () => {
    expect(encodeProjectPath('/Users/alice/Work/proj.v2')).toBe('-Users-alice-Work-proj-v2');
    expect(encodeProjectPath('my_project')).toBe('my-project');
  });

  it('mangles CJK and other non-alphanumeric to "-" per Claude Code policy', () => {
    // Memory ref #7687: EVERY non-alphanumeric char is replaced, including CJK
    const out = encodeProjectPath('/home/sds/项目');
    expect(out.startsWith('-home-sds-')).toBe(true);
    // Length must equal input length (one-to-one replacement)
    expect(out.length).toBe('/home/sds/项目'.length);
  });

  it('preserves alphanumerics exactly', () => {
    expect(encodeProjectPath('abc123XYZ')).toBe('abc123XYZ');
  });
});

// ─── T5: memdirPath ──────────────────────────────────────────────────────────

describe('memdirPath', () => {
  it('combines home + .claude/projects/<encoded>/memory/', () => {
    const p = memdirPath('/mnt/data_ssd/dev/projects/mem');
    expect(p).toBe(join(homedir(), '.claude', 'projects', '-mnt-data-ssd-dev-projects-mem', 'memory'));
  });
});

// ─── T6: sentinel IO ─────────────────────────────────────────────────────────

describe('sentinel IO (writePluginSection / readMemoryIndex / removePluginSection)', () => {
  let tmp, memdir;
  const slug = 'claude-mem-lite';

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'memdir-sentinel-'));
    memdir = join(tmp, 'memory');
    mkdirSync(memdir, { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('creates MEMORY.md when absent and writes sentinel block', () => {
    const r = writePluginSection(memdir, { slug, version: 'v1', contentLine: '- [x](y.md) — demo' });
    expect(r.action).toBe('created');
    const body = readFileSync(join(memdir, 'MEMORY.md'), 'utf8');
    expect(body).toContain(`<!-- ${slug}:begin v1 -->`);
    expect(body).toContain('- [x](y.md) — demo');
    expect(body).toContain(`<!-- ${slug}:end -->`);
  });

  it('writes state sidecar alongside MEMORY.md', () => {
    writePluginSection(memdir, { slug, version: 'v1', contentLine: 'line' });
    expect(existsSync(join(memdir, '.plugin_claude_mem_lite_state.json'))).toBe(true);
  });

  it('is idempotent — second write with same inputs returns unchanged', () => {
    writePluginSection(memdir, { slug, version: 'v1', contentLine: 'line' });
    const before = readFileSync(join(memdir, 'MEMORY.md'), 'utf8');
    const r = writePluginSection(memdir, { slug, version: 'v1', contentLine: 'line' });
    expect(r.action).toBe('unchanged');
    expect(readFileSync(join(memdir, 'MEMORY.md'), 'utf8')).toBe(before);
  });

  // v3.40 defect class, twin missed: String.prototype.replace INTERPRETS `$&`, `$1`,
  // "$`" and `$'` in a STRING second argument. claudemd.mjs:163 was fixed to pass a
  // function; memdir.mjs's update path kept the string form. contentLine is
  // caller-supplied, so a `$&` in it would expand to the ENTIRE matched sentinel block,
  // duplicating it into MEMORY.md. Latent today (no production caller passes one), which
  // is exactly why it needs a test rather than a note.
  it('writes $-sequences in contentLine literally on the update path', () => {
    writePluginSection(memdir, { slug, version: 'v1', contentLine: 'plain' });
    writePluginSection(memdir, { slug, version: 'v2', contentLine: 'cost is $& and $1 and $`' });
    const body = readFileSync(join(memdir, 'MEMORY.md'), 'utf8');
    expect(body).toContain('cost is $& and $1 and $`');
    // The tell for expansion: the block's own begin marker appearing twice.
    expect(body.split(`<!-- ${slug}:begin`).length - 1).toBe(1);
  });

  it('upgrades v1 → v2 replacing the whole sentinel block', () => {
    writePluginSection(memdir, { slug, version: 'v1', contentLine: 'old' });
    const r = writePluginSection(memdir, { slug, version: 'v2', contentLine: 'new' });
    expect(r.action).toBe('updated');
    const body = readFileSync(join(memdir, 'MEMORY.md'), 'utf8');
    expect(body).toContain(`<!-- ${slug}:begin v2 -->`);
    expect(body).not.toContain(`<!-- ${slug}:begin v1 -->`);
    expect(body).toContain('new');
    expect(body).not.toContain('old');
  });

  it('throws UserEditedError when sentinel body was modified in place', () => {
    writePluginSection(memdir, { slug, version: 'v1', contentLine: 'original' });
    const path = join(memdir, 'MEMORY.md');
    writeFileSync(path, readFileSync(path, 'utf8').replace('original', 'I-hacked-this'));
    expect(() => writePluginSection(memdir, { slug, version: 'v1', contentLine: 'auto-update' })).toThrow(
      UserEditedError,
    );
  });

  it('force=true overrides UserEditedError', () => {
    writePluginSection(memdir, { slug, version: 'v1', contentLine: 'original' });
    const path = join(memdir, 'MEMORY.md');
    writeFileSync(path, readFileSync(path, 'utf8').replace('original', 'hand-edit'));
    const r = writePluginSection(memdir, {
      slug,
      version: 'v1',
      contentLine: 'auto-update',
      force: true,
    });
    expect(r.action).toBe('updated');
    const body = readFileSync(path, 'utf8');
    expect(body).toContain('auto-update');
    expect(body).not.toContain('hand-edit');
  });

  it('throws UserEditedError when sentinel exists but state file is missing', () => {
    writePluginSection(memdir, { slug, version: 'v1', contentLine: 'x' });
    rmSync(join(memdir, '.plugin_claude_mem_lite_state.json'));
    expect(() => writePluginSection(memdir, { slug, version: 'v1', contentLine: 'x' })).toThrow(
      UserEditedError,
    );
  });

  it('preserves user content outside the sentinel block', () => {
    const path = join(memdir, 'MEMORY.md');
    writeFileSync(path, '# User memory\n\n## 用户偏好\n- 中文条目\n');
    writePluginSection(memdir, { slug, version: 'v1', contentLine: 'line' });
    const body = readFileSync(path, 'utf8');
    expect(body).toContain('# User memory');
    expect(body).toContain('## 用户偏好');
    expect(body).toContain('- 中文条目');
    expect(body).toContain(`<!-- ${slug}:begin v1 -->`);
  });

  it('readMemoryIndex reports absent/present/lineCount/section', () => {
    // Absent
    const r0 = readMemoryIndex(memdir, slug);
    expect(r0.exists).toBe(false);
    expect(r0.section).toBeNull();

    writePluginSection(memdir, { slug, version: 'v1', contentLine: 'line' });
    const r1 = readMemoryIndex(memdir, slug);
    expect(r1.exists).toBe(true);
    expect(r1.section).toMatch(/claude-mem-lite:begin v1/);
    expect(r1.version).toBe('v1');
    expect(r1.lineCount).toBeGreaterThan(0);
  });

  it('removePluginSection removes the block and leaves user content alone', () => {
    const path = join(memdir, 'MEMORY.md');
    writeFileSync(path, '# User memory\n\n## 用户偏好\n- 中文条目\n');
    writePluginSection(memdir, { slug, version: 'v1', contentLine: 'line' });
    const r = removePluginSection(memdir, slug);
    expect(r.action).toBe('removed');
    const body = readFileSync(path, 'utf8');
    expect(body).not.toContain(slug);
    expect(body).toContain('# User memory');
    expect(body).toContain('- 中文条目');
  });

  it('removePluginSection cleans state sidecar', () => {
    writePluginSection(memdir, { slug, version: 'v1', contentLine: 'x' });
    const state = join(memdir, '.plugin_claude_mem_lite_state.json');
    expect(existsSync(state)).toBe(true);
    removePluginSection(memdir, slug);
    expect(existsSync(state)).toBe(false);
  });

  it('removePluginSection is a no-op when sentinel is absent', () => {
    const path = join(memdir, 'MEMORY.md');
    writeFileSync(path, '# preexisting\n');
    const r = removePluginSection(memdir, slug);
    expect(r.action).toBe('absent');
    expect(readFileSync(path, 'utf8')).toBe('# preexisting\n');
  });

  it('removePluginSection refuses to delete a sentinel block with no state sidecar (foreign content)', () => {
    // User pasted a sentinel-shaped block the plugin never wrote (no state file).
    // Symmetric with writePluginSection's foreign-content guard — must NOT delete it.
    const path = join(memdir, 'MEMORY.md');
    const userContent = `# Notes\n\nExample:\n<!-- ${slug}:begin v1 -->\n## user section\n- I wrote this myself\n<!-- ${slug}:end -->\n\n## keep me\n`;
    writeFileSync(path, userContent);
    const r = removePluginSection(memdir, slug);
    expect(r.action).toBe('skipped-foreign');
    expect(readFileSync(path, 'utf8')).toBe(userContent); // byte-identical, nothing removed
  });

  it('removePluginSection with force=true removes even a no-state (foreign) block', () => {
    const path = join(memdir, 'MEMORY.md');
    writeFileSync(path, `intro\n<!-- ${slug}:begin v1 -->\n## x\n- y\n<!-- ${slug}:end -->\n`);
    const r = removePluginSection(memdir, slug, { force: true });
    expect(r.action).toBe('removed');
    expect(readFileSync(path, 'utf8')).not.toContain(slug);
  });

  it('adopt→remove round-trip preserves leading blank lines and trailing-newline shape', () => {
    // The sentinel is appended at end-of-file, so removal must not touch the file's
    // leading whitespace. Pre-fix, an unconditional /^\s+/ strip deleted user-authored
    // leading blank lines on every unadopt.
    const path = join(memdir, 'MEMORY.md');
    const original = '\n\n# My Index\n- alpha\n';
    writeFileSync(path, original);
    writePluginSection(memdir, { slug, version: 'v1', contentLine: 'line' });
    const r = removePluginSection(memdir, slug);
    expect(r.action).toBe('removed');
    expect(readFileSync(path, 'utf8')).toBe(original); // byte-identical round-trip
  });

  it('throws BudgetExceededError when inserting into >180 line MEMORY.md', () => {
    const big = Array.from({ length: 200 }, (_, i) => `- line ${i}`).join('\n') + '\n';
    writeFileSync(join(memdir, 'MEMORY.md'), big);
    expect(() => writePluginSection(memdir, { slug, version: 'v1', contentLine: 'x' })).toThrow(
      BudgetExceededError,
    );
  });

  it('accepts MEMORY.md at exactly the 180-line boundary (v2.32.3: no off-by-one)', () => {
    // Pre-v2.32.3 bug: split('\n').length overcounted by 1 for files ending in
    // a newline, so a POSIX-correct 180-line file tripped BudgetExceeded.
    const content = Array.from({ length: 180 }, (_, i) => `- line ${i}`).join('\n') + '\n';
    writeFileSync(join(memdir, 'MEMORY.md'), content);
    expect(() => writePluginSection(memdir, { slug, version: 'v1', contentLine: 'x' })).not.toThrow();
  });

  it('rejects at exactly 181 lines (the real budget edge)', () => {
    const content = Array.from({ length: 181 }, (_, i) => `- line ${i}`).join('\n') + '\n';
    writeFileSync(join(memdir, 'MEMORY.md'), content);
    expect(() => writePluginSection(memdir, { slug, version: 'v1', contentLine: 'x' })).toThrow(
      BudgetExceededError,
    );
  });

  it('removePluginSection normalizes leading whitespace after removing the first sentinel', () => {
    // Two plugins coexist; remove plugin-A (first) → tail must not start with blank lines.
    writePluginSection(memdir, { slug: 'claude-mem-lite', version: 'v1', contentLine: 'A' });
    // Simulate a second plugin appending its own sentinel.
    const path = join(memdir, 'MEMORY.md');
    const tail = '\n\n<!-- other-plugin:begin v1 -->\n## 插件契约\nB\n<!-- other-plugin:end -->\n';
    writeFileSync(path, readFileSync(path, 'utf8') + tail);
    removePluginSection(memdir, 'claude-mem-lite');
    const body = readFileSync(path, 'utf8');
    expect(body.startsWith('\n')).toBe(false);
    expect(body.startsWith('<!-- other-plugin')).toBe(true);
  });

  it('budget does NOT block updates to an already-present sentinel', () => {
    // 1) initial write at normal size
    writePluginSection(memdir, { slug, version: 'v1', contentLine: 'initial' });
    // 2) balloon user content around our section past the budget
    const path = join(memdir, 'MEMORY.md');
    const prev = readFileSync(path, 'utf8');
    const filler = Array.from({ length: 200 }, (_, i) => `filler ${i}`).join('\n');
    writeFileSync(path, filler + '\n' + prev);
    // 3) update is still allowed (no new line growth)
    expect(() => writePluginSection(memdir, { slug, version: 'v1', contentLine: 'updated' })).not.toThrow();
    expect(readFileSync(path, 'utf8')).toContain('updated');
  });
});

// ─── T8: isAdopted ───────────────────────────────────────────────────────────

describe('isAdopted', () => {
  let tmp, memdir;
  const slug = 'claude-mem-lite';

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'memdir-adopt-'));
    memdir = join(tmp, 'memory');
    mkdirSync(memdir, { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('returns false when memdir is missing', () => {
    expect(isAdopted(join(tmp, 'nonexistent'), slug)).toBe(false);
  });

  it('returns false when MEMORY.md has no sentinel', () => {
    writeFileSync(join(memdir, 'MEMORY.md'), '# no sentinel here\n');
    expect(isAdopted(memdir, slug)).toBe(false);
  });

  it('returns true after writePluginSection', () => {
    writePluginSection(memdir, { slug, version: 'v1', contentLine: 'x' });
    expect(isAdopted(memdir, slug)).toBe(true);
  });

  it('still true after user edits body (sentinel still present)', () => {
    writePluginSection(memdir, { slug, version: 'v1', contentLine: 'original' });
    const path = join(memdir, 'MEMORY.md');
    writeFileSync(path, readFileSync(path, 'utf8').replace('original', 'edited'));
    expect(isAdopted(memdir, slug)).toBe(true);
  });

  it('returns false after removePluginSection', () => {
    writePluginSection(memdir, { slug, version: 'v1', contentLine: 'x' });
    removePluginSection(memdir, slug);
    expect(isAdopted(memdir, slug)).toBe(false);
  });
});

// ─── T7: plugin doc IO ───────────────────────────────────────────────────────

describe('plugin doc IO (writePluginDoc / removePluginDoc)', () => {
  let tmp, memdir;
  const slug = 'claude-mem-lite';

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'memdir-doc-'));
    memdir = join(tmp, 'memory');
    mkdirSync(memdir, { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('writes plugin_<slug_snake>.md with given body', () => {
    writePluginDoc(memdir, slug, '# detail\n\nbody content\n');
    const path = join(memdir, 'plugin_claude_mem_lite.md');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain('# detail');
  });

  it('creates memdir automatically when absent', () => {
    const newDir = join(tmp, 'fresh_memdir');
    writePluginDoc(newDir, slug, '# body');
    expect(existsSync(join(newDir, 'plugin_claude_mem_lite.md'))).toBe(true);
  });

  it('overwrites existing doc', () => {
    writePluginDoc(memdir, slug, '# v1');
    writePluginDoc(memdir, slug, '# v2');
    expect(readFileSync(join(memdir, 'plugin_claude_mem_lite.md'), 'utf8')).toContain('# v2');
  });

  it('removePluginDoc deletes the file', () => {
    writePluginDoc(memdir, slug, 'x');
    const path = join(memdir, 'plugin_claude_mem_lite.md');
    removePluginDoc(memdir, slug);
    expect(existsSync(path)).toBe(false);
  });

  it('removePluginDoc is a no-op when absent', () => {
    expect(() => removePluginDoc(memdir, slug)).not.toThrow();
  });
});

// ─── P2: auditMemdir — body-structure compliance scan ────────────────────────
// CC's CLAUDE.md memory contract requires feedback_*.md and project_*.md
// to carry **Why:** + **How to apply:** lines. user_*.md and reference_*.md
// have no body-structure requirement and must be excluded from the audit.
// MEMORY.md (the index) is also excluded.

describe('auditMemdir', () => {
  let tmp, memdir;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'memdir-audit-'));
    memdir = join(tmp, 'memory');
    mkdirSync(memdir, { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const FRONT = ['---', 'name: Foo', 'description: bar', 'type: feedback', '---', ''].join('\n');

  function write(name, body) {
    writeFileSync(join(memdir, name), FRONT + body);
  }

  it('returns empty result when memdir does not exist', () => {
    const fake = join(tmp, 'does-not-exist');
    const r = auditMemdir(fake);
    expect(r.total).toBe(0);
    expect(r.compliant).toEqual([]);
    expect(r.missingWhy).toEqual([]);
    expect(r.missingHowToApply).toEqual([]);
    expect(r.missingBoth).toEqual([]);
  });

  it('classifies a fully-compliant feedback file as compliant', () => {
    write(
      'feedback_good.md',
      'The rule itself.\n\n**Why:** because of past incident X.\n\n**How to apply:** when editing module Y.\n',
    );
    const r = auditMemdir(memdir);
    expect(r.compliant).toEqual(['feedback_good.md']);
    expect(r.missingWhy).toEqual([]);
    expect(r.missingHowToApply).toEqual([]);
    expect(r.missingBoth).toEqual([]);
    expect(r.total).toBe(1);
  });

  it('classifies a project file with both fields as compliant', () => {
    write(
      'project_initiative.md',
      'Decision text.\n**Why:** legal compliance.\n**How to apply:** scope decisions favor compliance.\n',
    );
    const r = auditMemdir(memdir);
    expect(r.compliant).toEqual(['project_initiative.md']);
  });

  it('flags missing **Why:** correctly', () => {
    write('feedback_no_why.md', 'A rule.\n**How to apply:** in CI hooks only.\n');
    const r = auditMemdir(memdir);
    expect(r.missingWhy).toEqual(['feedback_no_why.md']);
    expect(r.missingHowToApply).toEqual([]);
    expect(r.missingBoth).toEqual([]);
  });

  it('flags missing **How to apply:** correctly', () => {
    write('project_no_how.md', 'A fact.\n**Why:** stakeholder ask.\n');
    const r = auditMemdir(memdir);
    expect(r.missingHowToApply).toEqual(['project_no_how.md']);
    expect(r.missingWhy).toEqual([]);
    expect(r.missingBoth).toEqual([]);
  });

  it('flags files missing both fields under missingBoth (not under either single-miss bucket)', () => {
    write('feedback_orphan.md', 'Just a stray sentence with no structure.\n');
    const r = auditMemdir(memdir);
    expect(r.missingBoth).toEqual(['feedback_orphan.md']);
    expect(r.missingWhy).toEqual([]);
    expect(r.missingHowToApply).toEqual([]);
  });

  it('skips MEMORY.md (the index, not a memory entry)', () => {
    writeFileSync(join(memdir, 'MEMORY.md'), '# Index\n- [Foo](feedback_x.md) — note\n');
    const r = auditMemdir(memdir);
    expect(r.total).toBe(0);
  });

  it('skips user_*.md and reference_*.md (no Why/How requirement for these types)', () => {
    write('user_role.md', 'no why or how needed here\n');
    write('reference_url.md', 'pointer to external system\n');
    const r = auditMemdir(memdir);
    expect(r.total).toBe(0);
    expect(r.missingBoth).toEqual([]);
  });

  it('skips state sidecars and dotfiles', () => {
    writeFileSync(join(memdir, '.plugin_claude_mem_lite_state.json'), '{}');
    writeFileSync(join(memdir, '.DS_Store'), '');
    const r = auditMemdir(memdir);
    expect(r.total).toBe(0);
  });

  it('skips non-markdown files', () => {
    writeFileSync(join(memdir, 'feedback_bad.txt'), 'not a markdown file');
    const r = auditMemdir(memdir);
    expect(r.total).toBe(0);
  });

  it('classifies a mixed memdir into all four buckets in sorted order', () => {
    write('feedback_b_good.md', '**Why:** reason\n**How to apply:** rule\n');
    write('feedback_a_no_why.md', '**How to apply:** rule\n');
    write('project_c_no_how.md', '**Why:** reason\n');
    write('project_d_orphan.md', 'orphan\n');
    write('feedback_e_orphan.md', 'also orphan\n');
    const r = auditMemdir(memdir);
    expect(r.total).toBe(5);
    expect(r.compliant).toEqual(['feedback_b_good.md']);
    expect(r.missingWhy).toEqual(['feedback_a_no_why.md']);
    expect(r.missingHowToApply).toEqual(['project_c_no_how.md']);
    // Both missing — sorted alphabetically.
    expect(r.missingBoth).toEqual(['feedback_e_orphan.md', 'project_d_orphan.md']);
  });

  it('tolerates trailing whitespace and bold-marker variants in the field labels', () => {
    write('feedback_loose.md', '**Why:**   reason here\n**How to apply:** rule\n');
    const r = auditMemdir(memdir);
    expect(r.compliant).toEqual(['feedback_loose.md']);
  });

  it('does NOT count fields that appear only inside frontmatter', () => {
    // If a file only has e.g. `description: **Why:** foo` in frontmatter
    // (no body usage), that is NOT compliant — body-structure means body.
    writeFileSync(
      join(memdir, 'feedback_frontmatter_only.md'),
      [
        '---',
        'name: F',
        'description: "**Why:** dummy"',
        'type: feedback',
        '---',
        '',
        'Body without the structure.\n',
      ].join('\n'),
    );
    const r = auditMemdir(memdir);
    expect(r.missingBoth).toEqual(['feedback_frontmatter_only.md']);
  });

  // ─── kebab-case files: type comes from frontmatter (2026-07-24 audit P2) ────
  // The current CC harness writes memories as kebab-case names (ship-runbook.md)
  // with the type in frontmatter `metadata.type:` — the filename-prefix
  // convention no longer applies. Rule: known filename prefixes win (legacy);
  // otherwise frontmatter type ∈ {feedback, project} selects the file for audit.

  function writeKebab(name, type, body) {
    writeFileSync(
      join(memdir, name),
      [
        '---',
        `name: ${name.replace(/\.md$/, '')}`,
        'description: "d"',
        'metadata: ',
        '  node_type: memory',
        `  type: ${type}`,
        '---',
        '',
        body,
      ].join('\n'),
    );
  }

  it('audits a kebab-case file whose metadata.type is project', () => {
    writeKebab(
      'ship-runbook.md',
      'project',
      'Release flow.\n**Why:** repeatable releases.\n**How to apply:** follow the 5-file sync.\n',
    );
    const r = auditMemdir(memdir);
    expect(r.compliant).toEqual(['ship-runbook.md']);
    expect(r.total).toBe(1);
  });

  it('flags a kebab-case project file missing both fields', () => {
    writeKebab('npm12-binding.md', 'project', 'Prose without structure lines.\n');
    const r = auditMemdir(memdir);
    expect(r.missingBoth).toEqual(['npm12-binding.md']);
  });

  it('audits a kebab-case file with top-level frontmatter type: feedback', () => {
    writeFileSync(
      join(memdir, 'cite-lessons.md'),
      [
        '---',
        'name: cite-lessons',
        'type: feedback',
        '---',
        '',
        '**Why:** decay.\n**How to apply:** cite #NN.\n',
      ].join('\n'),
    );
    const r = auditMemdir(memdir);
    expect(r.compliant).toEqual(['cite-lessons.md']);
  });

  it('skips kebab-case files typed user/reference and files with no type', () => {
    writeKebab('who-i-am.md', 'user', 'role prose\n');
    writeKebab('dashboard-link.md', 'reference', 'url pointer\n');
    writeFileSync(join(memdir, 'untyped-notes.md'), 'no frontmatter at all\n');
    const r = auditMemdir(memdir);
    expect(r.total).toBe(0);
  });

  it('node_type: memory in frontmatter is not mistaken for the type field', () => {
    // regression guard: the `type:` extractor must not match `node_type:`.
    writeFileSync(
      join(memdir, 'only-nodetype.md'),
      ['---', 'name: x', 'metadata: ', '  node_type: project', '---', '', 'body\n'].join('\n'),
    );
    const r = auditMemdir(memdir);
    expect(r.total).toBe(0);
  });
});
