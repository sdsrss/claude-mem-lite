// v3.13 CLAUDE.md-steering: unit tests for claudemd.mjs project-tree primitives.
// Each test runs in a mkdtemp cwd with $HOME repointed so memdirPath()'s
// ~/.claude resolves inside the sandbox (migration tests touch it).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  writeManaged,
  removeManaged,
  isAdopted,
  needsRefresh,
  readBlock,
  migrateLegacyMemoryDir,
  hasLegacyMemdirSentinel,
  claudeMdPath,
  detailDocPath,
} from '../claudemd.mjs';
import { memdirPath, writePluginSection, writePluginDoc, isAdopted as memdirIsAdopted } from '../memdir.mjs';

const SLUG = 'claude-mem-lite';
const BLOCK = '## test block\n\nline one\nline two';
const DOC = '# detail\n\nbody';
const V = 'v2';
const argsOf = () => ({ slug: SLUG, version: V, block: BLOCK, doc: DOC });

describe('claudemd primitives', () => {
  let tmpHome, cwd, origHome;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'claudemd-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    cwd = join(tmpHome, 'proj');
    mkdirSync(cwd, { recursive: true });
  });
  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('writeManaged creates CLAUDE.md + .claude detail doc with marker', () => {
    const r = writeManaged(cwd, argsOf(cwd));
    expect(r.action).toBe('created');
    const body = readFileSync(claudeMdPath(cwd), 'utf8');
    expect(body).toContain(`<!-- ${SLUG}:begin ${V} -->`);
    expect(body).toContain('line one');
    expect(body).toContain(`<!-- ${SLUG}:end -->`);
    expect(readFileSync(detailDocPath(cwd, SLUG), 'utf8')).toBe(`<!-- managed-by: ${SLUG} -->\n${DOC}`);
    expect(isAdopted(cwd, SLUG)).toBe(true);
  });

  it('writeManaged is idempotent on user-visible files', () => {
    writeManaged(cwd, argsOf(cwd));
    const cm = readFileSync(claudeMdPath(cwd), 'utf8');
    const doc = readFileSync(detailDocPath(cwd, SLUG), 'utf8');
    const r = writeManaged(cwd, argsOf(cwd));
    expect(r.action).toBe('unchanged');
    expect(readFileSync(claudeMdPath(cwd), 'utf8')).toBe(cm);
    expect(readFileSync(detailDocPath(cwd, SLUG), 'utf8')).toBe(doc);
  });

  it('preserves user prose outside the sentinel', () => {
    writeFileSync(claudeMdPath(cwd), '# Title\n\nuser content\n');
    writeManaged(cwd, argsOf(cwd));
    const body = readFileSync(claudeMdPath(cwd), 'utf8');
    expect(body).toContain('# Title');
    expect(body).toContain('user content');
    expect(body).toContain(`<!-- ${SLUG}:begin`);
  });

  it('needsRefresh: false when in sync, true on version / block / doc drift', () => {
    writeManaged(cwd, argsOf(cwd));
    expect(needsRefresh(cwd, argsOf(cwd))).toBe(false);
    expect(needsRefresh(cwd, { slug: SLUG, version: 'v3', block: BLOCK, doc: DOC })).toBe(true);
    expect(needsRefresh(cwd, { slug: SLUG, version: V, block: BLOCK + ' x', doc: DOC })).toBe(true);
    expect(needsRefresh(cwd, { slug: SLUG, version: V, block: BLOCK, doc: DOC + ' x' })).toBe(true);
  });

  it('needsRefresh: true when not yet adopted', () => {
    expect(needsRefresh(cwd, argsOf(cwd))).toBe(true);
  });

  it('updates the block in place on a version bump (readBlock reflects it)', () => {
    writeManaged(cwd, argsOf(cwd));
    const r = writeManaged(cwd, { slug: SLUG, version: 'v3', block: BLOCK, doc: DOC });
    expect(r.action).toBe('updated');
    expect(readBlock(cwd, SLUG).version).toBe('v3');
  });

  it('removeManaged strips the block, deletes the doc, keeps prose', () => {
    writeFileSync(claudeMdPath(cwd), '# Title\n\nuser content\n');
    writeManaged(cwd, argsOf(cwd));
    const r = removeManaged(cwd, SLUG);
    expect(r.action).toBe('removed');
    const body = readFileSync(claudeMdPath(cwd), 'utf8');
    expect(body).toContain('user content');
    expect(body).not.toContain(`${SLUG}:begin`);
    expect(existsSync(detailDocPath(cwd, SLUG))).toBe(false);
    expect(isAdopted(cwd, SLUG)).toBe(false);
  });

  it('removeManaged on a never-adopted project is absent (no throw)', () => {
    expect(removeManaged(cwd, SLUG).action).toBe('absent');
  });

  it('removeManaged deletes a CLAUDE.md that adopt created (block was the whole file)', () => {
    // No pre-existing CLAUDE.md → writeManaged creates one holding only the block.
    // unadopt must leave no trace: remove the file, not write a 0-byte CLAUDE.md.
    writeManaged(cwd, argsOf(cwd));
    expect(existsSync(claudeMdPath(cwd))).toBe(true);
    expect(removeManaged(cwd, SLUG).action).toBe('removed');
    expect(existsSync(claudeMdPath(cwd))).toBe(false);
  });
});

describe('migrateLegacyMemoryDir', () => {
  let tmpHome, cwd, origHome;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'claudemd-mig-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    cwd = join(tmpHome, 'proj');
    mkdirSync(cwd, { recursive: true });
  });
  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('strips the legacy memdir sentinel + detail doc', () => {
    const md = memdirPath(cwd);
    mkdirSync(md, { recursive: true });
    writePluginSection(md, { slug: SLUG, version: 'v1', contentLine: '- legacy' });
    writePluginDoc(md, SLUG, '# legacy doc');
    expect(hasLegacyMemdirSentinel(cwd, SLUG)).toBe(true);
    const r = migrateLegacyMemoryDir(cwd, SLUG);
    expect(r.action).toBe('removed');
    expect(memdirIsAdopted(md, SLUG)).toBe(false);
    expect(existsSync(join(md, 'plugin_claude_mem_lite.md'))).toBe(false);
  });

  it('is a no-op when there is no legacy residue', () => {
    expect(migrateLegacyMemoryDir(cwd, SLUG).action).toBe('absent');
  });

  it('leaves an adjacent code-graph-mcp block + user prose intact', () => {
    const md = memdirPath(cwd);
    mkdirSync(md, { recursive: true });
    writeFileSync(join(md, 'MEMORY.md'), '## user\n- keep me\n');
    writePluginSection(md, { slug: SLUG, version: 'v1', contentLine: '- legacy' });
    writeFileSync(
      join(md, 'MEMORY.md'),
      readFileSync(join(md, 'MEMORY.md'), 'utf8') +
        '<!-- code-graph-mcp:begin v1 -->\n- cg\n<!-- code-graph-mcp:end -->\n',
    );
    migrateLegacyMemoryDir(cwd, SLUG);
    const mem = readFileSync(join(md, 'MEMORY.md'), 'utf8');
    expect(mem).not.toContain(`${SLUG}:begin`);
    expect(mem).toContain('code-graph-mcp:begin');
    expect(mem).toContain('- keep me');
  });
});

// ─── Review hardening: CRLF (C1) + duplicate blocks (H2) + foreign migrate (M3) ──
describe('claudemd robustness (review C1/H2/M3)', () => {
  let tmpHome, cwd, origHome;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'claudemd-rb-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    cwd = join(tmpHome, 'proj');
    mkdirSync(cwd, { recursive: true });
  });
  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  const count = (s) => (s.match(new RegExp(`${SLUG}:begin`, 'g')) || []).length;

  it('C1: a CRLF-resaved block is matched in place, never duplicated', () => {
    writeManaged(cwd, argsOf());
    // simulate an editor re-saving CLAUDE.md with Windows CRLF endings
    writeFileSync(claudeMdPath(cwd), readFileSync(claudeMdPath(cwd), 'utf8').replace(/\n/g, '\r\n'));
    expect(isAdopted(cwd, SLUG)).toBe(true);
    expect(needsRefresh(cwd, argsOf())).toBe(false); // no spurious drift
    writeManaged(cwd, argsOf()); // must replace, not append
    expect(count(readFileSync(claudeMdPath(cwd), 'utf8'))).toBe(1);
  });

  it('H2: writeManaged collapses pre-existing duplicate blocks to one', () => {
    writeManaged(cwd, argsOf());
    const one = readFileSync(claudeMdPath(cwd), 'utf8');
    writeFileSync(claudeMdPath(cwd), one + '\n' + one); // inject a duplicate
    writeManaged(cwd, argsOf());
    expect(count(readFileSync(claudeMdPath(cwd), 'utf8'))).toBe(1);
  });

  it('H2: removeManaged strips ALL same-slug blocks, keeps user prose', () => {
    writeManaged(cwd, argsOf());
    const one = readFileSync(claudeMdPath(cwd), 'utf8');
    writeFileSync(claudeMdPath(cwd), '# top\n\n' + one + '\n' + one);
    expect(removeManaged(cwd, SLUG).action).toBe('removed');
    const body = readFileSync(claudeMdPath(cwd), 'utf8');
    expect(body).not.toContain(`${SLUG}:begin`);
    expect(body).toContain('# top');
  });

  it('M3: migration keeps the legacy detail doc when the sentinel is foreign (no state sidecar)', () => {
    const md = memdirPath(cwd);
    mkdirSync(md, { recursive: true });
    // sentinel present but NO state sidecar → not provably plugin-written
    writeFileSync(
      join(md, 'MEMORY.md'),
      '<!-- claude-mem-lite:begin v1 -->\n## 插件契约\n- x\n<!-- claude-mem-lite:end -->\n',
    );
    writeFileSync(join(md, 'plugin_claude_mem_lite.md'), '# looks user-pasted');
    const r = migrateLegacyMemoryDir(cwd, SLUG); // force=false
    expect(r.action).toBe('skipped-foreign');
    expect(existsSync(join(md, 'plugin_claude_mem_lite.md'))).toBe(true); // NOT deleted
  });
});
