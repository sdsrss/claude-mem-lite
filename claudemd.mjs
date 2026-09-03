// CLAUDE.md-steering plan (v3.13): claudemd.mjs — primitives for the
// project-tree managed block at <cwd>/CLAUDE.md plus an on-demand detail doc
// at <cwd>/.claude/plugin_<slug>.md.
//
// Why here and not memdir.mjs: Claude Code loads the project CLAUDE.md and the
// memory-dir MEMORY.md at EQUAL weight, so steering belongs in CLAUDE.md (the
// canonical home for project instructions) — seeding MEMORY.md just pollutes an
// index meant for the user's own memories. This module mirrors the design
// shipped by the sibling code-graph-mcp plugin (claude-plugin/scripts/adopt.js)
// and the oh-my-claudecode versioned `<!-- :begin vN -->` managed-block pattern.
//
// The managed block is plugin-owned: it auto-refreshes when the shipped content
// drifts (version bump or template change), UNLESS CLAUDE_MEM_NO_TEMPLATE_REFRESH=1.
// User prose OUTSIDE the slug-scoped sentinel is never touched. The slug scope is
// what keeps this independent from code-graph-mcp's own block in the same file.
//
// See docs/CLAUDE-MD-STEERING-PLAN.md for rationale + migration.

import { readFileSync, existsSync, unlinkSync, mkdirSync, rmdirSync, readdirSync } from 'fs';
import { atomicWriteFileSync as atomicWrite } from './lib/atomic-write.mjs';
import { join } from 'path';
import { createHash } from 'crypto';
import { memdirPath, removePluginSection, removePluginDoc, isAdopted as memdirIsAdopted } from './memdir.mjs';

// ─── Path helpers ────────────────────────────────────────────────────────────

function slugSnake(slug) { return String(slug).replace(/[^a-zA-Z0-9]/g, '_'); }

export function claudeMdPath(cwd) { return join(cwd, 'CLAUDE.md'); }
function dotClaudeDir(cwd) { return join(cwd, '.claude'); }
export function detailDocPath(cwd, slug) { return join(dotClaudeDir(cwd), `plugin_${slugSnake(slug)}.md`); }
function stateFilePath(cwd, slug) { return join(dotClaudeDir(cwd), `.plugin_${slugSnake(slug)}_state.json`); }

// First line of the detail doc — an invisible (in rendered markdown) marker that
// lets us distinguish our generated copy from a user's same-named file.
function managedByMarker(slug) { return `<!-- managed-by: ${slug} -->`; }

// ─── Sentinel rendering & parsing ────────────────────────────────────────────

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Slug-scoped so stripping our block never disturbs another plugin's block
// (e.g. code-graph-mcp's `<!-- code-graph-mcp:begin -->`) sitting in the same
// CLAUDE.md. Matches any version vN+ for migration/idempotency. The separators
// are `\r?\n` (not bare `\n`) so a CLAUDE.md re-saved with Windows CRLF endings
// still matches — otherwise the block read as "absent" and a fresh LF copy got
// appended every SessionStart, growing the file without bound (review C1/H2).
function blockBody(esc) { return `<!-- ${esc}:begin (v\\d+) -->\\r?\\n([\\s\\S]*?)\\r?\\n<!-- ${esc}:end -->`; }
function blockRegex(slug) { return new RegExp(blockBody(escapeRe(slug))); }
function blockRegexG(slug) { return new RegExp(blockBody(escapeRe(slug)), 'g'); }

function renderBlock(slug, version, body) {
  return `<!-- ${slug}:begin ${version} -->\n${body}\n<!-- ${slug}:end -->`;
}

function sha256(s) { return createHash('sha256').update(s).digest('hex'); }

// `atomicWriteFileSync`, not a local temp+rename (audit 2026-09-02 P0-5). The local twin
// renamed onto the PATH; when a project's CLAUDE.md is a symlink into a dotfiles repo
// (chezmoi/stow/yadm) or a monorepo's shared root, that REPLACES the link with a regular
// file — silently, on the first SessionStart, with no user-visible signal beyond a git
// typechange. The shared writer lstats first and writes THROUGH to the real target. It has
// been in this repo, shipped and used by install.mjs for ~/.claude/settings.json, since the
// day that failure mode was first written down in its own docblock.

function writeState(cwd, slug, state) {
  const dir = dotClaudeDir(cwd);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  atomicWrite(stateFilePath(cwd, slug), JSON.stringify(state, null, 2) + '\n');
}

function clearState(cwd, slug) {
  const p = stateFilePath(cwd, slug);
  if (existsSync(p)) try { unlinkSync(p); } catch { /* best-effort */ }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Parse <cwd>/CLAUDE.md for our slug-scoped managed block.
 * @returns {{ exists: boolean, version: string|null, body: string|null, raw: string }}
 */
export function readBlock(cwd, slug) {
  const p = claudeMdPath(cwd);
  if (!existsSync(p)) return { exists: false, version: null, body: null, raw: '' };
  const raw = readFileSync(p, 'utf8');
  const m = raw.match(blockRegex(slug));
  if (!m) return { exists: true, version: null, body: null, raw };
  // Normalize CRLF in the captured body so drift comparison (needsRefresh) is
  // line-ending-agnostic — a CRLF-saved file matching the shipped LF content
  // must NOT be seen as drifted and rewritten every session.
  return { exists: true, version: m[1], body: m[2].replace(/\r\n/g, '\n'), raw };
}

/**
 * Adopted under the new scheme = managed block present in CLAUDE.md AND the
 * detail doc exists. Both must hold so a half-written state still self-heals.
 */
export function isAdopted(cwd, slug) {
  const blk = readBlock(cwd, slug);
  return blk.body !== null && existsSync(detailDocPath(cwd, slug));
}

/**
 * Any trace of adoption that unadopt should clean: managed block OR detail doc
 * OR state sidecar. Deliberately weaker than isAdopted (whose AND lets a
 * half-written adopt self-heal on the next SessionStart): the unadopt sweep
 * gated on isAdopted skipped partial residue forever — e.g. a user deleted the
 * detail doc but the CLAUDE.md block remained, and `unadopt --all` never
 * removed it. removeManaged cleans all three pieces, so sweep on any of them.
 */
export function hasResidue(cwd, slug) {
  return readBlock(cwd, slug).body !== null
    || existsSync(detailDocPath(cwd, slug))
    || existsSync(stateFilePath(cwd, slug));
}

/**
 * Whether the installed block/doc has drifted from the shipped content — i.e.
 * a version bump or a template edit means we should refresh. Returns true when
 * the block is missing, the version differs, the block body differs, or the
 * detail doc is missing / differs. The block is plugin-managed: drift is
 * overwritten on refresh (opt out with CLAUDE_MEM_NO_TEMPLATE_REFRESH=1 at the
 * caller). User content lives OUTSIDE the sentinel and is never compared.
 */
export function needsRefresh(cwd, { slug, version, block, doc }) {
  const blk = readBlock(cwd, slug);
  if (blk.body === null) return true;
  if (blk.version !== version) return true;
  if (blk.body !== block) return true;
  const dp = detailDocPath(cwd, slug);
  if (!existsSync(dp)) return true;
  let cur;
  try { cur = readFileSync(dp, 'utf8'); } catch { return true; }
  return cur !== `${managedByMarker(slug)}\n${doc}`;
}

/**
 * Write (insert-or-replace) the managed block in CLAUDE.md and the detail doc
 * under .claude/, plus a state sidecar. Idempotent on the user-visible files:
 * re-running with identical inputs leaves CLAUDE.md and the detail doc byte-for-
 * byte unchanged (only the state sidecar's writtenAt updates).
 *
 * CLAUDE.md is created if absent. Only our slug-scoped region is rewritten;
 * everything else in the file is preserved verbatim.
 *
 * @returns {{action: 'created'|'updated'|'unchanged'}} (block disposition)
 */
export function writeManaged(cwd, { slug, version, block, doc }) {
  const p = claudeMdPath(cwd);
  const raw = existsSync(p) ? readFileSync(p, 'utf8') : '';
  const section = renderBlock(slug, version, block);
  const m = raw.match(blockRegex(slug));

  let next, action;
  if (!m) {
    if (raw.length === 0) next = section + '\n';
    else if (raw.endsWith('\n\n')) next = raw + section + '\n';
    else if (raw.endsWith('\n')) next = raw + '\n' + section + '\n';
    else next = raw + '\n\n' + section + '\n';
    action = 'created';
  } else {
    // Function replacer (not a string): a `$`-sequence in `section` (a future template with
    // a shell example / regex / `$1`) would otherwise be interpreted as a replacement
    // back-reference and corrupt the block on every SessionStart refresh. Matches line 153.
    next = raw.replace(m[0], () => section);
    action = next !== raw ? 'updated' : 'unchanged';
  }
  // H2: collapse any DUPLICATE same-slug blocks (keep the first, drop the rest).
  // Defends against a CRLF-orphaned copy a pre-fix build may have appended, or a
  // user paste — otherwise the extras would be invisible to refresh/unadopt.
  let seen = 0;
  const deduped = next.replace(blockRegexG(slug), (whole) => (seen++ === 0 ? whole : ''));
  if (deduped !== next) {
    next = deduped.replace(/\n{3,}/g, '\n\n');
    if (action === 'unchanged') action = 'updated';
  }
  if (next !== raw) atomicWrite(p, next);

  // Detail doc (marker on first line so unadopt/refresh can tell it apart from a
  // user's same-named file).
  const docContent = `${managedByMarker(slug)}\n${doc}`;
  const dp = detailDocPath(cwd, slug);
  const dir = dotClaudeDir(cwd);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const existingDoc = existsSync(dp) ? readFileSync(dp, 'utf8') : null;
  if (existingDoc !== docContent) atomicWrite(dp, docContent);

  writeState(cwd, slug, {
    version,
    blockHash: sha256(block),
    docHash: sha256(doc),
    writtenAt: new Date().toISOString(),
  });
  return { action };
}

/**
 * Remove our managed block from CLAUDE.md (preserving all other content) and
 * delete the detail doc + state sidecar. Best-effort removes an emptied
 * .claude/ directory.
 * @returns {{action: 'removed'|'absent'}}
 */
export function removeManaged(cwd, slug) {
  const p = claudeMdPath(cwd);
  let action = 'absent';
  if (existsSync(p)) {
    let raw = readFileSync(p, 'utf8');
    // H2: loop so ALL same-slug blocks are removed, not just the first (a
    // duplicate/CRLF-orphaned copy must not survive unadopt).
    let m;
    while ((m = raw.match(blockRegex(slug)))) {
      const blockAtStart = m.index === 0;
      let start = m.index;
      let end = m.index + m[0].length;
      if (raw[end] === '\n') end++;
      if (start > 0 && raw.slice(0, start).endsWith('\n\n')) start--;
      raw = raw.slice(0, start) + raw.slice(end);
      raw = raw.replace(/\n{3,}/g, '\n\n');
      if (blockAtStart) raw = raw.replace(/^\s+/, '');
      action = 'removed';
    }
    if (action === 'removed') {
      // When the managed block was the ENTIRE file (adopt created CLAUDE.md
      // because none existed), removing it leaves nothing but whitespace.
      // Delete the now-empty file rather than writing a 0-byte CLAUDE.md, so
      // unadopt fully restores the pre-adopt state — mirrors the emptied-.claude/
      // cleanup below ("unadopt leaves no trace").
      if (raw.trim() === '') {
        try { unlinkSync(p); } catch { atomicWrite(p, raw); }
      } else {
        atomicWrite(p, raw);
      }
    }
  }
  const dp = detailDocPath(cwd, slug);
  if (existsSync(dp)) try { unlinkSync(dp); } catch { /* best-effort */ }
  clearState(cwd, slug);
  // Drop an emptied .claude/ so unadopt leaves no trace (skips if it holds
  // anything else — e.g. settings.local.json).
  try {
    const dir = dotClaudeDir(cwd);
    if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
  } catch { /* best-effort */ }
  return { action };
}

// ─── Legacy migration ────────────────────────────────────────────────────────

/**
 * One-time (idempotent) cleanup of the pre-v3.13 scheme: strip the slug-scoped
 * sentinel from the project's memory-dir MEMORY.md and delete the memory-dir
 * detail doc + state sidecar. Slug-scoped, so an adjacent code-graph-mcp block
 * and all user prose survive byte-intact. Respects the foreign-content guard
 * (a sentinel with no state sidecar is left in place) unless force=true.
 *
 * Absent legacy artifacts → harmless no-op, so this is safe to call every
 * SessionStart.
 *
 * @returns {{action: 'removed'|'absent'|'skipped-foreign'}}
 */
export function migrateLegacyMemoryDir(cwd, slug, { force = false } = {}) {
  const memdir = memdirPath(cwd);
  const r = removePluginSection(memdir, slug, { force });
  // M3: only delete the legacy detail doc when we actually removed OUR sentinel.
  // On 'skipped-foreign' the sentinel is left in place (not provably plugin-
  // written), so deleting its companion doc would leave a dangling pointer.
  if (r.action === 'removed') removePluginDoc(memdir, slug);
  return r;
}

/** True if the legacy memory-dir sentinel still exists for this project. */
export function hasLegacyMemdirSentinel(cwd, slug) {
  return memdirIsAdopted(memdirPath(cwd), slug);
}
