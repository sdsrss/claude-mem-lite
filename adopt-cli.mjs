// CLAUDE.md-steering plan (v3.13): CLI handlers for
//   claude-mem-lite adopt   [--all] [--force] [--dry-run] [--status] [--disable|--enable]
//   claude-mem-lite unadopt [--all] [--force] [--dry-run] [--status]
//
// adopt   = write the managed block into <cwd>/CLAUDE.md + drop
//           <cwd>/.claude/plugin_claude_mem_lite.md, and migrate this project's
//           legacy memory-dir sentinel away.
// unadopt = remove the CLAUDE.md block + detail doc (and clean any legacy residue).
//
// The project path is needed to write CLAUDE.md, but the per-project memdir slug
// (~/.claude/projects/<encoded>/) is a LOSSY encoding of the real cwd — it cannot
// be decoded back to a filesystem path. So `--all` cannot adopt arbitrary projects;
// it is redefined as a legacy-cleanup sweep (strip old memory-dir sentinels across
// every memdir). New-scheme adoption happens per-project on SessionStart (cwd known).

import { existsSync, readdirSync, statSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join, isAbsolute } from 'path';
import {
  memdirPath,
  removePluginSection,
  removePluginDoc,
  isAdopted as memdirIsAdopted,
  hasPluginState,
} from './memdir.mjs';
import {
  writeManaged,
  removeManaged,
  isAdopted as claudeMdIsAdopted,
  hasResidue as claudeMdHasResidue,
  needsRefresh,
  migrateLegacyMemoryDir,
  hasLegacyMemdirSentinel,
  claudeMdPath,
  detailDocPath,
} from './claudemd.mjs';
import { PLUGIN_SLUG, CURRENT_SENTINEL_VERSION, buildClaudeMdBlock, getDetailDoc } from './adopt-content.mjs';

function log(msg) {
  console.log(msg);
}

function detectCwd() {
  return process.env.CLAUDE_PROJECT_DIR || process.env.PWD || process.cwd();
}

function projectsRoot() {
  return join(homedir(), '.claude', 'projects');
}

function listAllMemdirs() {
  const base = projectsRoot();
  if (!existsSync(base)) return [];
  const out = [];
  for (const name of readdirSync(base)) {
    const memdir = join(base, name, 'memory');
    try {
      if (existsSync(memdir) && statSync(memdir).isDirectory()) {
        out.push({ projectSlug: name, memdir });
      }
    } catch {
      /* ignore entries we can't stat */
    }
  }
  return out;
}

function claudeConfigPath() {
  return join(homedir(), '.claude.json');
}

// Real adopted-project paths come from Claude Code's own ~/.claude.json `projects`
// map (keys are absolute cwds Claude Code has opened). The memdir slug under
// ~/.claude/projects/ is a LOSSY encoding that can't be decoded back to a path,
// so this is the only source that lets `unadopt --all` reach scattered CLAUDE.md
// managed blocks. Filtered to absolute, still-existing dirs; claudeMdIsAdopted()
// then gates which actually carry our block. Caveat: a project Claude Code never
// recorded is invisible here and needs a per-project `unadopt`.
function listKnownProjectDirs() {
  const p = claudeConfigPath();
  if (!existsSync(p)) return [];
  try {
    const cfg = JSON.parse(readFileSync(p, 'utf8'));
    const projects = cfg && cfg.projects && typeof cfg.projects === 'object' ? Object.keys(cfg.projects) : [];
    return projects.filter((d) => typeof d === 'string' && isAbsolute(d) && existsSync(d));
  } catch {
    return [];
  }
}

function hasFlag(args, flag) {
  return Array.isArray(args) && args.includes(flag);
}

// ─── Per-project auto-adopt opt-out sentinel ─────────────────────────────────
// `<memdir>/.mem-no-auto-adopt` is the durable, project-scoped escape hatch.
// Survives marker deletion, sentinel removal, and plugin reinstalls — that's
// the point: "user said no for this project" should not be reversible by
// `rm ~/.claude-mem-lite/runtime/.auto-adopt-*`. Managed via
// `claude-mem-lite adopt --disable` / `--enable`. silentAutoAdopt checks it
// at entry and skips WITHOUT writing the runtime marker, so toggling
// `--enable` re-arms auto-adopt on the next SessionStart. Kept in the memdir
// (not the project tree) so it survives `unadopt` cleaning out .claude/.
const DISABLE_SENTINEL_BASENAME = '.mem-no-auto-adopt';

export function disableSentinelPath(memdir) {
  return join(memdir, DISABLE_SENTINEL_BASENAME);
}

export function isAutoAdoptDisabled(memdir) {
  return existsSync(disableSentinelPath(memdir));
}

/**
 * cmdAdopt — write the CLAUDE.md managed block + detail doc for the current
 * project, and migrate its legacy memory-dir sentinel away.
 *
 * `--all` does NOT adopt every project (their real paths are unrecoverable from
 * the lossy memdir slug) — it sweeps the legacy memory-dir cleanup across all
 * memdirs. `--status`/`--disable`/`--enable` as before.
 */
export function cmdAdopt(args = []) {
  if (hasFlag(args, '--status')) return statusAll();
  if (hasFlag(args, '--disable')) return cmdDisable(args);
  if (hasFlag(args, '--enable')) return cmdEnable(args);
  if (hasFlag(args, '--all')) return migrateAll(args);

  const force = hasFlag(args, '--force');
  const dryRun = hasFlag(args, '--dry-run');
  const cwd = detectCwd();

  adoptOne(cwd, { force, dryRun });
}

function adoptOne(cwd, { force, dryRun }) {
  const block = buildClaudeMdBlock();
  const doc = getDetailDoc();
  const version = CURRENT_SENTINEL_VERSION;

  if (dryRun) {
    log(`[adopt --dry-run] ${cwd}`);
    log(`  CLAUDE.md block:  ${claudeMdPath(cwd)} (${block.length} chars, ${version})`);
    log(`  detail doc:       ${detailDocPath(cwd, PLUGIN_SLUG)} (${doc.length} chars)`);
    if (hasLegacyMemdirSentinel(cwd, PLUGIN_SLUG)) {
      log(`  legacy migrate:   would strip memory-dir sentinel @ ${memdirPath(cwd)}`);
    }
    return { action: 'dry-run' };
  }

  try {
    const mig = migrateLegacyMemoryDir(cwd, PLUGIN_SLUG, { force });
    const r = writeManaged(cwd, { slug: PLUGIN_SLUG, version, block, doc });
    const migNote = mig.action === 'removed' ? ' (+migrated legacy memdir)' : '';
    log(`[adopt] ${cwd} → ${r.action}${migNote}`);
    return r;
  } catch (e) {
    log(`[adopt] ${cwd} → error: ${e.message}`);
    process.exitCode = 1;
    return { action: 'failed' };
  }
}

/**
 * migrateAll — `claude-mem-lite adopt --all`: legacy-cleanup sweep. Strips the
 * old memory-dir sentinel + detail doc from every memdir. Does NOT write any
 * CLAUDE.md block (target paths are unrecoverable) — that happens per-project on
 * the next SessionStart. Respects the foreign-content guard unless --force.
 */
function migrateAll(args) {
  const force = hasFlag(args, '--force');
  const dryRun = hasFlag(args, '--dry-run');
  const dirs = listAllMemdirs();
  if (dirs.length === 0) {
    log('[adopt --all] no memdirs found');
    return;
  }

  let removed = 0,
    absent = 0,
    skipped = 0;
  for (const { projectSlug, memdir } of dirs) {
    if (dryRun) {
      const has = memdirIsAdopted(memdir, PLUGIN_SLUG);
      const action = !has
        ? 'absent'
        : hasPluginState(memdir, PLUGIN_SLUG) || force
          ? 'would-remove'
          : 'would-skip-foreign';
      log(`[adopt --all --dry-run] ${projectSlug} → ${action}`);
      if (action === 'would-remove') removed++;
      else if (action === 'would-skip-foreign') skipped++;
      else absent++;
      continue;
    }
    const r = removePluginSection(memdir, PLUGIN_SLUG, { force });
    if (r.action === 'removed') {
      removePluginDoc(memdir, PLUGIN_SLUG);
      removed++;
    } else if (r.action === 'skipped-foreign') skipped++;
    else absent++;
  }
  log('');
  log(
    `[adopt --all] legacy memory-dir cleanup over ${dirs.length} project(s): ${removed} cleaned, ${skipped} skipped-foreign, ${absent} none.`,
  );
  log(
    "[adopt --all] CLAUDE.md adoption is per-project — it runs automatically on each project's next SessionStart.",
  );
}

/**
 * silentAutoAdopt — SessionStart idempotent sync (migration vehicle).
 *
 * Called every plugin-mode SessionStart (NOT gated by the one-shot marker, so
 * existing users whose marker predates v3.13 still migrate). Order:
 *   1. respect per-project `.mem-no-auto-adopt` opt-out → skip.
 *   2. migrate legacy memory-dir sentinel away (idempotent; no-op once gone).
 *   3. adopt the CLAUDE.md scheme if absent; else refresh if shipped content
 *      drifted (unless CLAUDE_MEM_NO_TEMPLATE_REFRESH=1).
 * Silent: never logs, never throws. Returns { ok, action, reason } for debugLog.
 */
export function silentAutoAdopt({ cwd, markerDir, markerKey }) {
  const memdir = memdirPath(cwd);
  try {
    if (isAutoAdoptDisabled(memdir)) {
      return { ok: true, action: 'disabled', reason: 'disabled-by-sentinel' };
    }
    migrateLegacyMemoryDir(cwd, PLUGIN_SLUG);

    const block = buildClaudeMdBlock();
    const doc = getDetailDoc();
    const version = CURRENT_SENTINEL_VERSION;

    let action = 'already-adopted';
    if (!claudeMdIsAdopted(cwd, PLUGIN_SLUG)) {
      writeManaged(cwd, { slug: PLUGIN_SLUG, version, block, doc });
      action = 'adopted';
    } else if (
      process.env.CLAUDE_MEM_NO_TEMPLATE_REFRESH !== '1' &&
      needsRefresh(cwd, { slug: PLUGIN_SLUG, version, block, doc })
    ) {
      writeManaged(cwd, { slug: PLUGIN_SLUG, version, block, doc });
      action = 'refreshed';
    }
    if (markerDir && markerKey) writeMarker(markerDir, markerKey);
    return { ok: true, action };
  } catch (e) {
    try {
      if (markerDir && markerKey) writeMarker(markerDir, markerKey);
    } catch {
      /* best-effort */
    }
    return { ok: false, action: 'skipped', reason: 'error', err: e };
  }
}

function writeMarker(markerDir, markerKey) {
  if (!existsSync(markerDir)) mkdirSync(markerDir, { recursive: true });
  const path = join(markerDir, `.auto-adopt-${markerKey}`);
  writeFileSync(path, JSON.stringify({ firstAttemptAt: new Date().toISOString() }));
}

export function hasAutoAdoptMarker(markerDir, markerKey) {
  return existsSync(join(markerDir, `.auto-adopt-${markerKey}`));
}

/**
 * cmdDisable — `claude-mem-lite adopt --disable [--all]`.
 * Writes `<memdir>/.mem-no-auto-adopt` so SessionStart auto-adopt skips this
 * project permanently. Does NOT remove an existing block — pair with `unadopt`.
 */
function cmdDisable(args) {
  const all = hasFlag(args, '--all');
  const targets = all ? listAllMemdirs().map((m) => m.memdir) : [memdirPath(detectCwd())];

  if (targets.length === 0) {
    log('[adopt --disable] no memdirs found');
    return;
  }

  let disabled = 0,
    already = 0;
  for (const memdir of targets) {
    if (!existsSync(memdir)) mkdirSync(memdir, { recursive: true });
    const path = disableSentinelPath(memdir);
    if (existsSync(path)) {
      log(`[adopt --disable] ${memdir} → already-disabled`);
      already++;
      continue;
    }
    writeFileSync(path, JSON.stringify({ disabledAt: new Date().toISOString() }) + '\n');
    log(`[adopt --disable] ${memdir} → disabled`);
    disabled++;
  }
  log('');
  log(
    `[adopt --disable] ${targets.length} target(s): ${disabled} newly disabled, ${already} already disabled`,
  );
}

/**
 * cmdEnable — `claude-mem-lite adopt --enable [--all]`. Removes the
 * `.mem-no-auto-adopt` sentinel so the next SessionStart can auto-adopt again.
 */
function cmdEnable(args) {
  const all = hasFlag(args, '--all');
  const targets = all ? listAllMemdirs().map((m) => m.memdir) : [memdirPath(detectCwd())];

  if (targets.length === 0) {
    log('[adopt --enable] no memdirs found');
    return;
  }

  let enabled = 0,
    absent = 0;
  for (const memdir of targets) {
    const path = disableSentinelPath(memdir);
    if (!existsSync(path)) {
      log(`[adopt --enable] ${memdir} → absent`);
      absent++;
      continue;
    }
    try {
      unlinkSync(path);
    } catch {
      /* best-effort */
    }
    log(`[adopt --enable] ${memdir} → enabled`);
    enabled++;
  }
  log('');
  log(`[adopt --enable] ${targets.length} target(s): ${enabled} re-enabled, ${absent} not-disabled`);
}

/**
 * statusAll — report the current project's new-scheme adoption, plus a sweep of
 * how many memdirs still carry the legacy sentinel (i.e. await migration).
 */
function statusAll() {
  const cwd = detectCwd();
  const adoptedHere = claudeMdIsAdopted(cwd, PLUGIN_SLUG);
  log('[adopt --status] current project:');
  log(`  cwd:        ${cwd}`);
  log(`  CLAUDE.md:  ${adoptedHere ? `✓ adopted (${CURRENT_SENTINEL_VERSION})` : '✗ not adopted'}`);
  if (hasLegacyMemdirSentinel(cwd, PLUGIN_SLUG)) {
    log('  legacy:     ⚠ memory-dir sentinel still present (migrates on next SessionStart, or run `adopt`)');
  }

  const dirs = listAllMemdirs();
  let legacy = 0,
    disabled = 0;
  for (const { memdir } of dirs) {
    if (memdirIsAdopted(memdir, PLUGIN_SLUG)) legacy++;
    if (isAutoAdoptDisabled(memdir)) disabled++;
  }
  log('');
  log(
    `[adopt --status] scanned ${dirs.length} memdir(s): ${legacy} with legacy sentinel (await migration), ${disabled} auto-adopt-disabled.`,
  );
  if (legacy > 0)
    log('[adopt --status] run `claude-mem-lite adopt --all` to sweep legacy memory-dir sentinels now.');

  const known = listKnownProjectDirs();
  let adoptedCount = 0;
  for (const dir of known) if (claudeMdHasResidue(dir, PLUGIN_SLUG)) adoptedCount++;
  log(
    `[adopt --status] known projects (~/.claude.json): ${known.length} scanned, ${adoptedCount} with a CLAUDE.md managed block or partial residue (detail doc/state).`,
  );
  if (adoptedCount > 0)
    log('[adopt --status] run `claude-mem-lite unadopt --all` to remove every CLAUDE.md block.');

  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ? 'set' : 'unset';
  const noAutoAdopt = process.env.MEM_NO_AUTO_ADOPT === '1' ? '1 (opt-out)' : 'unset';
  log('');
  log('Auto-adopt gates (next SessionStart fires only if these pass):');
  log(
    `  CLAUDE_PLUGIN_ROOT  = ${pluginRoot}  (any install path is consent; gate is the per-project opt-out below)`,
  );
  log(`  MEM_NO_AUTO_ADOPT   = ${noAutoAdopt}  (global escape hatch)`);
  log('Per-project opt-out: `claude-mem-lite adopt --disable` (run --enable to re-arm).');
}

/**
 * cmdUnadopt — remove the CLAUDE.md managed block + detail doc for the current
 * project, and clean any legacy memory-dir residue. `--all` sweeps the legacy
 * memory-dir cleanup across every memdir (CLAUDE.md blocks for other projects
 * can't be located from the lossy slug). Idempotent: exit code stays 0.
 */
/**
 * unadoptAll — `claude-mem-lite unadopt --all`. Removes the CLAUDE.md managed
 * block + detail doc from EVERY adopted project Claude Code knows about (real
 * paths from ~/.claude.json `projects`), then sweeps the legacy memory-dir
 * residue across all memdirs. removeManaged is slug-scoped, so user content and
 * other plugins' blocks are never touched. Honors --dry-run / --force.
 *
 * Unlike `adopt --all` (still a legacy-only sweep — adopting arbitrary projects
 * is unsafe), unadopt is purely subtractive, so reaching every known project is
 * both safe and what the uninstall hint promises.
 */
function unadoptAll(args) {
  const force = hasFlag(args, '--force');
  const dryRun = hasFlag(args, '--dry-run');

  // 1. New scheme: scrub CLAUDE.md managed blocks across known project paths.
  const projectDirs = listKnownProjectDirs();
  let blocks = 0,
    partial = 0;
  for (const dir of projectDirs) {
    // hasResidue, not isAdopted: the sweep must also catch PARTIAL residue
    // (block without detail doc, or an orphaned doc/state sidecar) —
    // isAdopted's block-AND-doc gate skipped those projects forever.
    if (!claudeMdHasResidue(dir, PLUGIN_SLUG)) continue;
    if (dryRun) {
      log(
        `[unadopt --all --dry-run] ${dir} → would-remove plugin residue (CLAUDE.md block and/or detail doc/state)`,
      );
      blocks++;
      continue;
    }
    const r = removeManaged(dir, PLUGIN_SLUG);
    if (r.action === 'removed') {
      log(`[unadopt --all] ${dir} → removed`);
      blocks++;
    } else {
      log(`[unadopt --all] ${dir} → cleaned partial residue (detail doc/state, no block)`);
      partial++;
    }
  }

  // 2. Legacy memory-dir cleanup across every memdir (foreign-content guarded).
  const dirs = listAllMemdirs();
  let legacy = 0;
  for (const { memdir } of dirs) {
    if (dryRun) {
      if (memdirIsAdopted(memdir, PLUGIN_SLUG) && (hasPluginState(memdir, PLUGIN_SLUG) || force)) legacy++;
      continue;
    }
    const r = removePluginSection(memdir, PLUGIN_SLUG, { force });
    if (r.action === 'removed') {
      removePluginDoc(memdir, PLUGIN_SLUG);
      legacy++;
    }
  }

  log('');
  const partialNote = partial > 0 ? ` (+${partial} partial-residue cleanup(s))` : '';
  log(
    `[unadopt --all] ${dryRun ? 'would remove' : 'removed'} ${blocks} CLAUDE.md block(s)${partialNote} across ${projectDirs.length} known project(s); ${legacy} legacy memory-dir sentinel(s) ${dryRun ? 'pending' : 'cleaned'}.`,
  );
  if (projectDirs.length === 0) {
    log(
      '[unadopt --all] no known projects found in ~/.claude.json — if a project was adopted but never opened in Claude Code, run `claude-mem-lite unadopt` from inside it.',
    );
  }
}

export function cmdUnadopt(args = []) {
  if (hasFlag(args, '--status')) return statusAll();

  const all = hasFlag(args, '--all');
  const dryRun = hasFlag(args, '--dry-run');
  const force = hasFlag(args, '--force');

  if (all) return unadoptAll(args);

  const cwd = detectCwd();
  if (dryRun) {
    const blockState = claudeMdHasResidue(cwd, PLUGIN_SLUG)
      ? 'would-remove CLAUDE.md block + detail doc'
      : 'no CLAUDE.md block';
    const legacy = hasLegacyMemdirSentinel(cwd, PLUGIN_SLUG)
      ? 'would-clean legacy memory-dir sentinel'
      : 'no legacy residue';
    log(`[unadopt --dry-run] ${cwd}`);
    log(`  ${blockState}`);
    log(`  ${legacy}`);
    return;
  }

  const r = removeManaged(cwd, PLUGIN_SLUG);
  const mig = migrateLegacyMemoryDir(cwd, PLUGIN_SLUG, { force });
  const migNote = mig.action === 'removed' ? ' (+cleaned legacy memdir)' : '';
  log(`[unadopt] ${cwd} → ${r.action}${migNote}`);
}
