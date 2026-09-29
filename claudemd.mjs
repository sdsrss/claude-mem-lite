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

import { readFileSync, existsSync, unlinkSync, mkdirSync, rmdirSync, readdirSync, lstatSync } from 'fs';
import { atomicWriteFileSync as atomicWrite } from './lib/atomic-write.mjs';
import { join, basename } from 'path';
import { createHash } from 'crypto';
import { memdirPath, removePluginSection, removePluginDoc, isAdopted as memdirIsAdopted } from './memdir.mjs';

// ─── Path helpers ────────────────────────────────────────────────────────────

function slugSnake(slug) {
  return String(slug).replace(/[^a-zA-Z0-9]/g, '_');
}

export function claudeMdPath(cwd) {
  return join(cwd, 'CLAUDE.md');
}
function dotClaudeDir(cwd) {
  return join(cwd, '.claude');
}
export function detailDocPath(cwd, slug) {
  return join(dotClaudeDir(cwd), `plugin_${slugSnake(slug)}.md`);
}
function stateFilePath(cwd, slug) {
  return join(dotClaudeDir(cwd), `.plugin_${slugSnake(slug)}_state.json`);
}

// First line of the detail doc — an invisible (in rendered markdown) marker that
// lets us distinguish our generated copy from a user's same-named file.
function managedByMarker(slug) {
  return `<!-- managed-by: ${slug} -->`;
}

// ─── Sentinel rendering & parsing ────────────────────────────────────────────

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Slug-scoped so stripping our block never disturbs another plugin's block
// (e.g. code-graph-mcp's `<!-- code-graph-mcp:begin -->`) sitting in the same
// CLAUDE.md. Matches any version vN+ for migration/idempotency. The separators
// are `\r?\n` (not bare `\n`) so a CLAUDE.md re-saved with Windows CRLF endings
// still matches — otherwise the block read as "absent" and a fresh LF copy got
// appended every SessionStart, growing the file without bound (review C1/H2).
// The body may not contain ANOTHER sentinel of the same slug. `[\s\S]*?` could, and that is
// not a tidiness point — it is how a match stopped being one block. Drop the `:end` line by
// hand (a merge resolution, an editor, another tool) and the next adopt appends a second
// block below whatever the user has written since; the adopt after THAT matched from the
// orphaned begin, lazily, to the only `:end` in the file — which now sits past the user's
// text and past the second begin — so `raw.replace(m[0], section)` deleted all of it.
// Measured 2026-09-13: a "## Deployment runbook" section appended after adoption was gone
// after two further adopts, silently, with both runs reporting success.
//
// The tempered token below cannot span a sentinel, so the engine backtracks to the
// WELL-FORMED pair and the orphan is simply left alone — which is the right answer for a
// file we do not own: where the orphaned body ends is genuinely unknowable, so removeManaged
// reports it (action 'partial') rather than guessing a span to delete.
//
// Safe by construction for legitimate blocks: the shipped body carries the slug twice and
// never as a sentinel (measured: 1304 bytes — 1296 UTF-16 units, the body has em dashes —
// with zero `:begin` / `:end` occurrences), and the
// separators stay `\r?\n` for the CRLF reason below.
function blockBody(esc) {
  const sentinel = `<!-- ${esc}:(?:begin|end)`;
  return `<!-- ${esc}:begin (v\\d+) -->\\r?\\n((?:(?!${sentinel})[\\s\\S])*?)\\r?\\n<!-- ${esc}:end -->`;
}

// Any sentinel LINE of our slug, paired or not. The pair regex above is deliberately blind to
// an unpaired one; this is what lets residue reporting see what it cannot safely remove.
function sentinelLineRegexG(slug) {
  return new RegExp(`<!-- ${escapeRe(slug)}:(?:begin|end)\\b[^>]*-->`, 'g');
}

/**
 * Sentinel lines of this slug left in `raw` that no well-formed block accounts for.
 * Zero on a healthy file (every sentinel belongs to a matched pair) and on a clean one.
 * @param {string} raw
 * @param {string} slug
 * @returns {number}
 */
function orphanSentinelCount(raw, slug) {
  const total = (raw.match(sentinelLineRegexG(slug)) || []).length;
  let paired = 0;
  raw.replace(blockRegexG(slug), (whole) => {
    paired += (whole.match(sentinelLineRegexG(slug)) || []).length;
    return whole;
  });
  return total - paired;
}
function blockRegex(slug) {
  return new RegExp(blockBody(escapeRe(slug)));
}
function blockRegexG(slug) {
  return new RegExp(blockBody(escapeRe(slug)), 'g');
}

function renderBlock(slug, version, body) {
  return `<!-- ${slug}:begin ${version} -->\n${body}\n<!-- ${slug}:end -->`;
}

function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

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
  if (existsSync(p))
    try {
      unlinkSync(p);
    } catch {
      /* best-effort */
    }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Parse <cwd>/CLAUDE.md for our slug-scoped managed block.
 * @returns {{ exists: boolean, version: string|null, body: string|null, raw: string }}
 */
export function readBlock(cwd, slug) {
  return readBlockAt(claudeMdPath(cwd), slug);
}

/**
 * readBlock for any instructions file — CLAUDE.md, or the CLAUDE.local.md that auto-adopt
 * writes (lib/local-steering.mjs). One parser, so both files get the same CRLF, orphan and
 * duplicate handling.
 * @param {string} p absolute path of the file
 * @param {string} slug
 * @returns {{ exists: boolean, version: string|null, body: string|null, raw: string }}
 */
export function readBlockAt(p, slug) {
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
 * Is `relPath` — an UNTRACKED path as `git status --porcelain` prints it, relative to `cwd` —
 * nothing but this plugin's own adoption output? True for a CLAUDE.md that holds only our
 * managed block, for our detail doc (checked by its managed-by marker, so a user's file of
 * the same name is not ours) or state sidecar, and for a `.claude/` directory holding only
 * those. The startup dashboard and the handoff's tree state count uncommitted files to
 * describe the USER's work; counting what the first SessionStart itself wrote told the model
 * "2 uncommitted file(s)" on a clean repo (docs/audits/20260929-sandbox-usage-eval.md).
 * Any read failure answers false: counting a file is the safe mistake.
 * @param {string} cwd
 * @param {string} relPath
 * @param {string} slug
 * @returns {boolean}
 */
export function isOwnAdoptionArtifact(cwd, relPath, slug) {
  try {
    const rel = String(relPath).replace(/\/+$/, '');
    if (rel === 'CLAUDE.md' || rel === 'CLAUDE.local.md') {
      const blk = readBlockAt(join(cwd, rel), slug);
      return blk.body !== null && blk.raw.replace(blockRegexG(slug), '').trim() === '';
    }
    const docName = basename(detailDocPath(cwd, slug));
    const stateName = basename(stateFilePath(cwd, slug));
    const ownFile = (name) =>
      name === stateName ||
      (name === docName &&
        readFileSync(join(dotClaudeDir(cwd), name), 'utf8').startsWith(managedByMarker(slug)));
    if (rel === '.claude') {
      const names = readdirSync(dotClaudeDir(cwd));
      return names.length > 0 && names.every(ownFile);
    }
    if (rel.startsWith('.claude/') && !rel.slice(8).includes('/')) return ownFile(rel.slice(8));
  } catch {
    /* unreadable → not provably ours */
  }
  return false;
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
  const blk = readBlock(cwd, slug);
  return blk.body !== null || existsSync(detailDocPath(cwd, slug)) || existsSync(stateFilePath(cwd, slug));
}

// An unpaired sentinel is deliberately NOT in the list above (pre-ship review P2-3). A first
// cut added it, reasoning that the sweep should see what the pair regex cannot. But
// orphanSentinelCount counts sentinel-shaped TEXT, and a project the plugin never touched can
// mention the marker in prose — documenting it, pasting half an example, a changelog line.
// That one mention let `unadopt --all` into a stranger's project, where removeManaged
// unconditionally deletes the detail doc and state sidecar and rmdir's an empty `.claude/`,
// then printed "remove those lines by hand" at the user's own paragraph — and never
// converged, because the mention is still there on the next sweep.
//
// The three entries above are all things the PLUGIN WROTE; a sentinel in prose is not. And
// the sweep gains nothing by entering: removeManaged cannot clean an orphan anyway, by
// design. The orphan is reported by removeManaged when unadopt genuinely runs — which is the
// real failure case, where the doc and sidecar are still present and do bring it in.

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
  try {
    cur = readFileSync(dp, 'utf8');
  } catch {
    return true;
  }
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
  const { action } = writeBlockAt(claudeMdPath(cwd), { slug, version, block });

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
 * Insert-or-replace our block in one instructions file (created if absent), preserving
 * everything outside the slug-scoped sentinels. The CLAUDE.md half of writeManaged, and all
 * of what lib/local-steering.mjs writes into CLAUDE.local.md.
 * @param {string} p absolute path of the file
 * @returns {{action: 'created'|'updated'|'unchanged'}}
 */
export function writeBlockAt(p, { slug, version, block }) {
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
  return { action };
}

/**
 * Remove our managed block from CLAUDE.md (preserving all other content) and
 * delete the detail doc + state sidecar. Best-effort removes an emptied
 * .claude/ directory.
 *
 * THREE outcomes, not two — the same rule lib/db-unusable.mjs states about backups: "there
 * is nothing to do" and "I could not finish" must not print in the same voice, because a
 * green-sounding line ends the reader's search. `absent` used to cover both: with one
 * sentinel line missing, the pair regex matched nothing, so this returned 'absent' — while
 * having already deleted the detail doc and the state sidecar and left ~1.3 KB of managed
 * steering text in the user's CLAUDE.md, which it is then loaded from on every session.
 * `partial` is that case, and `residue` names what is left so the caller can say so.
 *
 * Deliberately does NOT delete an orphaned sentinel's body: where it ends is unknowable
 * (that is the defect, not a detail), and guessing a span in a file we do not own is how the
 * adopt side came to delete a user's runbook. Report, do not repair.
 *
 * @returns {{action: 'removed'|'partial'|'absent', residue?: string}}
 */
export function removeManaged(cwd, slug) {
  const { action, orphans } = removeBlockAt(claudeMdPath(cwd), slug);
  // Captured BEFORE the deletions below, because they are what it asks about: is there any
  // evidence the plugin ever wrote in this project? An unpaired sentinel is NOT such
  // evidence — it is text, and a project that merely documents the marker in prose has one
  // (pre-ship review P2-3). Reporting residue there means telling a stranger to delete their
  // own paragraph, on a project this tool has never touched.
  const dp = detailDocPath(cwd, slug);
  const wasOurs = action === 'removed' || existsSync(dp) || existsSync(stateFilePath(cwd, slug));
  if (existsSync(dp))
    try {
      unlinkSync(dp);
    } catch {
      /* best-effort */
    }
  clearState(cwd, slug);
  // Drop an emptied .claude/ so unadopt leaves no trace (skips if it holds
  // anything else — e.g. settings.local.json).
  try {
    const dir = dotClaudeDir(cwd);
    if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {
    /* best-effort */
  }
  // `action` answers ONE question — what happened to the block — and `residue` is an
  // independent fact that rides alongside it. A first cut let an orphan override 'removed'
  // too, on the reasoning that both are "unfinished". Pre-ship review P2-1: unadoptAll's
  // else-branch prints "cleaned partial residue (detail doc/state, no block)" and counts
  // `partial++`, so a sweep that DID remove a block reported "no block" and tallied zero
  // removals. Two facts, two fields.
  const residue = orphans > 0 && wasOurs ? orphanResidueNote(orphans, slug, claudeMdPath(cwd)) : null;
  if (action === 'removed') return residue ? { action, residue } : { action };
  if (residue) return { action: 'partial', residue };
  return { action };
}

/**
 * The residue line for unpaired sentinels left in `p` after a removal.
 * @returns {string}
 */
export function orphanResidueNote(orphans, slug, p) {
  return `${orphans} unpaired \`${slug}\` sentinel line(s) remain in ${p} — the block they opened has no matching end marker, so its extent cannot be determined safely. Remove those lines and the text they wrap by hand.`;
}

/**
 * Remove every well-formed block of `slug` from one instructions file, keeping all other
 * text; a file left holding only whitespace is deleted (a symlink is emptied through the
 * link instead). The CLAUDE.md half of removeManaged, and what lib/local-steering.mjs uses
 * for CLAUDE.local.md.
 * @param {string} p absolute path of the file
 * @returns {{action: 'removed'|'absent', orphans: number}}
 */
export function removeBlockAt(p, slug) {
  let action = 'absent';
  let orphans = 0;
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
      //
      // UNLESS the path is a SYMLINK (audit R7 P2-2). writeManaged reaches this file
      // through atomicWriteFileSync, which lstats and writes THROUGH a link on purpose —
      // that is the audit 2026-09-02 P0-5 fix, for CLAUDE.md symlinked into a dotfiles
      // repo (chezmoi/stow/yadm). Unlinking here would delete the LINK and orphan the
      // target, i.e. undo that invariant on the removal side. Empty it through the link
      // instead: a 0-byte file is the lesser evil against silently rearranging the
      // user's dotfiles. Only a regular file we can prove is ours to remove gets removed.
      let isLink = false;
      try {
        isLink = lstatSync(p).isSymbolicLink();
      } catch {
        /* raced away → fall through to the unlink attempt, which will no-op */
      }
      if (raw.trim() === '' && !isLink) {
        try {
          unlinkSync(p);
        } catch {
          atomicWrite(p, raw);
        }
      } else {
        atomicWrite(p, raw);
      }
    }
    // Counted on what is left AFTER the loop, so a healthy file (every sentinel consumed by
    // a matched pair) reports zero and only a genuinely unpaired line survives the count.
    orphans = orphanSentinelCount(raw, slug);
  }
  return { action, orphans };
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
